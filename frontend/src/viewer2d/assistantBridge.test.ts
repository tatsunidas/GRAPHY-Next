import { describe, expect, it } from "vitest";
import { executeCaptureView, executeCommand, type BridgeDeps } from "./assistantBridge";
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
    readRois: () => [],
    captureTile: async () => null,
    run: (_ids, fn) => fn(cmds as never),
    runSeries: (_ids, fn) => fn({ goTo: (d: unknown) => calls.push(`goTo(${JSON.stringify(d)})`) } as never),
    activeTool: () => "WindowLevel",
    layoutCols: () => 2,
    setTool: (t) => calls.push(`setTool(${t})`),
    setLayoutCols: (n) => calls.push(`setLayoutCols(${n})`),
    presets: () => [{ key: "lung", label: "肺野", center: -600, width: 1500 }],
    toolId: (s) => (s === "windowLevel" ? "WindowLevel" : s === "pan" ? "Pan" : s),
    createRoi: (id, req) => {
      calls.push(`createRoi(${id},${JSON.stringify(req)})`);
      return { ok: true, roiUid: "uid-1", centerLps: [0, 0, 0] };
    },
    removeAssistantRoi: (uid) => {
      calls.push(`removeAssistantRoi(${uid})`);
      return uid === "uid-1";
    },
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
  it("data-changing ids are not in the registry (clearMeasurements は effect:write として別に入れた。承認が要る)", () => {
    for (const id of ["saveSegmentation", "clearRois", "saveDerivedSeries", "deleteStudy", "getState", "fit", "__proto__"])
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

describe("getMeasurements (PHI allow-list)", () => {
  const roi = (over: Record<string, unknown> = {}) => ({
    tileIndex: 1,
    roiUid: "UID-SECRET-1",
    patientKey: "PID123",
    studyUid: "1.2.3.STUDY",
    seriesUid: "1.2.4.SERIES",
    sopInstanceUid: "1.2.5.SOP",
    studyDate: "2026-01-02",
    points: [[10.5, 20.5]],
    spacing: [0.7, 0.7],
    tool: "EllipticalROI",
    label: "TARO YAMADA liver",
    sliceIndex: 12,
    visible: true,
    zScope: 12,
    measurements: { area: 123.4, mean: 55.5, stdDev: 6.1, min: 10, max: 99, unit: "HU", longAxisMm: 14.2, shortAxisMm: 9.9, hidden: "X" },
    ...over,
  });
  const run = (rois: unknown[], labels = false) => {
    const { deps } = makeDeps({ readRois: () => rois as never });
    const r = executeCommand(deps, { kind: "getMeasurements", includeLabels: labels });
    expect(r.ok).toBe(true);
    return (r as unknown as { measurements: { rois: Record<string, unknown>[]; truncated?: boolean } }).measurements;
  };
  it("passes the values the viewer shows", () => {
    expect(run([roi()]).rois[0]).toEqual({
      roi: "roi1", tile: "tile2", tool: "EllipticalROI", sliceIndex: 12, visible: true,
      areaMm2: 123.4, mean: 55.5, stdDev: 6.1, min: 10, max: 99, unit: "HU", longAxisMm: 14.2, shortAxisMm: 9.9,
    });
  });
  it("never contains identifiers, coordinates or unknown fields", () => {
    const s = JSON.stringify(run([roi()], false));
    for (const secret of ["UID-SECRET", "PID123", "STUDY", "SERIES", "SOP", "2026-01-02", "10.5", "0.7", "YAMADA", "hidden", "zScope"]) expect(s).not.toContain(secret);
  });
  it("label only for local", () => {
    expect(JSON.stringify(run([roi()], true))).toContain("YAMADA");
    expect(JSON.stringify(run([roi()], false))).not.toContain("YAMADA");
  });
  it("omits missing values instead of filling them", () => {
    const r = run([roi({ measurements: { mean: 3, unit: "HU", area: undefined, stdDev: NaN } })]).rois[0];
    expect(r).not.toHaveProperty("areaMm2");
    expect(r).not.toHaveProperty("stdDev");
    expect(r.mean).toBe(3);
  });
  it("flags an uncalibrated (raw) unit", () => {
    expect(run([roi({ measurements: { mean: 3, unit: "raw" } })]).rois[0].calibrated).toBe(false);
    expect(run([roi()]).rois[0]).not.toHaveProperty("calibrated");
  });
  it("caps at 50 and reports truncation; empty is an empty list", () => {
    const m = run(Array.from({ length: 51 }, () => roi()));
    expect(m.rois).toHaveLength(50);
    expect(m.truncated).toBe(true);
    expect(run([])).toEqual({ rois: [] });
  });
  it("is not an action and does not touch the viewer", () => {
    const { deps, calls } = makeDeps({ readRois: () => [roi()] as never });
    expect(validateAction("getMeasurements", {}).ok).toBe(false);
    executeCommand(deps, { kind: "getMeasurements" });
    expect(calls).toEqual([]);
    expect(buildTools().map((t) => t.name)).toContain("getMeasurements");
  });
});

describe("executeCaptureView", () => {
  const img = { dataUrl: "data:image/png;base64,AAAA", mimeType: "image/png" as const, w: 8, h: 8 };
  const mk = (over: Partial<BridgeDeps> = {}) => {
    const calls: Array<[string, boolean]> = [];
    const { deps } = makeDeps({
      targets: () => ["tileB"],
      allTiles: () => ["tileA", "tileB"],
      captureTile: async (id, withRoi) => {
        calls.push([id, withRoi]);
        return img;
      },
      ...over,
    });
    return { deps, calls };
  };

  it("captures the selected tile, with or without ROIs", async () => {
    const { deps, calls } = mk();
    expect(await executeCaptureView(deps, { kind: "captureView", withRoi: true })).toEqual({ ok: true, image: img });
    expect(await executeCaptureView(deps, { kind: "captureView" })).toEqual({ ok: true, image: img });
    expect(await executeCaptureView(deps, { kind: "captureView", withRoi: "yes" as unknown as boolean })).toEqual({ ok: true, image: img });
    expect(calls).toEqual([["tileB", true], ["tileB", false], ["tileB", false]]);
  });

  it("falls back to the first tile when nothing is selected", async () => {
    const { deps, calls } = mk({ targets: () => [] });
    await executeCaptureView(deps, { kind: "captureView" });
    expect(calls[0][0]).toBe("tileA");
  });

  it("reports no-tile without tiles and capture-failed when the capture fails or throws", async () => {
    expect(await executeCaptureView(mk({ targets: () => [], allTiles: () => [] }).deps, { kind: "captureView" })).toEqual({ ok: false, error: "no-tile" });
    expect(await executeCaptureView(mk({ captureTile: async () => null }).deps, { kind: "captureView" })).toEqual({ ok: false, error: "capture-failed" });
    expect(
      await executeCaptureView(mk({ captureTile: async () => { throw new Error("gl"); } }).deps, { kind: "captureView" }),
    ).toEqual({ ok: false, error: "capture-failed" });
  });

  it("is not reachable through the model-facing action path", () => {
    const { deps } = mk();
    expect(executeCommand(deps, { kind: "action", id: "captureView" })).toEqual({ ok: false, error: "unknown-action" });
  });
});

describe("createRoi / removeAssistantRoi", () => {
  const ok = { shape: "ellipse", u: 0.25, v: 0.75, radiusXmm: 20, radiusYmm: 10 };
  it("未承認は実行しない（deps を呼ばない）", () => {
    const { deps, calls } = makeDeps();
    expect(executeCommand(deps, { kind: "action", id: "createRoi", params: ok })).toEqual({ ok: false, error: "approval-required" });
    expect(executeCommand(deps, { kind: "action", id: "createRoi", params: ok, approved: false })).toEqual({ ok: false, error: "approval-required" });
    expect(calls.filter((c) => c.startsWith("createRoi"))).toEqual([]);
  });
  it("承認つきで 1 回だけ作り、取り消し用の inverse を返す", () => {
    const { deps, calls } = makeDeps();
    const r = executeCommand(deps, { kind: "action", id: "createRoi", params: ok, approved: true });
    expect(r).toEqual({ ok: true, inverse: [{ id: "removeAssistantRoi", params: { roiUid: "uid-1" } }] });
    expect(calls.filter((c) => c.startsWith("createRoi"))).toEqual([
      'createRoi(t1,{"tool":"EllipticalROI","centerView":[0.25,0.75],"radiiMm":[20,10]})',
    ]);
    executeCommand(deps, { kind: "action", id: "createRoi", params: { ...ok, shape: "rectangle" }, approved: true });
    expect(calls[calls.length - 1]).toContain('"tool":"RectangleROI"');
  });
  it("範囲外・未知キー・NaN は検証で落ちて deps を呼ばない", () => {
    const { deps, calls } = makeDeps();
    for (const p of [
      { ...ok, u: 1.1 }, { ...ok, v: -0.1 }, { ...ok, radiusXmm: 0 }, { ...ok, radiusYmm: 501 }, { ...ok, u: NaN },
      { ...ok, shape: "polygon" }, { ...ok, centerLps: [0, 0, 0] }, { shape: "ellipse", u: 0.5, v: 0.5, radiusXmm: 1 },
    ])
      expect(executeCommand(deps, { kind: "action", id: "createRoi", params: p, approved: true }).ok).toBe(false);
    expect(calls.filter((c) => c.startsWith("createRoi"))).toEqual([]);
  });
  it("作成の失敗理由をそのまま返し、inverse は付けない", () => {
    const { deps } = makeDeps({ createRoi: () => ({ ok: false, reason: "too-large" }) });
    expect(executeCommand(deps, { kind: "action", id: "createRoi", params: ok, approved: true })).toEqual({ ok: false, error: "roi-too-large" });
  });
  it("removeAssistantRoi: 消せない uid（手描き・他者・ロック・無い）は not-removable", () => {
    const { deps } = makeDeps();
    expect(executeCommand(deps, { kind: "action", id: "removeAssistantRoi", params: { roiUid: "uid-1" } })).toEqual({ ok: true, inverse: undefined });
    expect(executeCommand(deps, { kind: "action", id: "removeAssistantRoi", params: { roiUid: "hand-drawn" } })).toEqual({ ok: false, error: "not-removable" });
  });
});

describe("dryRun（main が確認の前に送る検証だけの往復）", () => {
  const ok = { shape: "ellipse", u: 0.5, v: 0.5, radiusXmm: 20, radiusYmm: 10 };
  it("write 操作: 正しい引数なら何も実行せず ok（approved も要らない）", () => {
    const { deps, calls } = makeDeps();
    expect(executeCommand(deps, { kind: "action", id: "createRoi", params: ok, dryRun: true })).toEqual({ ok: true });
    expect(executeCommand(deps, { kind: "action", id: "clearMeasurements", params: {}, dryRun: true })).toEqual({ ok: true });
    expect(calls).toEqual([]);
  });
  it("write 操作: 不正な引数・対象なしは検証のエラーを返す", () => {
    const { deps } = makeDeps();
    expect(executeCommand(deps, { kind: "action", id: "createRoi", params: { ...ok, u: 2 }, dryRun: true })).toEqual({ ok: false, error: "out-of-range:u" });
    const none = makeDeps({ targets: () => [] });
    expect(executeCommand(none.deps, { kind: "action", id: "createRoi", params: ok, dryRun: true })).toEqual({ ok: false, error: "no-tile" });
  });
  it("write 以外に dryRun を付けても実行されず bad-command（表示操作を空振りで成功させない）", () => {
    const { deps, calls } = makeDeps();
    expect(executeCommand(deps, { kind: "action", id: "flipH", params: {}, dryRun: true })).toEqual({ ok: false, error: "bad-command" });
    expect(executeCommand(deps, { kind: "action", id: "setWindowLevel", params: { center: 1, width: 1 }, dryRun: true })).toEqual({ ok: false, error: "bad-command" });
    expect(calls).toEqual([]);
  });
});

describe("createContourRoi（多角形・自由曲線）", () => {
  const sq = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]];
  const ok = { shape: "polygon", points: sq };
  it("未承認は実行しない。承認つきで 1 回作り、割合の頂点をそのまま渡して inverse を返す", () => {
    const { deps, calls } = makeDeps();
    expect(executeCommand(deps, { kind: "action", id: "createContourRoi", params: ok })).toEqual({ ok: false, error: "approval-required" });
    expect(calls.filter((c) => c.startsWith("createRoi"))).toEqual([]);
    const r = executeCommand(deps, { kind: "action", id: "createContourRoi", params: ok, approved: true });
    expect(r).toEqual({ ok: true, inverse: [{ id: "removeAssistantRoi", params: { roiUid: "uid-1" } }] });
    expect(calls.filter((c) => c.startsWith("createRoi"))).toEqual([
      'createRoi(t1,{"tool":"PolygonROI","verticesView":[[0.2,0.2],[0.8,0.2],[0.8,0.8],[0.2,0.8]]})',
    ]);
    executeCommand(deps, { kind: "action", id: "createContourRoi", params: { ...ok, shape: "freehand" }, approved: true });
    expect(calls[calls.length - 1]).toContain('"tool":"FreehandROI"');
  });
  it("負例: 蝶ネクタイ・共線・点数不足/超過・範囲外・非配列・要素数違い・未知キーは検証で落ち、deps を呼ばない", () => {
    const { deps, calls } = makeDeps();
    const many = Array.from({ length: 65 }, (_, i) => [0.1 + (i % 8) * 0.1, 0.1 + Math.floor(i / 8) * 0.1]);
    const cases: [unknown, string][] = [
      [{ ...ok, points: [[0.2, 0.2], [0.8, 0.8], [0.8, 0.2], [0.2, 0.8]] }, "self-intersecting:points"],
      [{ ...ok, points: [[0.1, 0.1], [0.5, 0.5], [0.9, 0.9]] }, "degenerate:points"],
      [{ ...ok, points: [[0.1, 0.1], [0.1, 0.1], [0.5, 0.5], [0.5, 0.5]] }, "degenerate:points"],
      [{ ...ok, points: [[0.1, 0.1], [0.9, 0.9]] }, "out-of-range:points"],
      [{ ...ok, points: many }, "out-of-range:points"],
      [{ ...ok, points: [[0.1, 0.1], [1.1, 0.5], [0.5, 0.9]] }, "out-of-range:points"],
      [{ ...ok, points: [[0.1, 0.1], [NaN, 0.5], [0.5, 0.9]] }, "bad-param:points"],
      [{ ...ok, points: [[0.1, 0.1, 0.2], [0.9, 0.5], [0.5, 0.9]] }, "bad-param:points"],
      [{ ...ok, points: "0.1,0.1" }, "bad-param:points"],
      [{ ...ok, shape: "ellipse" }, "bad-param:shape"],
      [{ ...ok, radiusXmm: 5 }, "unknown-param:radiusXmm"],
      [{ shape: "polygon" }, "missing-param:points"],
    ];
    for (const [p, err] of cases) expect(executeCommand(deps, { kind: "action", id: "createContourRoi", params: p, approved: true }), err).toEqual({ ok: false, error: err });
    expect(calls.filter((c) => c.startsWith("createRoi"))).toEqual([]);
  });
  it("対照: 非凸の L 字は通る（検査が常に落ちているのではない）。dryRun は実行せず ok、不正は同じ理由", () => {
    const { deps, calls } = makeDeps();
    const L = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.4], [0.3, 0.4], [0.3, 0.9], [0.1, 0.9]];
    expect(executeCommand(deps, { kind: "action", id: "createContourRoi", params: { shape: "polygon", points: L }, dryRun: true })).toEqual({ ok: true });
    expect(executeCommand(deps, { kind: "action", id: "createContourRoi", params: { shape: "polygon", points: [[0.2, 0.2], [0.8, 0.8], [0.8, 0.2], [0.2, 0.8]] }, dryRun: true })).toEqual({ ok: false, error: "self-intersecting:points" });
    expect(calls).toEqual([]);
  });
  it("作成の失敗理由をそのまま返す", () => {
    const { deps } = makeDeps({ createRoi: () => ({ ok: false, reason: "off-slice" }) });
    expect(executeCommand(deps, { kind: "action", id: "createContourRoi", params: ok, approved: true })).toEqual({ ok: false, error: "roi-off-slice" });
  });
});
