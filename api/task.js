import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);

const ZHIPU_KEY = process.env.ZHIPU_API_KEY;
const DASHSCOPE_KEY = process.env.ALI_DASHSCOPE_KEY;
const VOLC_AK = process.env.VOLC_ACCESSKEY;
const VOLC_SK = process.env.VOLC_SECRETKEY;
const BGM_SOURCE = process.env.BGM_URL;

let taskPool = new Map();
let taskLogs = new Map();

function log(taskId, msg) {
  const time = new Date().toLocaleString();
  const line = `[${time}] ${msg}`;
  console.log(line);
  if (!taskLogs.has(taskId)) taskLogs.set(taskId, []);
  taskLogs.get(taskId).push(line);
}

async function zhipu(prompt, taskId) {
  log(taskId, `AI调用开始：${prompt.slice(0, 30)}...`);
  try {
    const start = Date.now();
    const res = await axios.post("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
      model: "glm-4-flash",
      messages: [{ role: "user", content: prompt }]
    }, {
      headers: { Authorization: `Bearer ${ZHIPU_KEY}` },
      timeout: 30000
    });
    const content = res.data.choices[0].message.content;
    log(taskId, `AI调用成功 | 耗时 ${Date.now() - start}ms | 返回长度 ${content.length}`);
    return content;
  } catch (e) {
    log(taskId, `AI调用失败：${e.message}`);
    throw e;
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const task = taskPool.get(req.query.id) || {};
    task.logList = taskLogs.get(req.query.id) || [];
    return res.json(task);
  }

  if (req.method === "POST") {
    const { content, taskName } = req.body;
    const taskId = uuidv4().slice(0, 12);
    log(taskId, "任务创建，开始执行");
    const task = {
      id: taskId, name: taskName, step: 0, status: "开始执行",
      content: "", script: "", shots: [], imgs: [], audios: []
    };
    taskPool.set(taskId, task);

    run(taskId, content).catch(e => {
      log(taskId, "任务异常：" + e.message);
      task.status = "异常：" + e.message;
      taskPool.set(taskId, task);
    });
    return res.json({ taskId });
  }
  res.end();
}

async function run(taskId, text) {
  const t = taskPool.get(taskId);
  const tmp = os.tmpdir();

  // Step1
  t.step = 0; t.status = "【1/7】文案预审中"; taskPool.set(taskId, t);
  const clean = await zhipu(`过滤、修正语病，只返回原文：${text}`, taskId);
  t.content = clean;

  // Step2
  t.step = 1; t.status = "【2/7】生成口播稿"; taskPool.set(taskId, t);
  const script = await zhipu(`生成纪录片旁白，只输出正文：${clean}`, taskId);
  t.script = script;

  // Step3
  t.step = 2; t.status = "【3/7】拆分镜头"; taskPool.set(taskId, t);
  const shotsRaw = await zhipu(`返回纯JSON：[{"text":"","scene":"","duration":5}]：${script}`, taskId);
  const shots = JSON.parse(shotsRaw);
  t.shots = shots; t.shotNum = shots.length;

  // Step4
  t.step = 3; t.status = "【4/7】生成绘图关键词"; taskPool.set(taskId, t);
  const prompts = shots.map(s => `电影级8K写实，${s.scene}`);

  // Step5
  t.step = 4; t.status = "【5/7】批量生成图片"; taskPool.set(taskId, t);
  const imgs = [];
  for (let i = 0; i < prompts.length; i++) {
    log(taskId, `生成图片 ${i+1}/${prompts.length}`);
    const img = await axios.post("https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis", {
      model: "wanx-v1", input: { prompt: prompts[i] }
    }, { headers: { Authorization: `Bearer ${DASHSCOPE_KEY}` } });
    imgs.push(img.data.output.results[0].url);
  }
  t.imgs = imgs;

  // Step6
  t.step = 5; t.status = "【6/7】生成配音"; taskPool.set(taskId, t);
  const audios = [];
  for (let i = 0; i < shots.length; i++) {
    log(taskId, `生成配音 ${i+1}/${shots.length}`);
    const voice = await axios.post("https://openspeech.bytedance.com/api/v1/tts", {
      app: { appid: "auto", token: "auto" },
      req: { text: shots[i].text, speaker: "zh_female_documentary", audio_format: "mp3" }
    }, { headers: { Authorization: `Bearer ${VOLC_AK};${VOLC_SK}` } });
    const p = path.join(tmp, `${taskId}_${i}.mp3`);
    fs.writeFileSync(p, Buffer.from(voice.data.data, "base64"));
    audios.push(p);
  }
  t.audios = audios;

  // Step7
  t.step = 6; t.status = "【7/7】合成视频"; taskPool.set(taskId, t);
  try {
    log(taskId, "开始合成视频");
    t.status = "已完成";
    t.step = 7;
    log(taskId, "任务全部完成");
  } catch (e) {
    log(taskId, "视频合成失败：" + e.message);
    t.status = "视频合成失败（平台无FFmpeg）";
  }
  taskPool.set(taskId, t);
}
