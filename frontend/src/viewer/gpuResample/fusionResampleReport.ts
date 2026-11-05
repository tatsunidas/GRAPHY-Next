/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * Fusion のリサンプルの判定の記録を、設定画面（別ウィンドウ）へ渡す。同じ場所の localStorage 経由
 * （3D の静止 1 フレームの時間を渡す `STILL_MS_STORAGE_KEY` と同じ作法）。書くのは `fusionResampler.ts`、読むのは設定 > 描画環境。
 */
import type { FusionResampleDecision } from "./fusionResampleStats";

export const FUSION_DECISION_STORAGE_KEY = "graphy.fusionResample.decision";

export interface StoredFusionDecision extends FusionResampleDecision {
  /** 記録した時刻（ms）。 */
  at: number;
}

export function writeFusionDecision(d: FusionResampleDecision, now = Date.now()): void {
  try {
    localStorage.setItem(FUSION_DECISION_STORAGE_KEY, JSON.stringify({ ...d, at: now } satisfies StoredFusionDecision));
  } catch {
    /* localStorage が使えなくても判定には影響しない */
  }
}

export function readFusionDecision(): StoredFusionDecision | null {
  try {
    const raw = localStorage.getItem(FUSION_DECISION_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredFusionDecision>;
    if (v.engine !== "cpu" && v.engine !== "gpu-webgl2") return null;
    return v as StoredFusionDecision;
  } catch {
    return null;
  }
}
