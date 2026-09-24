import { describe, expect, it } from "vitest";
import {
  MIN_AMPLITUDE_SPAN_PX,
  MIN_MATCHED_FRACTION,
  phaseMaskGates,
} from "./xaPhaseMaskGates";

/* ------------------------------------------------------------------ */
/* §6.15 — 「同位相」と名乗ってよいかの門                                */
/*                                                                      */
/* 🚨 これらは自動経路の中だけに書かれていて、診断ダイアログから手で      */
/*    追尾したときは 1 つも効いていなかった。定数ごと切り出したのは       */
/*    **同じ判定を 2 か所に書かないため**である。                        */
/* ------------------------------------------------------------------ */

/** 全部の門を通る入力。 */
const good = {
  liveTracked: 130,
  totalFrames: 137,
  maskAmplitudeSpan: 12.4,
  periodConfidence: "ok" as const,
};

describe("phaseMaskGates — 同位相と名乗ってよいか", () => {
  it("★ 追尾も振幅も周期も揃っていれば、止める理由は無い", () => {
    expect(phaseMaskGates(good)).toEqual([]);
  });

  it("🔴 ★ 振幅が追尾ノイズの水準なら止める（実機 Rubo Run1 の 0.49px）", () => {
    // `coverageTolerance` 5% が 0.025px になり、0.016px のはみ出しでマスクを拒否しながら
    // 「同位相マスク」と表示していた。それがいちばん悪い。
    expect(phaseMaskGates({ ...good, maskAmplitudeSpan: 0.49 })).toContain("noMotion");
    // 境界はちょうど 2px（未満で止める）。
    expect(phaseMaskGates({ ...good, maskAmplitudeSpan: MIN_AMPLITUDE_SPAN_PX })).toEqual([]);
    expect(phaseMaskGates({ ...good, maskAmplitudeSpan: MIN_AMPLITUDE_SPAN_PX - 0.01 }))
      .toContain("noMotion");
  });

  it("🔴 ★ 心拍の周期が出ない ROI は止める（呼吸を追っている可能性）", () => {
    expect(phaseMaskGates({ ...good, periodConfidence: "none" })).toContain("noCardiacRhythm");
    // "weak" は通す（自信は無いが心拍ではある）。
    expect(phaseMaskGates({ ...good, periodConfidence: "weak" })).toEqual([]);
  });

  it("★ 追尾が半数に満たなければ止める", () => {
    const half = Math.floor(good.totalFrames * MIN_MATCHED_FRACTION);
    expect(phaseMaskGates({ ...good, liveTracked: half - 1 })).toContain("trackFailed");
    expect(phaseMaskGates({ ...good, liveTracked: good.totalFrames })).toEqual([]);
  });

  it("🔴 ★ 重い順に返す（追尾が壊れていれば振幅も周期も信用できない）", () => {
    // 自動経路は先頭を失敗の理由に使うので、順序そのものが仕様である。
    const all = phaseMaskGates({
      liveTracked: 10,
      totalFrames: 137,
      maskAmplitudeSpan: 0.2,
      periodConfidence: "none",
    });
    expect(all).toEqual(["trackFailed", "noMotion", "noCardiacRhythm"]);
  });
});
