/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * LoG のスケール（強調する構造の半径 r〔mm〕、または構造の幅〔画素〕）の入力欄の読み取りと展開。
 *
 * <p>書き方: カンマ・空白で区切った値と、連続値の走査「開始:終了:刻み」を混ぜられる
 * （例 `0, 1:2:0.5` → 0, 1, 1.5, 2）。走査の i 番目は 開始 + i × 刻み で作り（足し算を重ねない）、
 * 終了との比較は刻みの 1e-9 倍の幅で行う（`0.1:0.3:0.1` で 0.3 を落とさない）。表示の桁は
 * 開始・刻みの小数の桁にそろえる。
 */

export type ScaleNotation = "RADIUS_MM" | "WIDTH_PX";
export const SCALE_NOTATIONS: readonly ScaleNotation[] = ["RADIUS_MM", "WIDTH_PX"];

export const DEFAULT_SCALES = "0, 2, 3, 4, 5, 6";

/** フィルタ画像（派生シリーズ）の既定。0（フィルタなし）は画像を作らないので入れない。 */
export const DEFAULT_FILTER_SCALES = "2, 4, 6";

/** 読み取りの失敗。`key` は i18n の鍵（`roiFeat.scale.err.<key>`）、`token` は問題の入力。 */
export type ScaleSpecError = { key: "empty" | "number" | "step" | "order"; token?: string };

export type ScaleSpecResult = { values: number[]; error?: undefined } | { values?: undefined; error: ScaleSpecError };

const NUM = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

function toNumber(token: string): number | null {
  return NUM.test(token) ? Number(token) : null;
}

/** 小数の桁数（`0.25` → 2、`1e-3` は 3、整数は 0）。 */
function decimalsOf(token: string): number {
  const m = /^[+-]?\d*\.?(\d*)(?:e([+-]?\d+))?$/i.exec(token);
  if (!m) return 0;
  const frac = m[1]?.length ?? 0;
  const exp = m[2] ? Number(m[2]) : 0;
  return Math.max(0, frac - exp);
}

/** 走査 1 本の展開。 */
function expandRange(start: string, end: string, step: string): ScaleSpecResult {
  const a = toNumber(start);
  const b = toNumber(end);
  const h = toNumber(step);
  const token = `${start}:${end}:${step}`;
  if (a == null || b == null || h == null) return { error: { key: "number", token } };
  if (!(h > 0)) return { error: { key: "step", token } };
  if (b < a) return { error: { key: "order", token } };
  const digits = Math.min(10, Math.max(decimalsOf(start), decimalsOf(step)));
  const n = Math.floor((b - a) / h + 1e-9) + 1;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Number((a + i * h).toFixed(digits)));
  return { values: out };
}

/**
 * 値の欄を数の並びに直す。0 以上の有限数だけ。同じ値は先のものを残して 1 つにする。
 * 空・数にならない値・刻み 0 以下・終了 < 開始は、理由つきで断る。
 */
export function parseScaleSpec(text: string): ScaleSpecResult {
  const tokens = text.split(/[\s,]+/).filter((x) => x !== "");
  if (tokens.length === 0) return { error: { key: "empty" } };
  const all: number[] = [];
  for (const tk of tokens) {
    if (tk.includes(":")) {
      const parts = tk.split(":");
      if (parts.length !== 3) return { error: { key: "number", token: tk } };
      const r = expandRange(parts[0], parts[1], parts[2]);
      if (r.error) return r;
      all.push(...r.values);
    } else {
      const v = toNumber(tk);
      if (v == null) return { error: { key: "number", token: tk } };
      all.push(v);
    }
  }
  if (!all.every((v) => Number.isFinite(v) && v >= 0)) {
    return { error: { key: "number", token: String(all.find((v) => !(Number.isFinite(v) && v >= 0))) } };
  }
  return { values: all.filter((v, i) => all.indexOf(v) === i) };
}

/** 名札の欄（カンマ区切り。空欄は名札なし）。値の数と合わなければ null。 */
export function parseScaleLabels(text: string, count: number): string[] | null | "mismatch" {
  const parts = text.split(",").map((x) => x.trim());
  if (parts.every((x) => x === "")) return null;
  return parts.length === count ? parts : "mismatch";
}

/**
 * 一覧に出す σ（mm）。backend の FilterScale.sigmaMm と同じ式・同じ丸め（小数 4 桁）。r=0 はフィルタなしで null。
 * 計算には使わない（計算の換算は backend の 1 か所）。
 */
export function sigmaPreview(
  r: number, d: 2 | 3, conversion: "SQRT_D" | "IDENTITY" | "COEFFICIENT", k: number,
): number | null {
  if (r === 0) return null;
  const s = conversion === "SQRT_D" ? r / Math.sqrt(d) : conversion === "IDENTITY" ? r : k * r;
  return Number(s.toFixed(4));
}
