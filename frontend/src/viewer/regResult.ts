/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 自動位置合わせの結果（UI が保持する形）と、プレビュー用の変換への変換。
 *
 * <p>**手動の 6 値に潰さない**のが要点（設計 §12.1）。自動結果は 4×4 のまま持ち、
 * プレビューでは手動調整と `composeTransforms` で合成する。潰そうとすると
 * 前景中心が要り、「UI に座標を組ませない」方針と衝突する。加えて R4 の非剛体は
 * 6 値では表現できないので、合成の形にしておけばそのまま載る。
 */

import { linearTransform, type WorldTransform } from "./regTransform";

/** 自動位置合わせの結果。Worker の `done` から作る。 */
export interface RegistrationResult {
  /** fixed world → moving world の 4×4（row-major, 16 要素）。 */
  readonly matrix: number[];
  readonly center: [number, number, number];
  readonly translationMm: [number, number, number];
  readonly eulerDeg: [number, number, number];
  readonly metric: string;
  readonly metricValue: number;
  readonly elapsedMs: number;
  readonly sameFrameOfReference: boolean;
  readonly initialization: string;
}

/** 結果を描画側が使う変換へ。`null` / 未設定なら `null`（合成しない）。 */
export function registrationToTransform(r: RegistrationResult | null | undefined): WorldTransform | null {
  if (!r || r.matrix.length !== 16) return null;
  return linearTransform(Float64Array.from(r.matrix), { dof: 6, center: r.center });
}
