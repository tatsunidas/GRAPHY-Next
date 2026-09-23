/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 同位相マスクを「名乗ってよいか」の門（`fw/angio-design.md` §6.9・§6.15）。**純関数だけ**。
 *
 * <h3>🔴 なぜ切り出したか</h3>
 * これらの門は自動同位相 DSA（`xaAutoPhaseMask.ts`）の中だけに書かれていて、
 * **診断ダイアログから手で追尾したときは 1 つも効いていなかった**。Worker は判断材料
 * （`maskAmplitudeSpan` / `liveTracked` / `maskPeriod`）を両方の経路へ返しているのに、
 * 読んでいたのが自動経路だけだったためである。
 *
 * <p>結果、手で雑な ROI を引いても**警告なしで「同位相マスク」として DSA に入れられた**。
 * `xaAutoPhaseMask.ts` が「実機で振幅 0.49px ＝追尾ノイズのまま同位相と名乗るのが
 * いちばん悪い」と名指しした事故が、手動経路では素通りしていた。
 *
 * <p>**同じ判定を 2 か所に書かない**ために、定数ごとここへ移してある。
 */

/** 追尾できたフレームがこの割合を下回ったら、自動では足りないと判断する。 */
export const MIN_MATCHED_FRACTION = 0.5;

/**
 * 🔴 **マスク側の運動振幅（p10–p90）がこれ未満なら、振幅で並べ替えても意味がない。**
 *
 * <p>実機（Rubo Run1）で採用されていた ROI の振幅は **0.49px** ＝ 追尾ノイズそのもので、
 * `coverageTolerance` 5% が **0.025px** になり、**0.016px のはみ出し**でマスクを拒否していた。
 * それでも「同位相マスク」と表示してしまうのがいちばん悪い。ここで止める。
 */
export const MIN_AMPLITUDE_SPAN_PX = 2;

/** 門の種類。文言は i18n の `xadsa.gate.*` / `dsa.autoPhase.failed.*` に対応する。 */
export type PhaseMaskGate = "trackFailed" | "noMotion" | "noCardiacRhythm";

export interface PhaseMaskGateInput {
  /** 追尾できたライブフレーム数。 */
  liveTracked: number;
  /** ライブの全フレーム数。 */
  totalFrames: number;
  /** マスク側の運動振幅 [px]（p10–p90）。 */
  maskAmplitudeSpan: number;
  /** マスク側の周期推定の確からしさ。 */
  periodConfidence: "ok" | "weak" | "none";
}

/**
 * 通らなかった門を**重い順**に返す（空なら同位相と名乗ってよい）。
 *
 * <p>🔴 **順序に意味がある。** 追尾が壊れていれば振幅も周期も信用できないので、
 * 最初の 1 つが「本当の理由」になる。自動経路はそれを `fail()` の理由に使う。
 */
export function phaseMaskGates(input: PhaseMaskGateInput): PhaseMaskGate[] {
  const out: PhaseMaskGate[] = [];
  if (input.liveTracked < input.totalFrames * MIN_MATCHED_FRACTION) out.push("trackFailed");
  if (input.maskAmplitudeSpan < MIN_AMPLITUDE_SPAN_PX) out.push("noMotion");
  // 🔑 これが「呼吸を追っているのか心拍を追っているのか」の門である。周期が出ない ROI は
  //    横隔膜の呼吸性ドリフトを追っている可能性が高く、位相を合わせても意味がない。
  if (input.periodConfidence === "none") out.push("noCardiacRhythm");
  return out;
}
