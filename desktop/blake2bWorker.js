/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// ファイルの BLAKE2b-512 を別スレッドで計算する（約 290 MB のインストーラの計算に十数秒かかり、
// main のイベントループを塞いで窓や IPC が止まるのを避ける）。workerData = { file }、
// 進捗は { progress: 読んだバイト数 }、結果は { digest: hex }、失敗は { error }。
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const { createBlake2b512 } = require("./blake2b");

const h = createBlake2b512();
let read = 0;
let lastPost = 0;
const stream = fs.createReadStream(workerData.file, { highWaterMark: 1 << 20 });
stream.on("data", (c) => {
  h.update(c);
  read += c.length;
  const now = Date.now();
  if (now - lastPost > 250) { lastPost = now; parentPort.postMessage({ progress: read }); }
});
stream.on("error", (e) => parentPort.postMessage({ error: String((e && e.message) || e) }));
stream.on("end", () => parentPort.postMessage({ digest: h.digest().toString("hex"), bytes: read }));
