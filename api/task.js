import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);

// 环境变量
const ZHIPU_KEY = process.env.ZHIPU_API_KEY;
const DASHSCOPE_KEY = process.env.ALI_DASHSCOPE_KEY;
const VOLC_AK = process.env.VOLC_ACCESSKEY;
const VOLC_SK = process.env.VOLC_SECRETKEY;
const BGM_SOURCE = process.env.BGM_URL;

// 任务缓存
let taskPool = new Map();

// 智谱统一请求函数
async function zhipuChat(prompt) {
  const res = await axios.post("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
    model: "glm-4-flash",
    messages: [{ role: "user", content: prompt }]
  }, { headers: { Authorization: `Bearer ${ZHIPU_KEY}` } })
  return res.data.choices[0].message.content;
}

export default async function handler(req, res) {
  const { method, query, body } = req;
  // 查询任务
  if (method === "GET") {
    const task = taskPool.get(query.id) || {};
    return res.json(task);
  }
  // 新建任务
  if (method === "POST") {
    const { content, taskName } = body;
    const taskId = uuidv4().slice(0, 12);
    const taskData = {
      id: taskId,
      name: taskName,
      content: "",
      script: "",
      step: 0,
      status: "排队执行",
      shots: [],
      imgs: [],
      audios: [],
      videoUrl: "",
      bgmEnable: true
    };
    taskPool.set(taskId, taskData);
    runAllPipeline(taskId, content).catch(err => {
      let t = taskPool.get(taskId);
      t.status = "异常：" + err.message;
      taskPool.set(taskId, t);
    })
    return res.json({ taskId });
  }
  return res.status(404).json({ msg: "接口不存在" });
}

// 7步流水线：智谱LLM + 万相生图 + 火山TTS + BGM混音合成
async function runAllPipeline(taskId, rawText) {
  let task = taskPool.get(taskId);
  const tmpDir = os.tmpdir();

  // Step1 文案预审清洗【智谱】
  task.step = 1;
  const cleanTxt = await zhipuChat(`过滤违规、修正语病，只返回优化后的原文，不要多余话：${rawText}`);
  task.content = cleanTxt;
  taskPool.set(taskId, task);

  // Step2 改写15~20分钟纪录片口播【智谱】
  task.step = 2;
  const script = await zhipuChat(`把下面文案改成适合15-20分钟纪录片旁白，口语流畅自然，只输出正文：${cleanTxt}`);
  task.script = script;
  taskPool.set(taskId, task);

  // Step3 分镜拆分JSON【智谱】
  task.step = 3;
  const splitPrompt = `拆分影视分镜，严格只返回JSON数组，格式[{"text":"旁白台词","scene":"画面描述","duration":5}]，无任何多余文字：${script}`;
  const shots = JSON.parse(await zhipuChat(splitPrompt));
  task.shots = shots;
  task.shotNum = shots.length;
  taskPool.set(taskId, task);

  // Step4 生成万相绘图Prompt
  task.step = 4;
  const promptList = shots.map(item => `电影级纪录片画质，8K写实，光影细腻，${item.scene}`);
  task.promptList = promptList;
  taskPool.set(taskId, task);

  // Step5 通义万相批量配图（保留不变）
  task.step = 5;
  let imgUrlList = [];
  for (let p of promptList) {
    const imgResp = await axios.post("https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis",
      { model: "wanx-v1", input: { prompt: p } },
      { headers: { Authorization: `Bearer ${DASHSCOPE_KEY}` } }
    )
    imgUrlList.push(imgResp.data.output.results[0].url);
  }
  task.imgs = imgUrlList;
  taskPool.set(taskId, task);

  // Step6 火山TTS真人配音（保留不变）
  task.step = 6;
  let audioPathArr = [];
  for (let idx = 0; idx < shots.length; idx++) {
    const savePath = path.join(tmpDir, `${taskId}_voice_${idx}.mp3`);
    const ttsParam = {
      app: { appid: "auto", token: "auto" },
      req: { text: shots[idx].text, speaker: "zh_female_documentary", audio_format: "mp3" }
    }
    const ttsRet = await axios.post(`https://openspeech.bytedance.com/api/v1/tts`, ttsParam, {
      headers: { Authorization: `Bearer ${VOLC_ACCESSKEY};${VOLC_SECRETKEY}` }
    })
    fs.writeFileSync(savePath, Buffer.from(ttsRet.data.data, "base64"));
    audioPathArr.push(savePath);
  }
  task.audios = audioPathArr;
  taskPool.set(taskId, task);

  // Step7 FFmpeg合成视频+BGM混音（全保留）
  task.step = 7;
  const bgmPath = path.join(tmpDir, `${taskId}_bgm.mp3`);
  const bgmData = await axios({ url: BGM_SOURCE, responseType: "arraybuffer" });
  fs.writeFileSync(bgmPath, bgmData.data);

  let imgLocalList = [];
  let concatTxtPath = path.join(tmpDir, `${taskId}_concat.txt`);
  let concatTxtContent = "";
  for (let i = 0; i < imgUrlList.length; i++) {
    const localImg = path.join(tmpDir, `${taskId}_img_${i}.jpg`);
    const imgBin = await axios({ url: imgUrlList[i], responseType: "arraybuffer" });
    fs.writeFileSync(localImg, imgBin.data);
    imgLocalList.push(localImg);
    concatTxtContent += `file '${localImg}'\nduration ${shots[i].duration}\n`;
  }
  fs.writeFileSync(concatTxtPath, concatTxtContent);

  const rawVideo = path.join(tmpDir, `${taskId}_raw.mp4`);
  await execAsync(`ffmpeg -y -f concat -safe 0 -i "${concatTxtPath}" -c:v libx264 -r 24 -pix_fmt yuv420p "${rawVideo}"`);

  const allVoice = path.join(tmpDir, `${taskId}_allvoice.mp3`);
  const voiceInputStr = audioPathArr.map(p => `-i "${p}"`).join(" ");
  await execAsync(`ffmpeg -y ${voiceInputStr} -filter_complex concat=n=${audioPathArr.length}:v=0:a=1 "${allVoice}"`);

  const mixAudio = path.join(tmpDir, `${taskId}_mix_audio.mp3`);
  await execAsync(`ffmpeg -y -i "${allVoice}" -i "${bgmPath}" -filter_complex "[1:a]volume=0.3[bgm];[0:a][bgm]amix=inputs=2:duration=shortest" "${mixAudio}"`);

  const finalMp4 = path.join(tmpDir, `${taskId}_final.mp4`);
  await execAsync(`ffmpeg -y -i "${rawVideo}" -i "${mixAudio}" -c:v copy -c:a aac "${finalMp4}"`);

  task.videoUrl = "#";
  task.downloadTip = "生成完成｜本地MP4路径：" + finalMp4;
  task.status = "全部生成完成，已自动叠加背景音乐";
  taskPool.set(taskId, task);
}
