/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * プラグイン host API の **H11 / H12**（`fw/angio-design.md` §11・A7）。
 *
 * - **H11 `getVesselModel`** … 再構成済みの 3D 血管モデル（中心線・径・校正・出自）を渡す
 * - **H12 `putVesselAnalysis`** … 外部モジュールが返した点ごとの値を受け取り、3D 表示へ色で乗せる
 *
 * <h3>🔴 本体は FFR を計算しない</h3>
 * 流体解析・学習モデルの実装と検証は本体の射程を超え、かつ FFR は**治療方針を左右する値**なので
 * 規制上も分離しておく（§11.1 / §19。registration で DL を本体に載せないと決めたのと同じ線引き）。
 * したがってここは**運び役**に徹する——値の意味を解釈せず、閾値も持たず、正常/異常も判定しない。
 *
 * <h3>host が引き受けること</h3>
 * 1. **出自を入れる**（プラグイン id・名前・版）。プラグインに名乗らせない（H37 / H39 と同じ）。
 * 2. **形の検査**。壊れた入力は**黙って落とさずエラーを返す**——落とすと
 *    「送ったはずの値が無い色マップ」ができ、受け取った側は気付けない（H9 / H39 で同じ判断）。
 * 3. **近似には近似と書く**。校正の縮退区分は画面（凡例の脇）に必ず出る（§7.4）。
 *    未校正の幾何から出た FFR でも本体は止めないが、**未校正であることは消さない**。
 */

import {
  getVesselAnalysis,
  getVesselModel as storeGetVesselModel,
  listVesselModels as storeListVesselModels,
  putVesselAnalysis as storePutVesselAnalysis,
  type XaVesselAnalysis,
  type XaVesselModel,
} from "../viewer/xaVesselModelStore";

export type {
  XaVesselAnalysis,
  XaVesselAnalysisPoint,
  XaVesselCalibration,
  XaVesselModel,
  XaVesselProvenance,
  XaVesselSegment,
} from "../viewer/xaVesselModelStore";

/** 一覧に出す最小限（モデル本体は点列が重いので、選ぶまで渡さない）。 */
export interface XaVesselModelSummary {
  runId: string;
  kind: XaVesselModel["kind"];
  label: string;
  segmentCount: number;
  pointCount: number;
  /** 径が mm で出せているか。false なら断面積が作れない＝FFR の入力にならない。 */
  diameterCalibrated: boolean;
  /** 校正の縮退区分のうち最も弱いもの（`approximate` が 1 つでもあれば `approximate`）。 */
  tier: "calibrated" | "approximate" | "uncalibrated";
  at: number;
}

/** プラグインが渡してくる解析結果（出自は host が入れるので含まない）。 */
export interface XaVesselAnalysisInput {
  kind: XaVesselAnalysis["kind"];
  label: string;
  range: [number, number];
  perPoint: { segmentId: string; index: number; value: number }[];
  disclaimer?: string;
}

export interface PluginProducer {
  id: string;
  name: string;
  version: string;
}

/** 最も弱い縮退区分を選ぶ（1 方向でも近似なら結果は近似）。 */
export function weakestTier(
  tiers: readonly ("calibrated" | "approximate" | "uncalibrated")[],
): "calibrated" | "approximate" | "uncalibrated" {
  if (tiers.length === 0) return "uncalibrated";
  if (tiers.includes("uncalibrated")) return "uncalibrated";
  if (tiers.includes("approximate")) return "approximate";
  return "calibrated";
}

export function summarizeVesselModel(m: XaVesselModel): XaVesselModelSummary {
  return {
    runId: m.runId,
    kind: m.kind,
    label: m.label,
    segmentCount: m.segments.length,
    pointCount: m.segments.reduce((n, s) => n + s.points.length, 0),
    diameterCalibrated: m.calibration.diameterCalibrated,
    tier: weakestTier(m.calibration.tiers),
    at: m.at,
  };
}

/** H11: 再構成済みモデルの一覧（新しい順）。 */
export function listVesselModels(): XaVesselModelSummary[] {
  return [...storeListVesselModels()].sort((a, b) => b.at - a.at).map(summarizeVesselModel);
}

/** H11: モデル本体。`runId` 省略時は**最も新しいもの**。無ければ null。 */
export function getVesselModel(runId?: string): XaVesselModel | null {
  if (runId) return storeGetVesselModel(runId);
  const all = [...storeListVesselModels()].sort((a, b) => b.at - a.at);
  return all[0] ?? null;
}

export type VesselAnalysisResult = { ok: boolean; error?: string };

/**
 * 入力の形を検査する。**通らないものは理由付きで返す**（黙って直さない・黙って落とさない）。
 *
 * <p>🔴 添字の範囲外を「捨てて残りを採用」しないのは意図的。ソルバ側の点列と本体のモデルが
 * ずれている状態でそれをやると、**ずれたまま色が乗る**——値は付くので誰も間違いに気付かない。
 */
export function validateVesselAnalysis(
  model: XaVesselModel | null,
  input: XaVesselAnalysisInput | null | undefined,
): string | null {
  if (!model) return "vessel model not found";
  if (!input || typeof input !== "object") return "analysis is required";
  if (input.kind !== "ffr" && input.kind !== "custom") return `unknown kind: ${String(input.kind)}`;
  if (typeof input.label !== "string" || input.label.trim() === "") return "label is required";
  const range = input.range;
  if (!Array.isArray(range) || range.length !== 2 || !range.every((v) => Number.isFinite(v))) {
    return "range must be two finite numbers";
  }
  if (range[0] >= range[1]) return "range must be [min, max] with min < max";
  if (!Array.isArray(input.perPoint) || input.perPoint.length === 0) {
    return "perPoint must have at least one entry";
  }
  const sizes = new Map(model.segments.map((s) => [s.id, s.points.length]));
  for (const p of input.perPoint) {
    const n = sizes.get(p?.segmentId);
    if (n === undefined) return `unknown segmentId: ${String(p?.segmentId)}`;
    if (!Number.isInteger(p.index) || p.index < 0 || p.index >= n) {
      return `index out of range for segment ${p.segmentId}: ${String(p.index)} (0..${n - 1})`;
    }
    if (!Number.isFinite(p.value)) return `value must be finite (segment ${p.segmentId}, index ${p.index})`;
  }
  return null;
}

/** H12: 解析結果を登録する。出自は host が入れる。 */
export function putVesselAnalysis(
  runId: string,
  input: XaVesselAnalysisInput,
  producer: PluginProducer,
): VesselAnalysisResult {
  const model = storeGetVesselModel(runId);
  const error = validateVesselAnalysis(model, input);
  if (error) return { ok: false, error };
  storePutVesselAnalysis({
    runId,
    kind: input.kind,
    label: input.label.trim(),
    range: [input.range[0], input.range[1]],
    // 参照を持ち回らない（プラグインが後から書き換えると画面が黙って変わる）。
    perPoint: input.perPoint.map((p) => ({ segmentId: p.segmentId, index: p.index, value: p.value })),
    disclaimer: typeof input.disclaimer === "string" && input.disclaimer.trim() !== ""
      ? input.disclaimer.trim()
      : undefined,
    source: { pluginId: producer.id, pluginName: producer.name, version: producer.version },
    at: Date.now(),
  });
  return { ok: true };
}

/** 自分が入れた結果を読み返す（表示できたかの確認用）。 */
export function readVesselAnalysis(runId: string): XaVesselAnalysis | null {
  return getVesselAnalysis(runId);
}
