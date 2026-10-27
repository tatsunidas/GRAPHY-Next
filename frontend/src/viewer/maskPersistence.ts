/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 塗り ROI（マスク）の保存形（純関数。Cornerstone・ネットワークには触らない）。
 *
 * <p>backend の `roi_mask_document` が持つのは、`meta`（このファイルの {@link SavedMaskMeta} の JSON）と、
 * `frames`（{@link MaskFramesInput} を JSON にして deflate した不透明なバイト列）。
 * 形の ROI の `roiPersistence.ts` と違い、画素を持つので**別テーブル・別 API**にしてある。
 */
import type { DimScope, RoiMaskMeta, RoiScope } from "./roiMaskStore";
import type { MaskFramesInput } from "./maskFrames";

/** マスク 1 件のメタ（名前・グループ・範囲・セグメント名）。画素は含まない。 */
export interface SavedMaskMeta {
  label?: string;
  /** 必須。患者を特定できないマスクは保存しない（#533 の方針。復元先の患者が決まらない）。 */
  patientKey: string;
  seriesLabel?: string;
  scope?: RoiScope;
  origin?: RoiScope;
  groupId?: string;
  groupName?: string;
  custom?: Record<string, string>;
  segments?: number[];
  segmentLabels?: Record<string, string>;
}

/** マスクが載っているシリーズ。範囲を後から "all" に広げても元のシリーズが分かるよう、原本（origin）を優先する。 */
export function maskSeriesUid(m: Pick<RoiMaskMeta, "origin" | "scope"> | undefined): string | undefined {
  return m?.origin?.seriesUid || m?.scope?.seriesUid || undefined;
}

/**
 * ストアのメタ → 保存するメタ。患者かシリーズが分からないマスクは null（保存しない）。
 * `lastSegExport`（DICOM ストア側の参照で、消え得る）と `persistUid`（行の鍵なので別に持つ）は入れない。
 */
export function toSavedMaskMeta(m: RoiMaskMeta | undefined): SavedMaskMeta | null {
  if (!m?.patientKey || !maskSeriesUid(m)) return null;
  const out: SavedMaskMeta = { patientKey: m.patientKey };
  if (m.label !== undefined) out.label = m.label;
  if (m.seriesLabel !== undefined) out.seriesLabel = m.seriesLabel;
  if (m.scope) out.scope = m.scope;
  if (m.origin) out.origin = m.origin;
  if (m.groupId) {
    out.groupId = m.groupId;
    if (m.groupName !== undefined) out.groupName = m.groupName;
  }
  if (m.custom && Object.keys(m.custom).length) out.custom = m.custom;
  if (m.segments?.length) out.segments = m.segments;
  if (m.segmentLabels && Object.keys(m.segmentLabels).length) out.segmentLabels = m.segmentLabels;
  return out;
}

/** 変更検知用の署名。同じ内容なら同じ文字列（キー順に依存しない）。 */
export function maskMetaSignature(m: SavedMaskMeta): string {
  const sorted = (o: unknown): unknown => {
    if (Array.isArray(o)) return o.map(sorted);
    if (o && typeof o === "object") {
      return Object.fromEntries(Object.entries(o as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sorted(v)]));
    }
    return o;
  };
  return JSON.stringify(sorted(m));
}

const dim = (v: unknown): DimScope | undefined => {
  if (v === "all") return "all";
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

function sanitizeScope(raw: unknown): RoiScope | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Partial<RoiScope>;
  const out: RoiScope = {};
  if (typeof s.studyUid === "string") out.studyUid = s.studyUid;
  if (typeof s.seriesUid === "string") out.seriesUid = s.seriesUid;
  for (const k of ["z", "c", "t"] as const) {
    const v = dim(s[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const strMap = (raw: unknown): Record<string, string> | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return Object.keys(out).length ? out : undefined;
};

/** backend から読んだメタ（JSON 文字列）の検証。必須項目が欠ける・壊れていれば null（そのマスクだけ戻さない）。 */
export function parseSavedMaskMeta(json: string | null | undefined): SavedMaskMeta | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Partial<SavedMaskMeta>;
  if (typeof m.patientKey !== "string" || !m.patientKey) return null;
  const out: SavedMaskMeta = { patientKey: m.patientKey };
  if (typeof m.label === "string") out.label = m.label;
  if (typeof m.seriesLabel === "string") out.seriesLabel = m.seriesLabel;
  const scope = sanitizeScope(m.scope);
  if (scope) out.scope = scope;
  const origin = sanitizeScope(m.origin);
  if (origin) out.origin = origin;
  if (typeof m.groupId === "string" && m.groupId) {
    out.groupId = m.groupId;
    if (typeof m.groupName === "string") out.groupName = m.groupName;
  }
  const custom = strMap(m.custom);
  if (custom) out.custom = custom;
  if (Array.isArray(m.segments)) {
    const segs = m.segments.filter((v): v is number => typeof v === "number" && Number.isInteger(v) && v > 0);
    if (segs.length) out.segments = segs;
  }
  const labels = strMap(m.segmentLabels);
  if (labels) out.segmentLabels = labels;
  return out;
}

/** 保存するフレーム数（全 segment のフレームの合計。0 になる＝保存するものが無い）。 */
export function countFrames(input: MaskFramesInput): number {
  return input.segments.reduce((n, s) => n + s.frames.length, 0);
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** フレーム（疎な 0/1 面の base64）→ JSON → deflate。前景のあるスライスだけなので大きく縮む。 */
export async function encodeFrames(input: MaskFramesInput): Promise<Uint8Array> {
  return pipe(new TextEncoder().encode(JSON.stringify(input)), new CompressionStream("deflate-raw"));
}

/** {@link encodeFrames} の逆。壊れている・形が違えば null（そのマスクだけ戻さない）。 */
export async function decodeFrames(bytes: Uint8Array): Promise<MaskFramesInput | null> {
  try {
    const text = new TextDecoder().decode(await pipe(bytes, new DecompressionStream("deflate-raw")));
    const raw = JSON.parse(text) as Partial<MaskFramesInput> | null;
    if (!raw || typeof raw.rows !== "number" || typeof raw.columns !== "number" || !Array.isArray(raw.segments)) return null;
    for (const s of raw.segments) {
      if (!s || typeof s.number !== "number" || !Array.isArray(s.frames)) return null;
      for (const f of s.frames) if (!f || typeof f.mask !== "string") return null;
    }
    return raw as MaskFramesInput;
  } catch {
    return null;
  }
}

/**
 * 指紋の入力にするバイト列。**画素・番号・名前・位置だけ**を取る。
 * 🔴 色（`color`）と派生値（体積）は入れない: 色は「マスクがビューポートに載っているか」で取れたり取れなかったり
 * するため、同じ画素でも抽出のたびに変わり、復元のたびに保存し直す原因になった（実機で発覚）。
 */
export function framesFingerprintInput(input: MaskFramesInput): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      rows: input.rows,
      columns: input.columns,
      segments: input.segments.map((s) => ({ number: s.number, label: s.label, description: s.description ?? null, frames: s.frames })),
    }),
  );
}

/**
 * 保存内容の指紋（メタの署名＋{@link framesFingerprintInput}）。前回送った内容と同じなら再送しない
 * （復元直後のメタ更新の通知などで、同じ内容を何度も書き直さないため）。
 * 暗号用ではない。長さと FNV-1a の 2 系統を連結する。
 */
export function contentFingerprint(metaSignature: string, frames: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0xdeadbeef;
  for (let i = 0; i < frames.length; i++) {
    h1 = Math.imul(h1 ^ frames[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ frames[i], 0x85ebca6b) >>> 0;
  }
  let m = 0x811c9dc5;
  for (let i = 0; i < metaSignature.length; i++) m = Math.imul(m ^ metaSignature.charCodeAt(i), 0x01000193) >>> 0;
  return `${frames.length}:${h1.toString(16)}:${h2.toString(16)}:${m.toString(16)}:${metaSignature.length}`;
}

/** backend の一覧 1 件（画素なし）。 */
export interface SavedMaskSummary {
  maskUid: string;
  seriesUid: string;
  meta: string;
  frameCount: number;
  bytes: number;
  version: number | null;
  updatedAt: string | null;
}

/**
 * 復元する保存マスクを選ぶ（純関数）。指定シリーズのもので、この窓にまだ無いもの（`persistUid` 既存）と、
 * メタが壊れているものを除く。
 */
export function selectMasksToRestore(
  saved: readonly SavedMaskSummary[],
  seriesUid: string,
  presentUids: ReadonlySet<string>,
): Array<{ summary: SavedMaskSummary; meta: SavedMaskMeta }> {
  const out: Array<{ summary: SavedMaskSummary; meta: SavedMaskMeta }> = [];
  for (const s of saved) {
    if (s.seriesUid !== seriesUid || presentUids.has(s.maskUid)) continue;
    const meta = parseSavedMaskMeta(s.meta);
    if (meta) out.push({ summary: s, meta });
  }
  return out;
}
