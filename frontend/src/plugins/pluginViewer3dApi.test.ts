import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildViewer3dContext, nextViewer3dSeq, openViewer3dFromPlugin, validateViewer3dSpec, type PluginViewer3dSpec, type Viewer3dTileInfo } from "./pluginViewer3dApi";

const STUDY = { studyInstanceUid: "1.2.3" } as never;
const SERIES = { seriesInstanceUid: "1.2.3.4" } as never;
const tile = (over: Partial<Viewer3dTileInfo> = {}): Viewer3dTileInfo => ({ study: STUDY, series: SERIES, c: 0, t: 0, ...over });
const resolver = (t: Viewer3dTileInfo | undefined = tile()) => (uid: string) => (uid === "1.2.3.4" ? t : undefined);
const spec = (over: Partial<PluginViewer3dSpec> = {}): PluginViewer3dSpec => ({ source: { seriesUid: "1.2.3.4" }, ...over });
const D = [1 / 3, 2 / 3, -2 / 3] as [number, number, number];
const near = (a: readonly number[] | null, b: readonly number[], tol = 1e-9) => {
  expect(a).not.toBeNull();
  a!.forEach((x, i) => expect(Math.abs(x - b[i])).toBeLessThan(tol));
};
const PROD = { id: "viewer3d-probe", name: "Probe Plugin", version: "0.0.1" };

describe("validateViewer3dSpec: 正例", () => {
  it("camera の値を正規化・直交化して applied に返す（斜めの向き）", () => {
    const v = validateViewer3dSpec(spec({ camera: { direction: [1, 2, -2], up: [0, 0, 1], focalPoint: [1, 2, 3] } }), resolver());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    near(v.applied.direction, D);
    // 上は視線に直交し、右 = 視線 × 上
    const up = v.applied.up!;
    expect(Math.abs(up[0] * D[0] + up[1] * D[1] + up[2] * D[2])).toBeLessThan(1e-9);
    const right = v.applied.right!;
    near(right, [D[1] * up[2] - D[2] * up[1], D[2] * up[0] - D[0] * up[2], D[0] * up[1] - D[1] * up[0]]);
    near(v.applied.focalPoint, [1, 2, 3]);
  });
  it("focalPoint 省略時は最初のクリップ面の原点、それも無ければ null", () => {
    const a = validateViewer3dSpec(spec({ camera: { direction: [0, 0, 1], up: [0, -1, 0] }, clipPlanes: [{ origin: [5, 6, 7], normal: [0, 0, 2] }] }), resolver());
    expect(a.ok && a.applied.focalPoint).toEqual([5, 6, 7]);
    const b = validateViewer3dSpec(spec({ camera: { direction: [0, 0, 1], up: [0, -1, 0] } }), resolver());
    expect(b.ok && b.applied.focalPoint).toBeNull();
  });
  it("クリップ面は法線を正規化して返し、残す側（向き）は変えない。[] は ok", () => {
    const v = validateViewer3dSpec(spec({ clipPlanes: [{ origin: [0, 0, 0], normal: [0, 0, -4], label: "面" }] }), resolver());
    expect(v.ok && v.applied.clipPlanes[0]).toEqual({ origin: [0, 0, 0], normal: [0, 0, -1], label: "面" });
    expect(validateViewer3dSpec(spec({ clipPlanes: [] }), resolver()).ok).toBe(true);
  });
  it("何も指定しなくても（普通に 3D を開く）ok", () => {
    expect(validateViewer3dSpec(spec(), resolver()).ok).toBe(true);
  });
  it("mode は VR / MIP / MINIP", () => {
    for (const mode of ["VR", "MIP", "MINIP"] as const) expect(validateViewer3dSpec(spec({ mode }), resolver()).ok).toBe(true);
  });
});

describe("validateViewer3dSpec: 負例（理由つきで拒否）", () => {
  const cam = { direction: [0, 0, 1] as [number, number, number], up: [0, -1, 0] as [number, number, number] };
  const bad: [string, PluginViewer3dSpec][] = [
    ["seriesUid なし", { source: { seriesUid: "" } }],
    ["開いていないシリーズ", { source: { seriesUid: "9.9.9" } }],
    ["studyUid の不一致", { source: { seriesUid: "1.2.3.4", studyUid: "other" } }],
    ["視線 0", spec({ camera: { ...cam, direction: [0, 0, 0] } })],
    ["視線 NaN", spec({ camera: { ...cam, direction: [NaN, 0, 1] } })],
    ["上が視線と平行", spec({ camera: { ...cam, up: [0, 0, 3] } })],
    ["上が 0", spec({ camera: { ...cam, up: [0, 0, 0] } })],
    ["distanceMm 0", spec({ camera: { ...cam, distanceMm: 0 } })],
    ["parallelScaleMm 負", spec({ camera: { ...cam, parallelScaleMm: -1 } })],
    ["projection 不正", spec({ camera: { ...cam, projection: "ortho" as never } })],
    ["focalPoint 非有限", spec({ camera: { ...cam, focalPoint: [0, Infinity, 0] } })],
    ["法線 0", spec({ clipPlanes: [{ origin: [0, 0, 0], normal: [0, 0, 0] }] })],
    ["法線 NaN", spec({ clipPlanes: [{ origin: [0, 0, 0], normal: [NaN, 0, 1] }] })],
    ["面 7 枚", spec({ clipPlanes: Array.from({ length: 7 }, () => ({ origin: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number] })) })],
    ["mode ORTHO", spec({ mode: "ORTHO" as never })],
    ["mode SLAB", spec({ mode: "SLAB" as never })],
    ["preset 空", spec({ preset: "  " })],
    ["title が長すぎる", spec({ title: "x".repeat(201) })],
  ];
  for (const [label, s] of bad) {
    it(`${label} → ok:false`, () => {
      const v = validateViewer3dSpec(s, resolver());
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.error.length).toBeGreaterThan(0);
    });
  }
  it("一時シリーズ・連結タイルは拒否", () => {
    expect(validateViewer3dSpec(spec(), resolver(tile({ transient: true }))).ok).toBe(false);
    expect(validateViewer3dSpec(spec(), resolver(tile({ concat: true }))).ok).toBe(false);
  });
});

describe("buildViewer3dContext / seq", () => {
  it("出所は host が入れる（spec に偽の provenance があっても使わない）", () => {
    const s = { ...spec({ title: "検査", camera: { direction: [0, 0, 1], up: [0, -1, 0] } }), provenance: { pluginName: "偽物" } } as PluginViewer3dSpec;
    const ctx = buildViewer3dContext(tile(), s, PROD, 5, 100);
    expect(ctx.pluginView.provenance).toEqual({ pluginId: "viewer3d-probe", pluginName: "Probe Plugin", pluginVersion: "0.0.1", title: "検査" });
    expect(JSON.stringify(ctx)).not.toContain("偽物");
  });
  it("省略したフィールドは pluginView に入れない（窓は「変えない」と読む）", () => {
    const ctx = buildViewer3dContext(tile(), spec({ mode: "MIP" }), PROD, 1);
    expect(Object.keys(ctx.pluginView).sort()).toEqual(["mode", "provenance", "seq"]);
    const withClip = buildViewer3dContext(tile(), spec({ clipPlanes: [] }), PROD, 1);
    expect(withClip.pluginView.clipPlanes).toEqual([]); // [] は「全部消す」なので入る
  });
  it("range・c・t を引き継ぐ（spec.source が省略したらタイルの表示中）", () => {
    const ctx = buildViewer3dContext(tile({ c: 2, t: 3, range: { z0: 5, z1: 20 } as never }), spec(), PROD, 1);
    expect([ctx.c, ctx.t]).toEqual([2, 3]);
    expect(ctx.range).toEqual({ z0: 5, z1: 20 });
    expect(buildViewer3dContext(tile({ c: 2, t: 3 }), { source: { seriesUid: "1.2.3.4", c: 1, t: 0 } }, PROD, 1).c).toBe(1);
  });
  it("seq は単調増加（同じ時刻でも増える）", () => {
    const a = nextViewer3dSeq(1000);
    const b = nextViewer3dSeq(1000);
    const c = nextViewer3dSeq(500);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});

describe("openViewer3dFromPlugin", () => {
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal("localStorage", { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } });
    vi.stubGlobal("BroadcastChannel", class { postMessage() {} close() {} });
    vi.stubGlobal("window", { open: vi.fn(), location: { pathname: "/" } });
  });
  it("負例は何も書かず・窓も開かない", async () => {
    const r = await openViewer3dFromPlugin(spec({ mode: "ORTHO" as never }), PROD, resolver());
    expect(r.ok).toBe(false);
    expect(Object.keys(store)).toEqual([]);
    expect((window.open as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
  it("正例は ctx を書き、窓を開き、applied を返す", async () => {
    const r = await openViewer3dFromPlugin(spec({ title: "T", camera: { direction: [0, 0, 1], up: [0, -1, 0] } }), PROD, resolver());
    expect(r.ok).toBe(true);
    expect(r.applied?.direction).toEqual([0, 0, 1]);
    const ctx = JSON.parse(store["graphy-viewer3d-ctx"]);
    expect(ctx.pluginView.provenance.pluginName).toBe("Probe Plugin");
    expect((window.open as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
