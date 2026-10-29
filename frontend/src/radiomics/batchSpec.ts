/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 一括抽出の「処理の定義」。設定・QC・組の選び方を 1 つの JSON にして保存し、読み込む。
 *
 * <p>**読み込むファイルは信頼しない**（共有された定義・手で編集された定義が来る）。大きさ・型・範囲・
 * 未知のキーを検査し、埋め込みの SHA-256 と再計算が違えば読み込まない（改変・破損の検出）。
 * SHA-256 は設定の中身（`form`・`qc`・`selection`）の正準な JSON に対して取る。出力の接頭辞は設定ではないので
 * 含めない（名前を変えてもハッシュは変わらない）。
 *
 * <p>画像フィルタ（LoG・スケール）は定義に入れない（一括抽出が対象にしていない）。
 */
import { ROI_FEATURE_FAMILIES, defaultRoiFeatureForm, type RoiFeatureForm } from "./roiFeatureSettings";

export const SPEC_FORMAT = "graphy-next.roi-batch-spec";
export const SPEC_VERSION = 1;
/** 読み込む定義の上限。正常な定義は 数 KB なので、これを超えるものは断る。 */
export const SPEC_MAX_BYTES = 256 * 1024;
export const SEGMENT_LABELS_MAX = 100;
export const SEGMENT_LABEL_MAX_LEN = 128;
export const PREFIX_MAX_LEN = 100;

export type SpecQcMode = "FLAG" | "STOP";

export type SpecForm = Pick<RoiFeatureForm, "fixedBinNumber" | "binCount" | "binWidth" | "resampleMm" | "families">;

/**
 * QC の設定。`smallRoiVoxels` は小さい ROI の基準値（ボクセル数、1 以上の整数）。null は環境設定の値を使う。
 * null のときは正準 JSON にキーを出さない（基準値の無い従来の定義の SHA-256 を変えない）。
 */
export interface SpecQc {
  smallRoi: SpecQcMode;
  lossy: SpecQcMode;
  smallRoiVoxels: number | null;
}

/** 基準値の上限（バックエンドの Integer と同じ）。 */
export const SMALL_ROI_VOXELS_MAX = 2147483647;

/** ハッシュの対象になる中身。 */
export interface SpecContent {
  form: SpecForm;
  qc: SpecQc;
  selection: { segmentLabels: string[] };
}

export interface BatchSpec extends SpecContent {
  format: typeof SPEC_FORMAT;
  version: typeof SPEC_VERSION;
  output: { prefix: string };
  sha256: string;
}

export type SpecError =
  | "too_large" | "not_json" | "not_object" | "format" | "version" | "type" | "range" | "sha_missing" | "sha_mismatch";

export type SpecParse =
  | { ok: true; spec: BatchSpec; ignoredFamilies: number }
  | { ok: false; error: SpecError; detail: string };

export function defaultSpecContent(): SpecContent {
  const f = defaultRoiFeatureForm();
  return {
    form: { fixedBinNumber: f.fixedBinNumber, binCount: f.binCount, binWidth: f.binWidth, resampleMm: f.resampleMm, families: f.families },
    qc: { smallRoi: "FLAG", lossy: "FLAG", smallRoiVoxels: null },
    selection: { segmentLabels: [] },
  };
}

/** 絞り込みのラベルの正規化: 前後の空白を除き、空と完全一致の重複を落とす（並びは保つ）。 */
export function normalizeLabels(labels: readonly string[]): string[] {
  const out: string[] = [];
  for (const l of labels) {
    const s = l.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** 画面の入力欄（カンマ・読点・改行区切り）をラベルの並びにする。 */
export function parseLabelInput(text: string): string[] {
  return normalizeLabels(text.split(/[,、\n]/));
}

const qcJson = (q: SpecQc) =>
  q.smallRoiVoxels == null ? { smallRoi: q.smallRoi, lossy: q.lossy } : { smallRoi: q.smallRoi, lossy: q.lossy, smallRoiVoxels: q.smallRoiVoxels };

/** 正準な JSON。キーの並びを固定して組み立てる（族は `ROI_FEATURE_FAMILIES` の順）。 */
export function canonicalContentJson(c: SpecContent): string {
  const families = ROI_FEATURE_FAMILIES.map((f) => [f.key, !!c.form.families[f.key]] as const);
  return JSON.stringify({
    form: {
      fixedBinNumber: c.form.fixedBinNumber,
      binCount: c.form.binCount,
      binWidth: c.form.binWidth,
      resampleMm: c.form.resampleMm,
      families: Object.fromEntries(families),
    },
    qc: qcJson(c.qc),
    selection: { segmentLabels: normalizeLabels(c.selection.segmentLabels) },
  });
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const contentSha256 = (c: SpecContent): Promise<string> => sha256Hex(canonicalContentJson(c));

export async function buildSpec(c: SpecContent, prefix: string): Promise<BatchSpec> {
  return {
    format: SPEC_FORMAT,
    version: SPEC_VERSION,
    form: {
      fixedBinNumber: c.form.fixedBinNumber, binCount: c.form.binCount, binWidth: c.form.binWidth,
      resampleMm: c.form.resampleMm, families: Object.fromEntries(ROI_FEATURE_FAMILIES.map((f) => [f.key, !!c.form.families[f.key]])),
    },
    qc: { ...c.qc },
    selection: { segmentLabels: normalizeLabels(c.selection.segmentLabels) },
    output: { prefix: prefix.slice(0, PREFIX_MAX_LEN) },
    sha256: await contentSha256(c),
  };
}

/** 保存するテキスト。基準値が null のときは、正準 JSON と同じくキーを書かない。 */
export const specText = (spec: BatchSpec): string => `${JSON.stringify({ ...spec, qc: qcJson(spec.qc) }, null, 2)}\n`;

/** 定義のファイル名。接頭辞に使えない文字は `_`、空なら `roi-features-batch`。 */
export const batchSpecFileName = (prefix: string): string =>
  `${prefix.trim().replace(/[\\/:*?"<>|\s]/g, "_") || "roi-features-batch"}_spec.json`;

const fail = (error: SpecError, detail: string): SpecParse => ({ ok: false, error, detail });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const inRange = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

/** 定義のテキストを検査して読む。失敗したら理由を返し、何も変えない。 */
export async function parseSpec(text: string): Promise<SpecParse> {
  if (new TextEncoder().encode(text).length > SPEC_MAX_BYTES) return fail("too_large", `${SPEC_MAX_BYTES}`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("not_json", "");
  }
  if (!isObj(raw)) return fail("not_object", "");
  if (own(raw, "format") !== SPEC_FORMAT) return fail("format", String(own(raw, "format")));
  if (own(raw, "version") !== SPEC_VERSION) return fail("version", String(own(raw, "version")));

  const form = own(raw, "form");
  const qc = own(raw, "qc");
  const sel = own(raw, "selection");
  const out = own(raw, "output");
  if (!isObj(form) || !isObj(qc) || !isObj(sel) || !isObj(out)) return fail("type", "form/qc/selection/output");

  const fixedBinNumber = own(form, "fixedBinNumber");
  if (typeof fixedBinNumber !== "boolean") return fail("type", "form.fixedBinNumber");
  const binCount = own(form, "binCount");
  if (!inRange(binCount, 2, 1024) || !Number.isInteger(binCount)) return fail("range", "form.binCount");
  const binWidth = own(form, "binWidth");
  if (!inRange(binWidth, 0.001, 100000)) return fail("range", "form.binWidth");
  const resampleMm = own(form, "resampleMm");
  if (resampleMm !== null && !inRange(resampleMm, 0.05, 20)) return fail("range", "form.resampleMm");

  const famRaw = own(form, "families");
  if (!isObj(famRaw)) return fail("type", "form.families");
  const known = new Set(ROI_FEATURE_FAMILIES.map((f) => f.key));
  const defaults = defaultRoiFeatureForm().families;
  const families: Record<string, boolean> = {};
  for (const f of ROI_FEATURE_FAMILIES) {
    const v = own(famRaw, f.key);
    if (v === undefined) families[f.key] = defaults[f.key];
    else if (typeof v === "boolean") families[f.key] = v;
    else return fail("type", `form.families.${f.key}`);
  }
  const ignoredFamilies = Object.keys(famRaw).filter((k) => !known.has(k)).length;

  const smallRoi = own(qc, "smallRoi");
  const lossy = own(qc, "lossy");
  if ((smallRoi !== "FLAG" && smallRoi !== "STOP") || (lossy !== "FLAG" && lossy !== "STOP")) return fail("type", "qc");
  const voxelsRaw = own(qc, "smallRoiVoxels");
  let smallRoiVoxels: number | null = null;
  if (voxelsRaw !== undefined && voxelsRaw !== null) {
    if (typeof voxelsRaw !== "number") return fail("type", "qc.smallRoiVoxels");
    if (!Number.isInteger(voxelsRaw) || voxelsRaw < 1 || voxelsRaw > SMALL_ROI_VOXELS_MAX) return fail("range", "qc.smallRoiVoxels");
    smallRoiVoxels = voxelsRaw;
  }

  const labelsRaw = own(sel, "segmentLabels");
  if (!Array.isArray(labelsRaw)) return fail("type", "selection.segmentLabels");
  if (labelsRaw.length > SEGMENT_LABELS_MAX) return fail("range", "selection.segmentLabels");
  const labels: string[] = [];
  for (const l of labelsRaw) {
    if (typeof l !== "string") return fail("type", "selection.segmentLabels[]");
    if (l.length > SEGMENT_LABEL_MAX_LEN) return fail("range", "selection.segmentLabels[]");
    labels.push(l);
  }

  const prefix = own(out, "prefix");
  if (typeof prefix !== "string") return fail("type", "output.prefix");
  if (prefix.length > PREFIX_MAX_LEN) return fail("range", "output.prefix");

  const embedded = own(raw, "sha256");
  if (typeof embedded !== "string" || embedded === "") return fail("sha_missing", "");

  const content: SpecContent = {
    form: { fixedBinNumber, binCount, binWidth, resampleMm: resampleMm as number | null, families },
    qc: { smallRoi, lossy, smallRoiVoxels },
    selection: { segmentLabels: normalizeLabels(labels) },
  };
  const actual = await contentSha256(content);
  if (actual !== embedded.toLowerCase()) return fail("sha_mismatch", actual);
  return { ok: true, spec: { ...(await buildSpec(content, prefix)) }, ignoredFamilies };
}

/** 定義の中身を ROI 特徴量の入力欄の値に反映する（LoG・スケールは既定のまま）。 */
export function applySpecToForm(base: RoiFeatureForm, spec: SpecContent): RoiFeatureForm {
  return { ...base, ...spec.form, families: { ...spec.form.families } };
}

/** 入力欄の値から定義の中身を作る。 */
export function specContentFrom(form: RoiFeatureForm, qc: SpecContent["qc"], labels: readonly string[]): SpecContent {
  return {
    form: { fixedBinNumber: form.fixedBinNumber, binCount: form.binCount, binWidth: form.binWidth, resampleMm: form.resampleMm, families: form.families },
    qc,
    selection: { segmentLabels: normalizeLabels(labels) },
  };
}
