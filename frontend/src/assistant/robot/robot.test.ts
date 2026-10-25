import { describe, expect, it } from "vitest";
import { PLAN_TOOL, buildRobotTools, validatePlan } from "./planModel";
import { runToolLoop, type LoopDeps } from "../toolLoop";
import type { AiChatResult, AiToolCall } from "../../desktopBridge";

const prov = { providerId: "p", kind: "openai", model: "m", endpointHost: "h" };
const text = (t: string): AiChatResult => ({ ok: true, text: t, provenance: prov });
const calls = (...c: AiToolCall[]): AiChatResult => ({ ok: true, toolCalls: c, provenance: prov });

describe("validatePlan", () => {
  it("正例: 検証済みの計画になり params が整形される", () => {
    const r = validatePlan({ title: " 肺野 ", steps: [{ id: "applyWlPreset", params: { name: "lung" } }, { id: "flipH" }] });
    expect(r).toEqual({ ok: true, title: "肺野", steps: [{ id: "applyWlPreset", params: { name: "lung" } }, { id: "flipH", params: {} }] });
  });
  it("負例: 未知の操作・範囲外・型違い・空・上限超過・題名なしは計画ごと拒否", () => {
    const bad: unknown[] = [
      null,
      { title: "x", steps: [] },
      { title: "", steps: [{ id: "flipH" }] },
      { title: "x", steps: [{ id: "deleteAllRois" }] },
      { title: "x", steps: [{ id: "flipH" }, { id: "goToSlice", params: { index: -1 } }] },
      { title: "x", steps: [{ id: "setWindowLevel", params: { center: "a", width: 1 } }] },
      { title: "x", steps: [{ id: 5 }] },
      { title: "x", steps: Array.from({ length: 31 }, () => ({ id: "invert" })) },
    ];
    for (const b of bad) expect(validatePlan(b).ok, JSON.stringify(b)).toBe(false);
    expect(validatePlan(bad[4])).toMatchObject({ ok: false, error: expect.stringMatching(/^step-2:/) });
  });
});

describe("buildRobotTools", () => {
  it("getState と plan_actions だけ（操作は直接呼べない）", () => {
    expect(buildRobotTools().map((t) => t.name)).toEqual(["getState", PLAN_TOOL]);
  });
});

function setup(script: AiChatResult[]) {
  const viewerCalls: unknown[] = [];
  const plans: string[] = [];
  let i = 0;
  const deps: LoopDeps = {
    chat: async () => script[Math.min(i++, script.length - 1)],
    viewer: async (cmd) => {
      viewerCalls.push(cmd);
      return { ok: true, state: { tiles: [] } } as never;
    },
    onAction: () => {},
    onActionUpdate: () => {},
    onProposal: () => {},
    onPlan: (p) => plans.push(`${p.title}:${p.steps.length}`),
    onRoundDone: () => {},
    aborted: () => false,
    mode: "robot",
  };
  return { deps, viewerCalls, plans };
}

describe("runToolLoop (robot)", () => {
  it("plan_actions は計画を出すだけで、何も実行しない", async () => {
    const s = setup([calls({ id: "p", name: PLAN_TOOL, args: { title: "反転", steps: [{ id: "invert" }] } }), text("ok")]);
    await runToolLoop([{ role: "user", text: "x" }], buildRobotTools(), s.deps);
    expect(s.plans).toEqual(["反転:1"]);
    expect(s.viewerCalls).toEqual([]);
  });
  it("負例: モデルが操作を直接呼んでも実行しない（tools に無い名前）", async () => {
    const s = setup([calls({ id: "a", name: "flipH", args: {} }, { id: "b", name: "propose_steps", args: { title: "t", steps: ["a"] } }), text("ok")]);
    await runToolLoop([{ role: "user", text: "x" }], buildRobotTools(), s.deps);
    expect(s.viewerCalls).toEqual([]);
    expect(s.plans).toEqual([]);
  });
  it("負例: 不正な計画は受け付けずモデルへエラーを返す", async () => {
    const s = setup([calls({ id: "p", name: PLAN_TOOL, args: { title: "x", steps: [{ id: "nuke" }] } }), text("ok")]);
    await runToolLoop([{ role: "user", text: "x" }], buildRobotTools(), s.deps);
    expect(s.plans).toEqual([]);
  });
  it("getState は読み取りとして通る", async () => {
    const s = setup([calls({ id: "g", name: "getState", args: {} }), text("ok")]);
    await runToolLoop([{ role: "user", text: "x" }], buildRobotTools(), s.deps);
    expect(s.viewerCalls).toEqual([{ kind: "getState" }]);
  });
});

describe("write 操作（承認つきデータ変更）", () => {
  it("計画には入れられる（検証は通る）が、チャットの tools にも直接呼びにも載らない", async () => {
    const { buildTools, isWriteAction } = await import("../actions/registry");
    expect(validatePlan({ title: "消す", steps: [{ id: "clearMeasurements" }] }).ok).toBe(true);
    expect(isWriteAction("clearMeasurements")).toBe(true);
    expect(isWriteAction("flipH")).toBe(false);
    expect(buildTools().map((t) => t.name)).not.toContain("clearMeasurements");
  });
  it("負例: チャットモードでモデルが clearMeasurements を直接呼んでも実行しない", async () => {
    const { runToolLoop } = await import("../toolLoop");
    const { buildTools } = await import("../actions/registry");
    const viewerCalls: unknown[] = [];
    let i = 0;
    const script = [calls({ id: "w", name: "clearMeasurements", args: {} }), text("ok")];
    await runToolLoop([{ role: "user", text: "x" }], buildTools(), {
      chat: async () => script[Math.min(i++, 1)],
      viewer: async (c) => {
        viewerCalls.push(c);
        return { ok: true } as never;
      },
      onAction: () => {},
      onActionUpdate: () => {},
      onProposal: () => {},
      onRoundDone: () => {},
      aborted: () => false,
    });
    expect(viewerCalls).toEqual([]);
  });
  it("2D 窓の実行器: 承認フラグなしは approval-required で何も実行しない。承認ありなら計測だけ消す", async () => {
    const { executeCommand } = await import("../../viewer2d/assistantBridge");
    const ran: string[] = [];
    const deps = {
      targets: () => ["t"],
      allTiles: () => ["t"],
      readInfo: () => null,
      readView: () => null,
      run: (_ids: string[], fn: (c: unknown) => void) => fn({ clearAnnotations: (s: string) => ran.push(s) }),
      runSeries: () => {},
      activeTool: () => "",
      layoutCols: () => 1,
      setTool: () => {},
      setLayoutCols: () => {},
      presets: () => [],
      toolId: () => "",
    } as never;
    expect(executeCommand(deps, { kind: "action", id: "clearMeasurements", params: {} })).toEqual({ ok: false, error: "approval-required" });
    expect(executeCommand(deps, { kind: "action", id: "clearMeasurements", params: {}, approved: false })).toEqual({ ok: false, error: "approval-required" });
    expect(ran).toEqual([]);
    expect(executeCommand(deps, { kind: "action", id: "clearMeasurements", params: {}, approved: true })).toEqual({ ok: true, inverse: undefined });
    expect(ran).toEqual(["measure"]);
  });
});

describe("ロボットの計画 × プラグインのツール", () => {
  const spec = { type: "object", properties: { n: { type: "integer", minimum: 1, maximum: 5, description: "n" } }, required: ["n"] };
  const mk = (tool: string, effect: "read" | "display" | "write", enabled = true) => ({
    name: `plugin__demo__${tool}`,
    pluginId: "demo",
    pluginName: "DEMO",
    tool,
    effect,
    description: "d",
    parameters: spec,
    enabled,
  });
  const entries = [mk("show", "display"), mk("save", "write"), mk("peek", "read"), mk("off", "display", false)];

  it("正例: display / write のツールが計画に入り、引数が整形される", () => {
    const r = validatePlan({ title: "t", steps: [{ id: "flipH" }, { id: "plugin__demo__show", params: { n: 2 } }, { id: "plugin__demo__save", params: { n: 5 } }] }, entries);
    expect(r).toEqual({
      ok: true,
      title: "t",
      steps: [
        { id: "flipH", params: {} },
        { id: "plugin__demo__show", params: { n: 2 } },
        { id: "plugin__demo__save", params: { n: 5 } },
      ],
    });
  });
  it("負例: read・無効・未知・一覧なし・引数不正は計画ごと拒否（built-in だけの計画は不変）", () => {
    for (const id of ["plugin__demo__peek", "plugin__demo__off", "plugin__demo__nope"]) {
      expect(validatePlan({ title: "t", steps: [{ id: "flipH" }, { id, params: { n: 1 } }] }, entries), id).toEqual({ ok: false, error: "step-2:unknown-tool" });
    }
    expect(validatePlan({ title: "t", steps: [{ id: "plugin__demo__show", params: { n: 1 } }] }).ok).toBe(false);
    expect(validatePlan({ title: "t", steps: [{ id: "plugin__demo__show", params: { n: 9 } }] }, entries)).toMatchObject({ ok: false, error: "step-1:out-of-range:n" });
    expect(validatePlan({ title: "t", steps: [{ id: "plugin__demo__show", params: { n: 1, x: 1 } }] }, entries).ok).toBe(false);
    expect(validatePlan({ title: "t", steps: [{ id: "flipH" }] }, entries).ok).toBe(true);
  });
  it("buildRobotTools: 載せられるツールだけが enum に入る", () => {
    const plan = buildRobotTools(entries).find((t) => t.name === PLAN_TOOL)!;
    const en = (plan.parameters as { properties: { steps: { items: { properties: { id: { enum: string[] } } } } } }).properties.steps.items.properties.id.enum;
    expect(en).toContain("plugin__demo__show");
    expect(en).toContain("plugin__demo__save");
    expect(en).not.toContain("plugin__demo__peek");
    expect(en).not.toContain("plugin__demo__off");
    expect(buildRobotTools().find((t) => t.name === PLAN_TOOL)!.description).not.toContain("plugin__");
  });
  it("toolLoop(robot): plan_actions の plugin step は通り、plugin__ の直呼びは拒否", async () => {
    const plans: string[] = [];
    const script = [
      calls({ id: "1", name: PLAN_TOOL, args: { title: "t", steps: [{ id: "plugin__demo__show", params: { n: 1 } }] } }),
      calls({ id: "2", name: "plugin__demo__show", args: { n: 1 } }),
      text("done"),
    ];
    let i = 0;
    const toolTexts: string[] = [];
    let pluginRan = 0;
    const deps: LoopDeps = {
      chat: async (m) => {
        const last = m[m.length - 1];
        if (last.role === "tool") toolTexts.push(last.text ?? "");
        return script[Math.min(i++, script.length - 1)];
      },
      viewer: async () => ({ ok: true }) as never,
      pluginTool: async () => {
        pluginRan++;
        return { ok: true, source: "p", untrusted: true, data: {} };
      },
      pluginTools: entries,
      onAction: () => {},
      onActionUpdate: () => {},
      onProposal: () => {},
      onPlan: (p) => plans.push(`${p.title}:${p.steps.map((s) => s.id).join(",")}`),
      mode: "robot",
      onRoundDone: () => {},
      aborted: () => false,
    };
    await runToolLoop([{ role: "user", text: "x" }], buildRobotTools(entries), deps);
    expect(plans).toEqual(["t:plugin__demo__show"]);
    expect(pluginRan).toBe(0);
    expect(toolTexts.some((t) => t.includes("not-allowed-in-robot-mode") || t.includes("unknown-tool"))).toBe(true);
  });
});
