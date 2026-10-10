import { describe, expect, it } from "vitest";
import { accumulateMaskStats, meanTimesVolumeLabelKey } from "./maskStatsCore";

const close = (a: number, b: number) => expect(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b))).toBe(true);

// 旧 maskVolumeStats のループ式を写した参照実装。
function legacy(slices: { labels: number[]; values: number[] }[], seg?: number) {
  let sum = 0, sumSq = 0, n = 0;
  for (const s of slices)
    s.labels.forEach((l, i) => {
      if (l <= 0 || (seg != null && l !== seg)) return;
      sum += s.values[i]; sumSq += s.values[i] ** 2; n++;
    });
  const mean = sum / n;
  return { mean, sd: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
}

const S = [
  { labels: [1, 0, 1, 2], values: [1, 100, 3, 10] },
  { labels: [0, 0, 0, 0], values: [5, 5, 5, 5] },
  { labels: [1, 1, 0, 2], values: [2, 4, 100, 20] },
];

describe("accumulateMaskStats", () => {
  it("全スライスあり: 手計算と一致", () => {
    const r = accumulateMaskStats(S);
    expect(r.voxels).toBe(6);
    expect(r.slices).toBe(2);
    expect(r.valuedVoxels).toBe(6);
    expect(r.missingValueSlices).toBe(0);
    close(r.mean!, (1 + 3 + 10 + 2 + 4 + 20) / 6);
    expect(r.min).toBe(1);
    expect(r.max).toBe(20);
  });

  it("旧式と平均・SD の差が 0", () => {
    const r = accumulateMaskStats(S);
    const l = legacy(S);
    expect(r.mean).toBe(l.mean);
    expect(r.sd).toBe(l.sd);
  });

  it("segmentIndex 指定でその segment だけ数える", () => {
    const r = accumulateMaskStats(S, 2);
    expect(r.voxels).toBe(2);
    close(r.mean!, 15);
    expect(r.min).toBe(10);
  });

  it("平均×体積 = mean × volumeMl", () => {
    const r = accumulateMaskStats(S, 1);
    const volumeMl = (r.voxels * 8) / 1000;
    close(r.mean! * volumeMl, ((1 + 3 + 2 + 4) / 4) * volumeMl);
  });

  it("前景 0 ボクセル: 値の統計なし", () => {
    const r = accumulateMaskStats([{ labels: [0, 0], values: [1, 2] }]);
    expect(r.voxels).toBe(0);
    expect(r.mean).toBeUndefined();
  });

  it("ラベルが負・0 は数えない", () => {
    const r = accumulateMaskStats([{ labels: [-1, 0, 1], values: [9, 9, 7] }]);
    expect(r.voxels).toBe(1);
    expect(r.mean).toBe(7);
  });
});

describe("meanTimesVolumeLabelKey", () => {
  it("SUV 系は TLG", () => {
    expect(meanTimesVolumeLabelKey("SUVbw")).toBe("roiMgr.statTlg");
    expect(meanTimesVolumeLabelKey("SUVlbm")).toBe("roiMgr.statTlg");
  });
  it("SUV 以外は行を出さない", () => {
    for (const u of ["HU", "Bq/ml", "raw", "", undefined]) expect(meanTimesVolumeLabelKey(u)).toBeNull();
  });
});
