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
