/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 描画環境の要約を集める（WebGL の probe ＋ デスクトップの GPU 状態 ＋ メモリ）。
// 純関数は `renderEnv.ts`。ここは I/O をまとめる薄い層（設計: fw/render-environment-design.md）。
import { desktop } from "../desktopBridge";
import { probeRenderEnv, summarize, type RenderEnvSummary } from "./renderEnv";
import { getAppliedVolumeMaxMb } from "./volumeMemory";

let cached: Promise<RenderEnvSummary> | undefined;

/**
 * 描画環境の要約。1 回だけ集めてキャッシュする（GPU は実行中に変わらない前提）。
 * デスクトップ版の GPU 状態・搭載メモリは、取れなければ null のまま（web 版は常に null）。
 */
export function loadRenderEnvSummary(): Promise<RenderEnvSummary> {
  if (!cached) cached = collect();
  return cached;
}

async function collect(): Promise<RenderEnvSummary> {
  const probe = probeRenderEnv();
  const d = desktop();
  let gpu = null;
  if (d?.getGpuStatus) {
    try {
      gpu = await d.getGpuStatus();
    } catch {
      /* 旧バージョンの preload では未公開。未取得のまま */
    }
  }
  let totalBytes: number | null = null;
  if (d?.getMemoryInfo) {
    try {
      const m = await d.getMemoryInfo();
      if (m && m.totalBytes > 0) totalBytes = m.totalBytes;
    } catch {
      /* 同上 */
    }
  }
  let gpuMemory = null;
  if (d?.getGpuMemory) {
    try {
      gpuMemory = await d.getGpuMemory();
    } catch {
      /* 同上 */
    }
  }
  return summarize(probe, gpu, { totalBytes, volumeMaxMb: getAppliedVolumeMaxMb(), gpuMemory });
}
