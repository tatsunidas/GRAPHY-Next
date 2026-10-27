/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * フィルタ画像（LoG の派生シリーズ）を元のタイルへ色分けで重ねる「層」の純関数。
 *
 * <p>層の値は派生シリーズの画素そのもの（ここで計算しない）。しきい値は Fusion の窓の下限で、それ以下の画素は
 * 透明になり、下の画像がそのまま見える。LoG の応答は IBSI の定義のまま「明るい構造が負」なので、層ごとに
 * 見せる側（負／正）を持ち、負の側は符号を反転して描く（カーソル値は反転しない）。
 */
import type { Instance, Series, SeriesLayoutDto, Study, TagDumpRow } from "../api";

export const MAX_LAYERS = 3;

/** 色覚の違いに配慮した色（Okabe–Ito の橙・空色・青緑）。 */
export const LAYER_COLORS: readonly string[] = ["#E69F00", "#56B4E9", "#009E73"];

export type LayerSide = "negative" | "positive";

export interface FilterLayer {
  /** 派生シリーズの UID（層の識別）。 */
  id: string;
  study: Study;
  series: Series;
  instances: Instance[];
  rMm: number;
  sigmaMm: number;
  /** 派生シリーズの表示窓の上限（|値| の最大。`WindowWidth / 2`）。 */
  maxAbs: number;
  color: string;
  threshold: number;
  opacity: number;
  side: LayerSide;
  /** false なら描かない（外さずに一時的に隠す。バーと凡例は残る）。 */
  visible: boolean;
}

/** 層の既定の見せる側（明るい構造が負になる向きなので、負）としきい値（0）・不透明度。 */
export const LAYER_DEFAULTS = { threshold: 0, opacity: 0.6, side: "negative" as LayerSide, visible: true };

/** `DerivationDescription`（key=value を `; ` でつないだもの）から LoG の r・σ・次元を読む。LoG でなければ null。 */
export function parseDerivation(text: string): { rMm: number; sigmaMm: number; dim: string } | null {
  const kv = new Map<string, string>();
  for (const part of text.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) kv.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  if (kv.get("filter") !== "LoG") return null;
  const r = Number(kv.get("r_mm"));
  const s = Number(kv.get("sigma_mm"));
  if (!Number.isFinite(r) || !Number.isFinite(s) || r <= 0 || s <= 0) return null;
  return { rMm: r, sigmaMm: s, dim: kv.get("dim") ?? "" };
}

const normTag = (t: string) => t.replace(/[\s()]/g, "").toLowerCase();

/** 派生シリーズ 1 枚のタグ一覧から、層に要る値を読む。LoG の派生画像でなければ null。 */
export function layerMetaFromTags(rows: readonly TagDumpRow[]): { rMm: number; sigmaMm: number; maxAbs: number } | null {
  const find = (tag: string, name: string) =>
    rows.find((r) => r.depth === 0 && (normTag(r.tag) === tag || r.name === name));
  const imageType = find("00080008", "ImageType")?.value ?? "";
  if (!imageType.split("\\").map((s) => s.trim()).includes("LOG")) return null;
  const d = parseDerivation(find("00082111", "DerivationDescription")?.value ?? "");
  const ww = Number(String(find("00281051", "WindowWidth")?.value ?? "").split("\\")[0]);
  if (!d || !Number.isFinite(ww) || ww <= 0) return null;
  return { rMm: d.rMm, sigmaMm: d.sigmaMm, maxAbs: ww / 2 };
}

export type GridMismatchKind = "missing" | "size" | "spacing" | "orientation" | "count" | "position";
export interface GridMismatch {
  kind: GridMismatchKind;
  /** 画面に添える具体的な値（例 `512 × 512 と 256 × 256`）。 */
  detail: string;
}

const TOL_MM = 0.001;
const differs = (a: number, b: number) => Math.abs(a - b) > TOL_MM;

/**
 * 元のタイルと層の格子（IOP・各スライスの IPP・画素間隔・行列・枚数）が一致しなければ、その理由。
 * 一致すれば null。許容は 0.001 mm（0.01 mm のずれは不一致）。向きは余弦なので 1e-4 を許す。
 */
export function gridMismatch(base: SeriesLayoutDto, layer: SeriesLayoutDto): GridMismatch | null {
  if (!base.imageOrientationPatient || !layer.imageOrientationPatient || !base.zSpatial?.length || !layer.zSpatial?.length) {
    return { kind: "missing", detail: "" };
  }
  if (base.imageWidth !== layer.imageWidth || base.imageHeight !== layer.imageHeight) {
    return { kind: "size", detail: `${base.imageWidth} × ${base.imageHeight} / ${layer.imageWidth} × ${layer.imageHeight}` };
  }
  if (differs(base.pixelSpacingRow, layer.pixelSpacingRow) || differs(base.pixelSpacingCol, layer.pixelSpacingCol)) {
    return {
      kind: "spacing",
      detail: `${base.pixelSpacingRow} × ${base.pixelSpacingCol} / ${layer.pixelSpacingRow} × ${layer.pixelSpacingCol} mm`,
    };
  }
  if (base.imageOrientationPatient.some((v, i) => Math.abs(v - layer.imageOrientationPatient![i]) > 1e-4)) {
    return { kind: "orientation", detail: "" };
  }
  if (base.zSpatial.length !== layer.zSpatial.length) {
    return { kind: "count", detail: `${base.zSpatial.length} / ${layer.zSpatial.length}` };
  }
  const a = [...base.zSpatial].sort((x, y) => x.z - y.z);
  const b = [...layer.zSpatial].sort((x, y) => x.z - y.z);
  for (let i = 0; i < a.length; i++) {
    if (a[i].imagePositionPatient.some((v, k) => differs(v, b[i].imagePositionPatient[k]))) {
      return { kind: "position", detail: `z ${a[i].z}` };
    }
  }
  return null;
}

/**
 * 層の描画窓。しきい値が下限、`maxAbs` が上限。`invert` が true（負の側）のときは、値の符号を反転した配列を
 * この窓で描く。しきい値が上限以上でも幅は正に保つ（何も描かれないだけ）。
 */
export function layerWindow(side: LayerSide, threshold: number, maxAbs: number): { center: number; width: number; invert: boolean } {
  const lo = Math.max(0, threshold);
  const width = Math.max(maxAbs - lo, 1e-6);
  return { center: lo + width / 2, width, invert: side === "negative" };
}

/** 単色の LUT。0 が黒、255 がその色（窓の下限以下は描かれず、LUT の 0 は使われない）。 */
export function singleColorLut(hex: string): { r: number[]; g: number[]; b: number[] } {
  const v = parseInt(hex.replace("#", ""), 16);
  const rgb = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  const ramp = (c: number) => Array.from({ length: 256 }, (_, i) => Math.round((c * i) / 255));
  return { r: ramp(rgb[0]), g: ramp(rgb[1]), b: ramp(rgb[2]) };
}

/** 層を足す。最大 3 本・同じシリーズは 1 回だけ。色は使っていない最初の色。 */
export function addLayer(
  layers: readonly FilterLayer[],
  layer: Omit<FilterLayer, "color" | "threshold" | "opacity" | "side" | "visible">,
): { layers: FilterLayer[] } | { error: "max" | "duplicate" } {
  if (layers.some((l) => l.id === layer.id)) return { error: "duplicate" };
  if (layers.length >= MAX_LAYERS) return { error: "max" };
  const color = LAYER_COLORS.find((c) => !layers.some((l) => l.color === c)) ?? LAYER_COLORS[0];
  return { layers: [...layers, { ...layer, color, ...LAYER_DEFAULTS }] };
}

export const removeLayer = (layers: readonly FilterLayer[], id: string): FilterLayer[] => layers.filter((l) => l.id !== id);
