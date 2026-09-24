import { describe, expect, it } from "vitest";
import type { DsaFramePlanEntry } from "./dsaLoader";
import type { PhaseMaskEntry, PhaseMaskStatus } from "./xaPhaseMask";
import {
  MASK_ORIGINS,
  maskOrigin,
  originColor,
  originCounts,
  phaseBands,
  pairingSeries,
  ZNCC_DOMAIN,
  type MaskOrigin,
} from "./xaDsaPlot";

const entry = (liveFrame: number, maskFrame: number | null, status: PhaseMaskStatus = "ok"): PhaseMaskEntry => ({
  liveFrame,
  maskFrame,
  dx: 0,
  dy: 0,
  amplitudeDiff: 0,
  similarity: null,
  status,
  phaseMaskFrame: null,
  phaseDisagreement: null,
});

const planEntry = (...maskFrames: number[]): DsaFramePlanEntry => ({
  maskImageIds: maskFrames.map((m) => `f${m}`),
  maskFrames: [...maskFrames],
  dx: 0,
  dy: 0,
});

describe("phaseBands — 区切りは帯で出す（専用のグラフを作らないため）", () => {
  it("★ 実機の値（stableFrom 8 / contrastStart 32 / 137 枚）で隙間なく 3 本", () => {
    const bands = phaseBands(8, 32, 137);
    expect(bands.map((b) => b.kind)).toEqual(["ramp", "preContrast", "contrast"]);
    expect(bands.map((b) => [b.from, b.to])).toEqual([[0, 8], [8, 32], [32, 137]]);
    // 隙間も重なりも無いこと。
    for (let i = 1; i < bands.length; i++) expect(bands[i].from).toBe(bands[i - 1].to);
    expect(bands[bands.length - 1].to).toBe(137);
  });

  it("🚨 幅 0 の帯は返さない（凡例にだけ出て中身が無い絵にしない）", () => {
    expect(phaseBands(0, 32, 137).map((b) => b.kind)).toEqual(["preContrast", "contrast"]);
    expect(phaseBands(8, 8, 137).map((b) => b.kind)).toEqual(["ramp", "contrast"]);
    // 造影が 1 枚も無いラン（contrastStart === frameCount）。
    expect(phaseBands(8, 137, 137).map((b) => b.kind)).toEqual(["ramp", "preContrast"]);
  });

  it("境界が壊れていても落ちない", () => {
    expect(phaseBands(0, 0, 0)).toEqual([]);
    expect(phaseBands(-5, 999, 10).map((b) => [b.from, b.to])).toEqual([[0, 10]]);
    // contrastStart < stableFrom は潰して扱う（負の幅を作らない）。
    for (const b of phaseBands(20, 5, 100)) expect(b.to).toBeGreaterThan(b.from);
  });
});

describe("maskOrigin — 「このフレームは何を引いているか」", () => {
  it("★ 計画が無ければ既定マスク", () => {
    expect(maskOrigin(3, entry(3, 18), null)).toBe("default");
    expect(maskOrigin(3, entry(3, 18), { maskImageIds: [], maskFrames: [], dx: 0, dy: 0 })).toBe("default");
  });

  it("★ マスクが自分自身なら self（造影前・差は厳密に 0）", () => {
    expect(maskOrigin(7, entry(7, 7), planEntry(7))).toBe("self");
  });

  it("🚨 計画はあるのに対応付けが無いフレームは filled（順番を間違えると phase に化ける）", () => {
    // 時間方向に隣から埋めたフレーム: plan にはマスクがあるが entries は null。
    expect(maskOrigin(60, entry(60, null, "unreliable"), planEntry(20))).toBe("filled");
    expect(maskOrigin(60, null, planEntry(20))).toBe("filled");
  });

  it("★ 振幅の端へ丸めたものは clamped", () => {
    expect(maskOrigin(60, entry(60, 31, "clamped"), planEntry(31))).toBe("clamped");
  });

  it("それ以外が本来の同位相マスク", () => {
    expect(maskOrigin(60, entry(60, 24), planEntry(24))).toBe("phase");
    expect(maskOrigin(60, entry(60, 24, "directionRelaxed"), planEntry(24))).toBe("phase");
  });

  it("🔴 ★ すべての出自に色がある（網羅）", () => {
    const seen = new Set<string>();
    for (const o of MASK_ORIGINS) {
      const c = originColor(o);
      expect(c).toMatch(/^#[0-9a-f]{6}$/i);
      seen.add(c);
    }
    // 色が重複していたら画面で区別できない。
    expect(seen.size).toBe(MASK_ORIGINS.length);
  });

  it("MASK_ORIGINS が MaskOrigin を漏れなく並べている", () => {
    const all: MaskOrigin[] = ["self", "phase", "clamped", "filled", "default"];
    expect([...MASK_ORIGINS].sort()).toEqual([...all].sort());
  });
});

describe("pairingSeries — 何を引いているかの系列", () => {
  const frameCount = 6;
  const plan: (DsaFramePlanEntry | null)[] = [
    planEntry(0),          // self
    planEntry(1),          // self
    null,                  // default（計画の穴）
    planEntry(0, 1, 2),    // default 相当（平均マスク）
    planEntry(1),          // phase
    planEntry(1),          // filled（entries が null）
  ];
  const entries: PhaseMaskEntry[] = [
    entry(0, 0), entry(1, 1), entry(2, null), entry(3, 2), entry(4, 1), entry(5, null),
  ];

  it("🔴 ★ 平均マスク（複数フレーム）は NaN にして線を切る", () => {
    const { values } = pairingSeries(entries, plan, frameCount);
    expect(values[0]).toBe(0);
    expect(values[1]).toBe(1);
    expect(Number.isNaN(values[2])).toBe(true); // 計画なし
    expect(Number.isNaN(values[3])).toBe(true); // 平均マスク＝1 枚の番号に決められない
    expect(values[4]).toBe(1);
  });

  it("★ 出自が色に対応している", () => {
    const { origins, colors } = pairingSeries(entries, plan, frameCount);
    // idx3 は平均マスク（複数フレーム）。計画から来ているので phase 扱い、値だけ NaN。
    expect(origins).toEqual(["self", "self", "default", "phase", "phase", "filled"]);
    expect(colors[0]).toBe(originColor("self"));
    expect(colors[5]).toBe(originColor("filled"));
  });

  it("長さは必ずフレーム数と一致する（診断が無くても）", () => {
    for (const r of [pairingSeries(null, null, frameCount), pairingSeries(entries, plan, frameCount)]) {
      expect(r.values).toHaveLength(frameCount);
      expect(r.colors).toHaveLength(frameCount);
      expect(r.origins).toHaveLength(frameCount);
    }
    // 診断が無ければ全部 default。
    expect(pairingSeries(null, null, frameCount).origins.every((o) => o === "default")).toBe(true);
  });

  it("originCounts が全部の出自を数える（合計＝フレーム数）", () => {
    const { origins } = pairingSeries(entries, plan, frameCount);
    const c = originCounts(origins);
    expect(c).toEqual({ self: 2, phase: 2, clamped: 0, filled: 1, default: 1 });
    expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe(frameCount);
  });
});

describe("ZNCC_DOMAIN", () => {
  it("🔑 0..1 に固定する（自動スケールだと 0.90〜0.95 が画面いっぱいになる）", () => {
    expect(ZNCC_DOMAIN).toEqual({ lo: 0, hi: 1 });
  });
});
