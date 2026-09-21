/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * DSA 診断ダイアログの**描画に要る計算だけ**（`fw/angio-design.md` §6.14）。**純関数だけ**。
 *
 * <p>🔴 **ここに切り出す理由はひとつ。** このリポジトリには UI コンポーネントの検査基盤が無い
 * （`vitest` は `environment: "node"`・`*.test.tsx` はゼロ）。`.tsx` に書いた計算は誰も守れない。
 * 帯の位置・色の割り当て・系列の作り方だけをここへ出し、`.tsx` は薄い描画係にする。
 */
import type { DsaFramePlanEntry } from "./dsaLoader";
import type { PhaseMaskEntry } from "./xaPhaseMask";

/** グラフの背景に敷く帯（フレーム番号の半開区間 `[from, to)`）。 */
export interface PlotBand {
  from: number;
  to: number;
  color: string;
  /** 凡例に出す種別。 */
  kind: "ramp" | "preContrast" | "contrast";
}

/**
 * そのフレームが**何を引いているか**の出自。
 *
 * <p>🔑 これが DSA 診断の主語である。「追尾がどうだったか」ではなく
 * 「**このフレームは何を引いているのか**」を色で見せる。
 */
export type MaskOrigin = "self" | "phase" | "clamped" | "filled" | "default";

/** 出自ごとの色（暗色パネル上で読める値にしてある）。 */
const ORIGIN_COLORS: Record<MaskOrigin, string> = {
  // 自分自身＝差は厳密に 0。いちばん確かなので落ち着いた緑。
  self: "#69c98a",
  // 位相が合ったマスク。主役なので青。
  phase: "#7fb2ec",
  // 振幅の端へ丸めた＝外挿。注意を促す黄。
  clamped: "#e0b050",
  // 時間方向に隣から埋めた＝位相は合っていない。より強い橙。
  filled: "#e08a40",
  // 計画に載らず既定マスクへ落ちた。灰。
  default: "#7a8896",
};

/** 帯の色（薄く敷くので alpha つき）。 */
const BAND_COLORS: Record<PlotBand["kind"], string> = {
  ramp: "rgba(224, 96, 96, 0.10)",
  preContrast: "rgba(105, 201, 138, 0.10)",
  contrast: "rgba(127, 178, 236, 0.10)",
};

/**
 * 露出の立ち上がり／造影前／造影後の 3 本の帯。
 *
 * <p>🔑 **区切り専用のグラフを作らない**ための道具。p10 の曲線を別に描かなくても、
 * どのグラフの背景にもこれを敷けば「どこからが造影か」が読める。
 *
 * <p>境界が潰れている区間（`stableFrom === 0` など）は**返さない**——幅 0 の帯を描くと
 * 凡例にだけ現れて中身が無い、という読めない絵になる。
 */
export function phaseBands(stableFrom: number, contrastStart: number, frameCount: number): PlotBand[] {
  const n = Math.max(0, Math.floor(frameCount));
  if (n === 0) return [];
  const s = Math.min(n, Math.max(0, Math.floor(stableFrom)));
  const c = Math.min(n, Math.max(s, Math.floor(contrastStart)));
  const out: PlotBand[] = [];
  if (s > 0) out.push({ from: 0, to: s, color: BAND_COLORS.ramp, kind: "ramp" });
  if (c > s) out.push({ from: s, to: c, color: BAND_COLORS.preContrast, kind: "preContrast" });
  if (n > c) out.push({ from: c, to: n, color: BAND_COLORS.contrast, kind: "contrast" });
  return out;
}

/**
 * そのフレームが引いているマスクの出自を決める。
 *
 * <p>🚨 **判定の順番に意味がある。**
 * <ol>
 *   <li>計画が無ければ既定マスク（`default`）</li>
 *   <li>マスクが自分自身なら `self`（造影前。差は厳密に 0）</li>
 *   <li>**計画はあるのに対応付けが出せていない**なら、時間方向に隣から埋めたもの（`filled`）</li>
 *   <li>振幅の端へ丸めたなら `clamped`</li>
 *   <li>それ以外が本来の同位相マスク（`phase`）</li>
 * </ol>
 * 3 番目を 2 番目より後に置かないと、埋めたフレームが `phase` に化ける。
 */
export function maskOrigin(
  liveFrame: number,
  entry: PhaseMaskEntry | null | undefined,
  planEntry: DsaFramePlanEntry | null | undefined,
): MaskOrigin {
  if (!planEntry || !planEntry.maskFrames.length) return "default";
  if (planEntry.maskFrames.length === 1 && planEntry.maskFrames[0] === liveFrame) return "self";
  if (!entry || entry.maskFrame == null) return "filled";
  if (entry.status === "clamped") return "clamped";
  return "phase";
}

export function originColor(origin: MaskOrigin): string {
  return ORIGIN_COLORS[origin];
}

/** 凡例に出す順番（画面での並びを固定する）。 */
export const MASK_ORIGINS: readonly MaskOrigin[] = ["self", "phase", "clamped", "filled", "default"];

/**
 * 「何を引いているか」の系列。値は**マスクのフレーム番号**。
 *
 * <p>🔴 **既定マスク（複数フレームの平均）は数字にできないので `NaN` にして線を切る。**
 * 平均の代表値を勝手に置くと、そのフレームが 1 枚のマスクを引いているように見える。
 */
export function pairingSeries(
  entries: readonly PhaseMaskEntry[] | null,
  plan: readonly (DsaFramePlanEntry | null)[] | null,
  frameCount: number,
): { values: number[]; colors: (string | null)[]; origins: MaskOrigin[] } {
  const n = Math.max(0, Math.floor(frameCount));
  const values: number[] = new Array(n);
  const colors: (string | null)[] = new Array(n);
  const origins: MaskOrigin[] = new Array(n);
  for (let t = 0; t < n; t++) {
    const planEntry = plan?.[t] ?? null;
    const origin = maskOrigin(t, entries?.[t] ?? null, planEntry);
    origins[t] = origin;
    colors[t] = originColor(origin);
    values[t] = planEntry && planEntry.maskFrames.length === 1 ? planEntry.maskFrames[0] : Number.NaN;
  }
  return { values, colors, origins };
}

/** 出自ごとの件数（要約行に出す）。 */
export function originCounts(origins: readonly MaskOrigin[]): Record<MaskOrigin, number> {
  const out: Record<MaskOrigin, number> = { self: 0, phase: 0, clamped: 0, filled: 0, default: 0 };
  for (const o of origins) out[o] += 1;
  return out;
}

/** ZNCC は 0..1 で固定して見る（自動スケールだと 0.90〜0.95 が画面いっぱいになる）。 */
export const ZNCC_DOMAIN = { lo: 0, hi: 1 } as const;
