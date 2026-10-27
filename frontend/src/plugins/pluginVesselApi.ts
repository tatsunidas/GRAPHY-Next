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
  registerVesselModel as storeRegisterVesselModel,
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
  /** H62: 起動し直しても変わらない鍵。SOP が取れなければ null（保存できない）。 */
  stableKey: string | null;
  /** H62: 人が近位端を確かめたか。null は未確認（点順は描いた順のまま）。 */
  proximalFirst: true | null;
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
    stableKey: m.stableKey ?? null,
    proximalFirst: m.orientation?.proximalFirst ?? null,
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

/** プラグインが渡すモデル。`runId`・`at`・`producer` は host が決めるので含まない。 */
export type XaVesselModelInput = Omit<XaVesselModel, "runId" | "at" | "producer"> & {
  /** 同じ鍵で登録し直すと置き換わる（解析し直したら新しいほうが正しい）。1〜200 文字。 */
  runKey: string;
};

export type RegisterVesselModelResult = { ok: true; runId: string } | { ok: false; error: string };

/** 1 モデルの総点数の上限（点列の無制限な受け入れを避ける。暫定）。 */
export const MAX_VESSEL_MODEL_POINTS = 20000;

const MODEL_KINDS = ["xa-qca3d", "xa-bifurcation3d"] as const;
const TIERS = ["calibrated", "approximate", "uncalibrated"] as const;
const METHODS = ["half-max", "densitometric", "mixed"] as const;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";

/**
 * H73: 外部から来るモデルの形を検査する。**通らないものは理由付きで返す**（黙って直さない・落とさない）。
 *
 * <p>🔴 測れなかった点の径は `null`（0 や補間値で埋めない）。未校正（`diameterCalibrated: false`）なら**全点 null**
 * でなければ拒否する——px の値が mm の顔で FFR の入力に入る事故を、入口で止める。
 */
export function validateVesselModelInput(input: XaVesselModelInput | null | undefined): string | null {
  if (!input || typeof input !== "object") return "model is required";
  if (!isStr(input.runKey) || input.runKey.length < 1 || input.runKey.length > 200) return "runKey must be 1-200 chars";
  if (!(MODEL_KINDS as readonly unknown[]).includes(input.kind)) return `unknown kind: ${String(input.kind)}`;
  if (!isStr(input.label) || input.label.trim() === "") return "label is required";
  if (input.stableKey !== null && input.stableKey !== undefined && !isStr(input.stableKey)) return "stableKey must be string or null";
  const o = input.orientation;
  if (o !== undefined) {
    if (!o || typeof o !== "object") return "orientation must be an object";
    if (o.proximalFirst !== true && o.proximalFirst !== null) return "orientation.proximalFirst must be true or null";
    if (o.source !== "user" && o.source !== null) return "orientation.source must be 'user' or null";
  }

  const segs = input.segments;
  if (!Array.isArray(segs) || segs.length < 1) return "segments must be a non-empty array";
  const ids = new Set<string>();
  let total = 0;
  for (const s of segs) {
    if (!s || typeof s !== "object" || !isStr(s.id) || s.id === "") return "segment.id is required";
    if (ids.has(s.id)) return `duplicate segment id: ${s.id}`;
    ids.add(s.id);
  }
  const cal = input.calibration;
  if (!cal || typeof cal !== "object" || typeof cal.diameterCalibrated !== "boolean") return "calibration.diameterCalibrated is required";
  for (const s of segs) {
    if (s.parentId !== null && (!isStr(s.parentId) || !ids.has(s.parentId) || s.parentId === s.id)) {
      return `segment ${s.id}: parentId must be null or another segment's id`;
    }
    if (!Array.isArray(s.points) || s.points.length < 2) return `segment ${s.id}: at least 2 points are required`;
    for (const p of s.points) {
      if (!Array.isArray(p) || p.length !== 3 || !p.every(isNum)) return `segment ${s.id}: points must be finite [x,y,z]`;
    }
    if (!Array.isArray(s.diameterMm) || s.diameterMm.length !== s.points.length) {
      return `segment ${s.id}: diameterMm must have one entry per point`;
    }
    for (const d of s.diameterMm) {
      if (d !== null && !(isNum(d) && d > 0)) return `segment ${s.id}: diameterMm entries must be null or a positive finite number`;
      if (d !== null && !cal.diameterCalibrated) return `segment ${s.id}: diameterMm must be all null when diameterCalibrated is false`;
    }
    total += s.points.length;
  }
  if (total > MAX_VESSEL_MODEL_POINTS) return `too many points (max ${MAX_VESSEL_MODEL_POINTS})`;

  if (!Array.isArray(cal.sources) || !cal.sources.every(isStr)) return "calibration.sources must be strings";
  if (!Array.isArray(cal.tiers) || !cal.tiers.every((t) => (TIERS as readonly unknown[]).includes(t))) return "calibration.tiers is invalid";
  if (cal.diameterMethod !== null && !(METHODS as readonly unknown[]).includes(cal.diameterMethod)) return "calibration.diameterMethod is invalid";

  const pv = input.provenance;
  if (!pv || typeof pv !== "object") return "provenance is required";
  if (!isStr(pv.studyUid)) return "provenance.studyUid is required";
  if (!Array.isArray(pv.seriesUids) || !pv.seriesUids.every(isStr)) return "provenance.seriesUids must be strings";
  if (!Array.isArray(pv.sopUids) || !pv.sopUids.every(isStr)) return "provenance.sopUids must be strings";
  if (!Array.isArray(pv.angles) || !pv.angles.every((a) => Array.isArray(a) && a.length === 2 && a.every(isNum))) return "provenance.angles must be [primary, secondary] pairs";
  if (typeof pv.angleCorrected !== "boolean") return "provenance.angleCorrected is required";
  if (!Array.isArray(pv.visibleFractions) || !pv.visibleFractions.every((v) => v === null || isNum(v))) return "provenance.visibleFractions must be numbers or null";
  if (!isNum(pv.anchorReprojectionPx)) return "provenance.anchorReprojectionPx must be a finite number";
  if (!isNum(pv.separationDeg)) return "provenance.separationDeg must be a finite number";
  if (!Array.isArray(pv.frameIndices) || !pv.frameIndices.every((v) => isNum(v) && Number.isInteger(v) && v >= 0)) return "provenance.frameIndices must be non-negative integers";
  return null;
}

/**
 * H73: プラグインが作った 3D 血管モデルを登録する。出自（プラグイン）と `runId` は host が入れる。
 * 同じ `runKey` は置き換える。登録はセッション限り（`xaVesselModelStore` と同じ）。
 */
export function registerPluginVesselModel(
  input: XaVesselModelInput,
  producer: PluginProducer,
): RegisterVesselModelResult {
  const error = validateVesselModelInput(input);
  if (error) return { ok: false, error };
  const runId = `plugin:${producer.id}:${input.runKey}`;
  // 参照を持ち回らない（プラグインが後から書き換えると、登録済みのモデルが黙って変わる）。
  const model: XaVesselModel = {
    runId,
    stableKey: input.stableKey ?? null,
    orientation: input.orientation ?? { proximalFirst: null, source: null },
    kind: input.kind,
    label: input.label.trim(),
    segments: input.segments.map((s) => ({
      id: s.id,
      points: s.points.map((p) => [p[0], p[1], p[2]] as [number, number, number]),
      diameterMm: [...s.diameterMm],
      parentId: s.parentId,
    })),
    calibration: {
      diameterCalibrated: input.calibration.diameterCalibrated,
      sources: [...input.calibration.sources],
      tiers: [...input.calibration.tiers],
      diameterMethod: input.calibration.diameterMethod,
    },
    provenance: {
      studyUid: input.provenance.studyUid,
      seriesUids: [...input.provenance.seriesUids],
      sopUids: [...input.provenance.sopUids],
      angles: input.provenance.angles.map((a) => [a[0], a[1]] as [number, number]),
      angleCorrected: input.provenance.angleCorrected,
      visibleFractions: [...input.provenance.visibleFractions],
      anchorReprojectionPx: input.provenance.anchorReprojectionPx,
      separationDeg: input.provenance.separationDeg,
      frameIndices: [...input.provenance.frameIndices],
    },
    producer: { pluginId: producer.id, pluginName: producer.name, version: producer.version },
    at: Date.now(),
  };
  storeRegisterVesselModel(model);
  return { ok: true, runId };
}

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
