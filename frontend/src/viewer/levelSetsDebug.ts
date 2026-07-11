/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Level Sets Worker（本リポジトリ初の画像処理用 Worker、fw/level-sets-design.md §3）の疎通確認用ヘルパ。
 * DevTools Console で `__graphyLevelSetSelfTest()` を実行すると、Cornerstone/DICOM 無しの合成画像で
 * Fast Marching を Worker 経由で 1 回実行し、成否・到達ボクセル数・所要時間を返す（`await` で結果取得）。
 * dev/packaged いずれの環境でも Worker が正しく起動するかの切り分けに使う（`segDebug.ts` と同じ狙い）。
 */
import type { LevelSetWorkerRequest, LevelSetWorkerResponse } from "./levelSetsProtocol";

interface SelfTestResult {
  ok: boolean;
  reachedCount?: number;
  elapsedMs: number;
  error?: string;
}

function runSelfTest(): Promise<SelfTestResult> {
  const start = performance.now();
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./levelSetsWorker.ts", import.meta.url), { type: "module" });
    } catch (e) {
      resolve({ ok: false, elapsedMs: performance.now() - start, error: `worker construction failed: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    const timeout = setTimeout(() => {
      worker.terminate();
      resolve({ ok: false, elapsedMs: performance.now() - start, error: "timeout (5s) waiting for worker response" });
    }, 5000);
    worker.onerror = (ev) => {
      clearTimeout(timeout);
      worker.terminate();
      resolve({ ok: false, elapsedMs: performance.now() - start, error: `worker onerror: ${ev.message}` });
    };
    worker.onmessage = (ev: MessageEvent<LevelSetWorkerResponse>) => {
      clearTimeout(timeout);
      const res = ev.data;
      worker.terminate();
      if (res.type === "fastMarchingDone") {
        resolve({ ok: true, reachedCount: res.reachedCount, elapsedMs: performance.now() - start });
      } else {
        resolve({ ok: false, elapsedMs: performance.now() - start, error: res.message ?? "unknown error" });
      }
    };
    // 32x32 の合成画像。中心付近を輝度100の円、周囲を輝度0にして、Fast Marching が境界で止まることを確認する。
    const cols = 32;
    const rows = 32;
    const image = new Float32Array(cols * rows);
    const cx = cols / 2;
    const cy = rows / 2;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        image[y * cols + x] = Math.hypot(x - cx, y - cy) < 10 ? 100 : 0;
      }
    }
    const req: LevelSetWorkerRequest = {
      type: "fastMarching",
      requestId: 1,
      image,
      dims: { cols, rows, depth: 1 },
      seedX: Math.round(cx),
      seedY: Math.round(cy),
      seedZ: 0,
      greyValueThreshold: 10,
      distanceThreshold: 50,
    };
    worker.postMessage(req, [image.buffer]);
  });
}

/** Console から呼ぶ: `__graphyLevelSetSelfTest()`。Promise を返す（await で結果を確認）。 */
export function installLevelSetDebug(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__graphyLevelSetSelfTest = async () => {
    const result = await runSelfTest();
    // eslint-disable-next-line no-console
    console.log("[levelSetSelfTest]", result);
    return result;
  };
}
