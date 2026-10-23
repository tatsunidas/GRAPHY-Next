import { describe, expect, it } from "vitest";
import type { SeriesLayout } from "../viewer/seriesLayout";
import { resolveOpenRange } from "./openRangeInput";

/** 300 枚・1 mm 間隔・法線 +z の合成レイアウト（withIpp=false なら IPP なし）。 */
function synth(n = 300, withIpp = true): SeriesLayout {
  const ids = Array.from({ length: n }, (_, i) => `s${i}`);
  return {
    nZ: n, nC: 1, nT: 1,
    zStack: () => ids,
    normal: withIpp ? [0, 0, 1] : undefined,
    ippAt: withIpp ? (z: number) => [0, 0, z] : undefined,
  } as unknown as SeriesLayout;
}

describe("resolveOpenRange", () => {
  it("番号 101-200 は 100 枚で、位置 100〜199 mm の区間になる", () => {
    const r = resolveOpenRange(synth(), { method: "index", text: "101-200" });
    expect(r).toEqual({ ok: true, range: { kind: "mm", fromMm: 100, toMm: 199 }, count: 100 });
  });
  it("mm 100.0〜199.0 でも同じ区間・100 枚", () => {
    const r = resolveOpenRange(synth(), { method: "mm", fromMm: "100.0", toMm: "199.0" });
    expect(r).toEqual({ ok: true, range: { kind: "mm", fromMm: 100, toMm: 199 }, count: 100 });
  });
  it("IPP が無いシリーズの番号指定は番号のまま持つ", () => {
    const r = resolveOpenRange(synth(300, false), { method: "index", text: "101-200" });
    expect(r).toEqual({ ok: true, range: { kind: "index", from: 100, to: 199 }, count: 100 });
  });
  it.each([
    ["abc", "unreadable"],
    ["500-600", "outOfRange"],
    ["1-5, 8", "notContiguous"],
    ["", "empty"],
  ])("番号 %j は断る (%s)", (text, reason) => {
    const r = resolveOpenRange(synth(), { method: "index", text });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });
  it("IPP が無いと mm 指定は断る", () => {
    const r = resolveOpenRange(synth(300, false), { method: "mm", fromMm: "0", toMm: "10" });
    expect(r).toMatchObject({ ok: false, reason: "noIpp" });
  });
  it("mm が範囲外・読めないは断る", () => {
    expect(resolveOpenRange(synth(), { method: "mm", fromMm: "1000", toMm: "2000" })).toMatchObject({ ok: false, reason: "outOfRange" });
    expect(resolveOpenRange(synth(), { method: "mm", fromMm: "x", toMm: "2" })).toMatchObject({ ok: false, reason: "unreadable" });
  });
});
