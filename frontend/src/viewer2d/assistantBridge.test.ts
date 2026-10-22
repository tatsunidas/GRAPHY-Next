import { describe, expect, it } from "vitest";
import { executeCommand, type BridgeDeps } from "./assistantBridge";
import { buildTools, projectState, validateAction, validateProposal } from "../assistant/actions/registry";

function makeDeps(over: Partial<BridgeDeps> = {}) {
  const calls: string[] = [];
  const cmds = new Proxy({}, { get: (_t, k) => (...a: unknown[]) => calls.push(`${String(k)}(${a.join(",")})`) });
  const deps: BridgeDeps = {
    targets: () => ["t1"],
    allTiles: () => ["t1", "t2"],
    readInfo: () =>
      ({ sliceIndex: 7, sliceCount: 50, modality: "CT", patientKey: "PID123", studyUid: "1.2.3", seriesUid: "1.2.4", imageId: "wadouri:http://x/1.2.3", apiBase: "http://localhost:1", seriesLabel: "TARO YAMADA CT" }) as never,
    readView: () => ({ windowCenter: 40, windowWidth: 400, unit: "HU", colormap: null, invert: false, flipH: false, flipV: false, rotation: 0, zoom: 1 }) as never,
    run: (_ids, fn) => fn(cmds as never),
    runSeries: (_ids, fn) => fn({ goTo: (d: unknown) => calls.push(`goTo(${JSON.stringify(d)})`) } as never),
    activeTool: () => "WindowLevel",
    layoutCols: () => 2,
    setTool: (t) => calls.push(`setTool(${t})`),
    setLayoutCols: (n) => calls.push(`setLayoutCols(${n})`),
    presets: () => [{ key: "lung", label: "肺野", center: -600, width: 1500 }],
    toolId: (s) => (s === "windowLevel" ? "WindowLevel" : s === "pan" ? "Pan" : s),
    ...over,
  };
  return { deps, calls };
}

describe("validateAction", () => {
  it("accepts in-range values", () => {
    expect(validateAction("setWindowLevel", { center: 40, width: 400 }).ok).toBe(true);
    expect(validateAction("goToSlice", { index: 0 }).ok).toBe(true);
    expect(validateAction("rotate90", {}).ok).toBe(true);
  });
  it("rejects NaN, out of range, wrong types, unknown keys and ids", () => {
    for (const [id, a] of [
      ["setWindowLevel", { center: NaN, width: 400 }],
      ["setWindowLevel", { center: 40, width: 0 }],
      ["setWindowLevel", { center: 40, width: Infinity }],
      ["setWindowLevel", { center: "40", width: 400 }],
      ["setWindowLevel", { center: 40 }],
      ["goToSlice", { index: 1.5 }],
      ["goToSlice", { index: -1 }],
      ["setLayout", { cols: 9 }],
      ["setTool", { tool: "brush" }],
      ["rotate90", { times: 4 }],
      ["flipH", { extra: 1 }],
    ] as const) expect(validateAction(id, a).ok, `${id} ${JSON.stringify(a)}`).toBe(false);
  });
  it("data-changing ids are not in the registry", () => {
    for (const id of ["saveSegmentation", "clearRois", "clearMeasurements", "saveDerivedSeries", "deleteStudy", "getState", "fit", "__proto__"])
      expect(validateAction(id, {})).toEqual({ ok: false, error: "unknown-action" });
  });
  it("tools list has every action plus getState and propose_steps, with valid names", () => {
    const names = buildTools().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["getState", "propose_steps", "setWindowLevel", "goToSlice"]));
    expect(names.every((n) => /^[A-Za-z0-9_-]{1,64}$/.test(n))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });
  it("validateProposal", () => {
    expect(validateProposal({ title: "t", steps: ["a"] }).ok).toBe(true);
    expect(validateProposal({ title: "", steps: ["a"] }).ok).toBe(false);
    expect(validateProposal({ title: "t", steps: [] }).ok).toBe(false);
    expect(validateProposal({ title: "t", steps: [1] }).ok).toBe(false);
  });
});

describe("projectState (PHI allow-list)", () => {
  const { deps } = makeDeps();
  const state = (labels: boolean) => {
    const r = executeCommand(deps, { kind: "getState", includeLabels: labels });
    expect(r.ok).toBe(true);
    return (r as { state: Record<string, unknown> }).state;
  };
  it("never contains identifiers", () => {
    const s = JSON.stringify(state(true));
    for (const secret of ["PID123", "1.2.3", "1.2.4", "wadouri", "localhost", "patientKey", "studyUid", "apiBase"]) expect(s).not.toContain(secret);
  });
  it("seriesLabel only for local", () => {
    expect(JSON.stringify(state(false))).not.toContain("YAMADA");
    expect(JSON.stringify(state(true))).toContain("YAMADA");
  });
  it("ignores unknown extra keys on a tile", () => {
    const s = projectState({ tiles: [{ modality: "CT", patientName: "X", studyUid: "9" }] }, { includeLabels: true });
    expect(JSON.stringify(s)).not.toMatch(/patientName|studyUid|"9"/);
  });
  it("tiles are ordinals", () => {
    expect((state(false).tiles as { tile: string }[]).map((t) => t.tile)).toEqual(["tile1", "tile2"]);
  });
});

describe("executeCommand", () => {
  it("setWindowLevel runs and returns an inverse with previous values", () => {
    const { deps, calls } = makeDeps();
    const r = executeCommand(deps, { kind: "action", id: "setWindowLevel", params: { center: 100, width: 200 } });
    expect(calls).toContain("setWindowLevel(100,200)");
    expect(r).toEqual({ ok: true, inverse: [{ id: "setWindowLevel", params: { center: 40, width: 400 } }] });
  });
  it("invalid args do not touch the viewer", () => {
    const { deps, calls } = makeDeps();
    const r = executeCommand(deps, { kind: "action", id: "setWindowLevel", params: { center: 0, width: -5 } });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });
  it("unknown / data ids are refused without calling", () => {
    const { deps, calls } = makeDeps();
    expect(executeCommand(deps, { kind: "action", id: "clearRois" }).ok).toBe(false);
    expect(calls).toEqual([]);
  });
  it("preset by key and by label; unknown preset refused", () => {
    const a = makeDeps();
    expect(executeCommand(a.deps, { kind: "action", id: "applyWlPreset", params: { name: "LUNG" } }).ok).toBe(true);
    expect(a.calls).toContain("setWindowLevel(-600,1500)");
    const b = makeDeps();
    expect(executeCommand(b.deps, { kind: "action", id: "applyWlPreset", params: { name: "肺野" } }).ok).toBe(true);
    const c = makeDeps();
    expect(executeCommand(c.deps, { kind: "action", id: "applyWlPreset", params: { name: "nope" } })).toEqual({ ok: false, error: "unknown-preset" });
    expect(c.calls).toEqual([]);
  });
  it("rotate90 times:n inverts with 4-n", () => {
    const { deps, calls } = makeDeps();
    const r = executeCommand(deps, { kind: "action", id: "rotate90", params: { times: 3 } });
    expect(calls.filter((c) => c.startsWith("rotate90")).length).toBe(3);
    expect(r).toMatchObject({ inverse: [{ id: "rotate90", params: { times: 1 } }] });
  });
  it("goToSlice inverse returns to the previous slice", () => {
    const { deps, calls } = makeDeps();
    const r = executeCommand(deps, { kind: "action", id: "goToSlice", params: { index: 20 } });
    expect(calls).toContain('goTo({"z":20})');
    expect(r).toMatchObject({ inverse: [{ id: "goToSlice", params: { index: 7 } }] });
  });
  it("setTool: inverse only when the previous tool is a display tool", () => {
    const a = makeDeps();
    expect(executeCommand(a.deps, { kind: "action", id: "setTool", params: { tool: "pan" } })).toMatchObject({ inverse: [{ id: "setTool", params: { tool: "windowLevel" } }] });
    const b = makeDeps({ activeTool: () => "Brush" });
    const r = executeCommand(b.deps, { kind: "action", id: "setTool", params: { tool: "pan" } });
    expect(r).toEqual({ ok: true, inverse: undefined });
  });
  it("no tiles → no-tile", () => {
    const { deps } = makeDeps({ targets: () => [] });
    expect(executeCommand(deps, { kind: "action", id: "flipH" })).toEqual({ ok: false, error: "no-tile" });
  });
});
