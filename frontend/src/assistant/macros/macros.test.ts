import { describe, expect, it } from "vitest";
import type { ActionResult } from "../actions/registry";
import type { UiAction } from "../chatState";
import { MAX_STEPS, candidatesFromActions, checkSteps } from "./macroModel";
import { runMacro, undoRun, type Viewer } from "./runMacro";

const act = (name: string, params: Record<string, unknown> | undefined, status: UiAction["status"] = "done"): UiAction => ({ id: name + Math.random(), name, params, status });

function fakeViewer(failOn?: string) {
  const calls: Array<{ id: string; params: Record<string, unknown> }> = [];
  const viewer: Viewer = async (c): Promise<ActionResult> => {
    calls.push({ id: c.id, params: c.params });
    if (c.id === failOn) return { ok: false, error: "exec-failed" };
    return { ok: true, inverse: c.id === "rotate90" ? [{ id: "rotate90", params: { times: 3 } }] : [] };
  };
  return { viewer, calls };
}

describe("candidatesFromActions", () => {
  it("done の操作だけ、検証を通ったものだけを拾う", () => {
    const c = candidatesFromActions([
      act("rotate90", { times: 1 }),
      act("flipH", {}, "failed"),
      act("flipV", {}, "undone"),
      act("saveSegmentation", {}),
      act("goToSlice", { index: 9999999 }),
      act("invert", undefined),
    ]);
    expect(c.map((s) => s.id)).toEqual(["rotate90", "invert"]);
  });
  it("上限を超える分は切る", () => {
    const many = Array.from({ length: MAX_STEPS + 5 }, () => act("invert", {}));
    expect(candidatesFromActions(many)).toHaveLength(MAX_STEPS);
  });
});

describe("checkSteps", () => {
  it("正例", () => expect(checkSteps([{ id: "rotate90", params: { times: 2 } }]).ok).toBe(true));
  it("負例: 未知 id・範囲外・空・長すぎ", () => {
    expect(checkSteps([{ id: "deleteStudy", params: {} }])).toEqual({ ok: false, index: 0, error: "unknown-action" });
    expect(checkSteps([{ id: "invert", params: {} }, { id: "rotate90", params: { times: 99 } }])).toMatchObject({ ok: false, index: 1 });
    expect(checkSteps([]).ok).toBe(false);
    expect(checkSteps(Array.from({ length: MAX_STEPS + 1 }, () => ({ id: "invert", params: {} }))).ok).toBe(false);
  });
});

describe("runMacro", () => {
  const steps = [
    { id: "rotate90", params: { times: 1 } },
    { id: "invert", params: {} },
    { id: "flipH", params: {} },
  ];
  it("順に全部実行し、逆操作を実行順に集める", async () => {
    const { viewer, calls } = fakeViewer();
    const r = await runMacro(steps, { viewer, aborted: () => false });
    expect(r.status).toBe("done");
    expect(calls.map((c) => c.id)).toEqual(["rotate90", "invert", "flipH"]);
    expect(r.inverses).toHaveLength(3);
  });
  it("失敗したらそこで止める（後ろは実行しない）", async () => {
    const { viewer, calls } = fakeViewer("invert");
    const r = await runMacro(steps, { viewer, aborted: () => false });
    expect(r).toMatchObject({ status: "failed", executed: 1, failedAt: 1, error: "exec-failed" });
    expect(calls.map((c) => c.id)).toEqual(["rotate90", "invert"]);
  });
  it("中止すると次のステップから実行しない", async () => {
    const { viewer, calls } = fakeViewer();
    let n = 0;
    const r = await runMacro(steps, { viewer, aborted: () => n++ >= 1 });
    expect(r.status).toBe("aborted");
    expect(r.executed).toBe(1);
    expect(calls).toHaveLength(1);
  });
  it("負例: 不正なステップが混ざっていたら 1 つも実行しない", async () => {
    const { viewer, calls } = fakeViewer();
    const r = await runMacro([...steps, { id: "deleteStudy", params: {} }], { viewer, aborted: () => false });
    expect(r).toMatchObject({ status: "failed", executed: 0, failedAt: 3, error: "unknown-action" });
    expect(calls).toHaveLength(0);
  });
});

describe("undoRun", () => {
  it("逆順に戻し、逆操作の無いステップは skipped に数える", async () => {
    const { viewer, calls } = fakeViewer();
    const r = await undoRun([[{ id: "rotate90", params: { times: 3 } }], [], [{ id: "flipH", params: {} }]], viewer);
    expect(r).toEqual({ ok: true, skipped: 1 });
    expect(calls.map((c) => c.id)).toEqual(["flipH", "rotate90"]);
  });
  it("失敗したらそこで止めて理由を返す", async () => {
    const { viewer } = fakeViewer("flipH");
    expect(await undoRun([[{ id: "rotate90", params: {} }], [{ id: "flipH", params: {} }]], viewer)).toEqual({ ok: false, error: "exec-failed" });
  });
});

describe("runMacro × プラグインのステップ", () => {
  const spec = { type: "object", properties: { n: { type: "integer", minimum: 1, maximum: 5, description: "n" } }, required: ["n"] };
  const entry = { name: "plugin__demo__show", pluginId: "demo", pluginName: "DEMO", tool: "show", effect: "display" as const, description: "d", parameters: spec, enabled: true };
  const viewer = async () => ({ ok: true, inverse: [{ id: "flipH", params: {} }] }) as never;

  it("pluginTools を渡さなければ plugin ステップは 1 つも実行されずに拒否（マクロ再生の挙動不変）", async () => {
    const sent: unknown[] = [];
    const out = await runMacro([{ id: "flipH", params: {} }, { id: "plugin__demo__show", params: { n: 1 } }], {
      viewer,
      aborted: () => false,
      pluginTool: async (c) => (sent.push(c), { ok: true, source: "p", untrusted: true, data: {} }),
    });
    expect(out).toMatchObject({ status: "failed", executed: 0, failedAt: 1, error: "unknown-tool" });
    expect(sent).toEqual([]);
  });
  it("渡せば pluginTool 経由で送られ、逆操作は空・undo は戻せない分を数える", async () => {
    const sent: unknown[] = [];
    const out = await runMacro([{ id: "flipH", params: {} }, { id: "plugin__demo__show", params: { n: 2 } }], {
      viewer,
      aborted: () => false,
      pluginTools: [entry],
      pluginTool: async (c) => (sent.push(c), { ok: true, source: "p", untrusted: true, data: {} }),
    });
    expect(out.status).toBe("done");
    expect(sent).toEqual([{ kind: "pluginTool", name: "plugin__demo__show", params: { n: 2 } }]);
    expect(out.inverses).toEqual([[{ id: "flipH", params: {} }], []]);
    expect(await undoRun(out.inverses, viewer)).toEqual({ ok: true, skipped: 1 });
  });
  it("plugin ステップの失敗で止まり、後続は送られない（拒否=declined を含む）", async () => {
    const sent: string[] = [];
    const out = await runMacro([{ id: "plugin__demo__show", params: { n: 1 } }, { id: "flipH", params: {} }], {
      viewer: async (c) => (sent.push(c.id), { ok: true }) as never,
      aborted: () => false,
      pluginTools: [entry],
      pluginTool: async () => ({ ok: false, error: "declined" }),
    });
    expect(out).toMatchObject({ status: "failed", executed: 0, failedAt: 0, error: "declined" });
    expect(sent).toEqual([]);
  });
});
