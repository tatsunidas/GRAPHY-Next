import { describe, expect, it, beforeEach } from "vitest";
import { toPluginRois3d, readRois3d, subscribeRois3d } from "./roiRead3d";
import { addRoi3d, addMeasure3d, updateMeasure3d, removeRoi3d, clearRoi3d, clearMeasure3d } from "./roiLedger";

describe("toPluginRois3d", () => {
  it("箱 40×30×20 mm は 24 mL、球 r=10 は (4/3)π·1000 mm³", () => {
    const [box, sph] = toPluginRois3d(
      [
        { id: "b", shape: "box", center: [1, 2, 3], size: [40, 30, 20] },
        { id: "s", shape: "ellipsoid", center: [0, 0, 0], size: [20, 20, 20] },
      ],
      [],
    );
    expect(box.kind === "solid" && box.volumeMl).toBeCloseTo(24, 12);
    expect(sph.kind === "solid" && sph.volumeMl).toBeCloseTo(((4 / 3) * Math.PI * 1000) / 1000, 12);
  });
  it("3-4-5 の定規は 50 mm、未設定のメタは null、visible:false も返す", () => {
    const [r] = toPluginRois3d([], [{ id: "m", a: [0, 0, 0], b: [30, 40, 0], visible: false }]);
    expect(r.kind).toBe("ruler3d");
    if (r.kind === "ruler3d") expect(r.distanceMm).toBe(50);
    expect(r.visible).toBe(false);
    expect(r.patientKey).toBeNull();
    expect(r.label).toBeNull();
  });
  it("返す座標は台帳の配列と別物（書き換えても台帳に届かない）", () => {
    const src = { id: "b", shape: "box" as const, center: [1, 2, 3] as [number, number, number], size: [4, 5, 6] as [number, number, number] };
    const [o] = toPluginRois3d([src], []);
    if (o.kind === "solid") o.center[0] = 99;
    expect(src.center[0]).toBe(1);
  });
});

describe("台帳との接続", () => {
  beforeEach(() => {
    clearRoi3d();
    clearMeasure3d();
  });
  it("readRois3d は台帳の現在値、購読は solid と定規の両方で発火し解除後は発火しない", () => {
    let n = 0;
    const off = subscribeRois3d(() => n++);
    addRoi3d({ id: "b", shape: "box", center: [0, 0, 0], size: [1, 1, 1] });
    const a = n;
    expect(a).toBeGreaterThan(0);
    addMeasure3d({ id: "m", a: [0, 0, 0], b: [0, 0, 3] });
    expect(n).toBeGreaterThan(a);
    expect(readRois3d().map((r) => r.id).sort()).toEqual(["b", "m"]);
    updateMeasure3d({ id: "m", a: [0, 0, 0], b: [0, 0, 5] });
    const m = readRois3d().find((r) => r.id === "m");
    expect(m && m.kind === "ruler3d" && m.distanceMm).toBe(5);
    off();
    const before = n;
    removeRoi3d("b");
    updateMeasure3d({ id: "m", a: [0, 0, 0], b: [0, 0, 9] });
    expect(n).toBe(before);
  });
  it("リスナーの例外は握る", () => {
    const off = subscribeRois3d(() => {
      throw new Error("x");
    });
    expect(() => addRoi3d({ id: "e", shape: "box", center: [0, 0, 0], size: [1, 1, 1] })).not.toThrow();
    off();
  });
});
