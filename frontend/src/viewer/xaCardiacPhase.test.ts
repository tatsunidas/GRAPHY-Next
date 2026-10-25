import { describe, expect, it } from "vitest";
import { cardiacPhaseInfo, normalizeRWaves } from "./xaCardiacPhase";

const times = (n: number, dt: number) => Array.from({ length: n }, (_, i) => i * dt);

describe("cardiacPhaseInfo", () => {
  it("規則的な R 波: 位相が手計算と一致する（1 起点→0 起点）", () => {
    // R 波ポインタ [3, 13, 23]（1 起点）= 0 起点で 2, 12, 22。40 ms 間隔、R-R = 10 フレーム = 400 ms
    const info = cardiacPhaseInfo([3, 13, 23], times(30, 40), 17);
    expect(info.source).toBe("ecg");
    expect(info.rFrames).toEqual([2, 12, 22]);
    // フレーム 17 は R(12) から 5 フレーム = 200 ms、R-R 400 ms → 0.5
    expect(info.phase?.msSincePrevR).toBeCloseTo(200, 9);
    expect(info.phase?.rrMs).toBeCloseTo(400, 9);
    expect(info.phase?.rrFraction).toBeCloseTo(0.5, 9);
    // 各 R 波の直前のフレーム（0 起点）
    expect(info.candidates).toEqual([1, 11, 21]);
  });

  it("不整な R-R（Rubo 0012 型 [2,15,52,69]）: 拍ごとの R-R で割る", () => {
    const t = times(70, 40);
    // 0 起点の R 波 = 1, 14, 51, 68。フレーム 33 は 14 と 51 の間（R-R 37 フレーム）
    const info = cardiacPhaseInfo([2, 15, 52, 69], t, 33);
    expect(info.phase?.rrMs).toBeCloseTo(37 * 40, 9);
    expect(info.phase?.rrFraction).toBeCloseTo(19 / 37, 9);
    // 周期を一定と置いた誤った計算（平均 R-R）とは一致しない
    const meanRr = ((68 - 1) / 3) * 40;
    expect(info.phase?.rrFraction).not.toBeCloseTo((19 * 40) / meanRr, 3);
  });

  it("負例: 最初の R 波より前・最後の R 波より後は位相を出さない（外挿しない）", () => {
    const t = times(30, 40);
    expect(cardiacPhaseInfo([10, 20], t, 3).phase).toBeNull();
    expect(cardiacPhaseInfo([10, 20], t, 25).phase).toBeNull();
    // 最後の R 波そのもの（次の R 波が無い）も出さない
    expect(cardiacPhaseInfo([10, 20], t, 19).phase).toBeNull();
    // 最初の R 波のフレーム自体は位相 0
    expect(cardiacPhaseInfo([10, 20], t, 9).phase?.rrFraction).toBe(0);
  });

  it("負例: タグ無し／空は none（0 や既定値で埋めない）", () => {
    for (const p of [null, []]) {
      const info = cardiacPhaseInfo(p, times(30, 40), 5);
      expect(info).toEqual({ source: "none", rFrames: [], candidates: [], phase: null });
    }
  });

  it("負例: 範囲外・重複・非整数の R 波は捨てる。1 起点を 0 起点と取り違えると落ちる", () => {
    expect(normalizeRWaves([0, 3, 3, 99, 2.5], 30)).toEqual([2]);
    // 取り違え検出: ポインタ 1 はフレーム 0（先頭）。0 起点と誤解すると 1 になる
    expect(normalizeRWaves([1], 30)).toEqual([0]);
    expect(cardiacPhaseInfo([1, 11], times(30, 40), 0).candidates).toEqual([9]); // フレーム 0 の R 波は直前なし
  });

  it("可変フレーム間隔でも時刻で割る", () => {
    const t = [0, 40, 80, 160, 240, 320, 400];
    const info = cardiacPhaseInfo([1, 7], t, 3); // R = 0 と 6（0, 400 ms）
    expect(info.phase?.msSincePrevR).toBe(160);
    expect(info.phase?.rrFraction).toBeCloseTo(0.4, 9);
  });
});
