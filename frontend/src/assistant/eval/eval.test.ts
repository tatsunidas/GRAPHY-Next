import { describe, expect, it } from "vitest";
import { buildTools, PROPOSE_TOOL } from "../actions/registry";
import type { AiChatResult, AiToolCall } from "../../desktopBridge";
import { EVAL_CASES, type EvalCase } from "./cases";
import { runEval } from "./runEval";
import { scoreCase } from "./scoreCase";

const byId = (id: string): EvalCase => EVAL_CASES.find((c) => c.id === id)!;
const call = (name: string, args: Record<string, unknown> = {}) => ({ name, args });

describe("cases の整合", () => {
  it("id は重複せず形式に合い、質問は空でない", () => {
    const ids = EVAL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of EVAL_CASES) {
      expect(c.id).toMatch(/^[a-z0-9-]{1,24}$/);
      expect(c.text.trim().length).toBeGreaterThan(0);
    }
  });
  it("期待する操作は、チャットでモデルに渡る実在のツールだけ（書き込み操作は含まない）", () => {
    const names = new Set(buildTools().map((t) => t.name));
    for (const c of EVAL_CASES) for (const o of c.expect.ops) expect(names.has(o.id), `${c.id}: ${o.id}`).toBe(true);
    expect(names.has(PROPOSE_TOOL)).toBe(true);
    expect(names.has("createRoi")).toBe(false);
  });
  it("操作してはいけない質問（ops 空）が実在し、読み取りだけの質問もある（セットが偏っていない）", () => {
    expect(EVAL_CASES.filter((c) => c.expect.ops.length === 0).length).toBeGreaterThanOrEqual(2);
    expect(EVAL_CASES.some((c) => (c.expect.reads ?? []).length > 0)).toBe(true);
  });
});

describe("scoreCase", () => {
  it("正例: 数値・文字列（含む）・順序つきの複数操作・省略された times", () => {
    expect(scoreCase(byId("wl-numbers"), [call("getState"), call("setWindowLevel", { center: 50, width: 350 })]).pass).toBe(true);
    expect(scoreCase(byId("wl-lung"), [call("applyWlPreset", { name: "Lung" })]).pass).toBe(true);
    expect(scoreCase(byId("wl-lung"), [call("applyWlPreset", { name: "肺野" })]).pass).toBe(true);
    expect(scoreCase(byId("rotate"), [call("rotate90")]).pass).toBe(true);
    expect(scoreCase(byId("rotate"), [call("rotate90", { times: 1 })]).pass).toBe(true);
    expect(scoreCase(byId("rotate-then-flip"), [call("rotate90"), call("flipH")]).pass).toBe(true);
    expect(scoreCase(byId("read-measure"), [call("getMeasurements")]).pass).toBe(true);
    expect(scoreCase(byId("no-op-question"), []).pass).toBe(true);
    expect(scoreCase(byId("no-op-question"), [call("getState")]).pass).toBe(true);
  });
  it("負例: 数値違い（0 始まりの罠）・文字列が合わない・順序違い", () => {
    const wrong = scoreCase(byId("slice-10th"), [call("goToSlice", { index: 10 })]);
    expect(wrong.pass).toBe(false);
    expect(wrong.reason).toMatch(/index/);
    expect(scoreCase(byId("slice-10th"), [call("goToSlice", { index: 9 })]).pass).toBe(true);
    expect(scoreCase(byId("wl-lung"), [call("applyWlPreset", { name: "bone" })]).pass).toBe(false);
    expect(scoreCase(byId("rotate-then-flip"), [call("flipH"), call("rotate90")]).pass).toBe(false);
    expect(scoreCase(byId("rotate"), [call("rotate90", { times: 2 })]).pass).toBe(false);
    expect(scoreCase(byId("wl-numbers"), [call("setWindowLevel", { center: "50", width: 350 })]).pass).toBe(false);
  });
  it("負例: 余計な操作・足りない操作・操作してはいけない質問に操作・読み取り不足", () => {
    expect(scoreCase(byId("flip-h"), [call("flipH"), call("invert")]).pass).toBe(false);
    expect(scoreCase(byId("flip-h"), []).pass).toBe(false);
    expect(scoreCase(byId("flip-h"), [call("flipV")]).pass).toBe(false);
    const unexpected = scoreCase(byId("no-op-question"), [call("invert")]);
    expect(unexpected.pass).toBe(false);
    expect(unexpected.reason).toMatch(/unexpected/);
    expect(scoreCase(byId("read-measure"), []).pass).toBe(false);
    expect(scoreCase(byId("read-measure"), [call("getState")]).pass).toBe(false);
  });
});

describe("runEval", () => {
  const prov = { providerId: "p", kind: "openai", model: "m", endpointHost: "h" };
  const tc = (id: string, name: string, args: Record<string, unknown> = {}): AiToolCall => ({ id, name, args });
  /** 質問文から期待どおりのツール呼び出しを返す偽モデル（最初の往復は getState、次で操作、最後は文章）。 */
  function fakeModel(over: Record<string, AiToolCall[]> = {}, version = "v1") {
    const seen: string[] = [];
    const chat = async (sessionId: string, messages: { role: string; text?: string }[]): Promise<AiChatResult> => {
      seen.push(sessionId);
      const q = messages.find((m) => m.role === "user")!.text!;
      const c = EVAL_CASES.find((x) => x.text === q)!;
      const toolRounds = messages.filter((m) => m.role === "tool").length;
      if (toolRounds === 0 && c.expect.ops.length + (c.expect.reads?.length ?? 0) > 0) {
        const ops = over[c.id] ?? c.expect.ops.map((o, i) => tc(`c${i}`, o.id, o.id === PROPOSE_TOOL ? { title: "ROI を描く手順", steps: ["ROI メニューを開く"] } : (Object.fromEntries(Object.entries(o.args ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]))) as Record<string, unknown>));
        const reads = (c.expect.reads ?? []).map((r, i) => tc(`r${i}`, r));
        return { ok: true, toolCalls: [tc("s0", "getState"), ...reads, ...ops], provenance: prov, modelVersion: version } as AiChatResult;
      }
      return { ok: true, text: "了解しました", provenance: prov, modelVersion: version } as AiChatResult;
    };
    return { chat, seen };
  }
  const deps = (chat: ReturnType<typeof fakeModel>["chat"], extra = {}) => ({ cases: EVAL_CASES, systemPrompt: "sys", tools: buildTools(), chat: chat as never, runId: "t", ...extra });

  it("全件一致（正例）。由来と版が取れ、質問ごとに別のセッション ID", async () => {
    const m = fakeModel();
    const r = await runEval(deps(m.chat));
    expect(r.cases.filter((c) => !c.pass), JSON.stringify(r.cases.filter((c) => !c.pass))).toEqual([]);
    expect(r.total).toBe(EVAL_CASES.length);
    expect(r.passed).toBe(EVAL_CASES.length);
    expect(r.meta).toEqual({ provider: "p", modelId: "m", modelVersion: "v1" });
    expect(new Set(m.seen).size).toBe(EVAL_CASES.length);
    expect(m.seen.every((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s) && s.startsWith("eval-"))).toBe(true);
  });
  it("負例: 特定の質問だけ挙動が変わると、その質問だけが不一致になる", async () => {
    const m = fakeModel({ "slice-10th": [tc("x", "goToSlice", { index: 10 })], "flip-h": [tc("a", "flipH"), tc("b", "invert")] }, "v2");
    const r = await runEval(deps(m.chat));
    expect(r.cases.filter((c) => !c.pass).map((c) => c.id).sort()).toEqual(["flip-h", "slice-10th"]);
    expect(r.passed).toBe(EVAL_CASES.length - 2);
    expect(r.meta.modelVersion).toBe("v2");
  });
  it("チャットが失敗した質問は一致にせず、理由を残す。引数の検証に落ちた操作も一致にならない", async () => {
    const m = fakeModel({ "layout-2": [tc("x", "setLayout", { cols: 99 })] });
    const failing = async (sid: string, msgs: never) => (sid.endsWith("-3") ? ({ ok: false, error: "rate-limited" } as AiChatResult) : m.chat(sid, msgs));
    const r = await runEval(deps(failing as never));
    expect(r.cases[3]).toMatchObject({ pass: false, error: "rate-limited" });
    expect(r.cases.find((c) => c.id === "layout-2")!.pass).toBe(false);
    expect(r.passed).toBe(EVAL_CASES.length - 2);
  });
  it("中止すると、それ以降は流さない。進行が通知される", async () => {
    const m = fakeModel();
    let n = 0;
    const prog: number[] = [];
    const r = await runEval(deps(m.chat, { aborted: () => n >= 3, onProgress: (d: number) => { n = d; prog.push(d); } }));
    expect(r.cases).toHaveLength(3);
    expect(prog).toEqual([1, 2, 3]);
  });
  it("ツールは実行されない（ビューアは合成の状態を返すスタブで、操作の呼び出しも記録されるだけ）", async () => {
    const m = fakeModel();
    const r = await runEval(deps(m.chat));
    expect(r.cases.find((c) => c.id === "flip-h")!.got).toEqual(["flipH"]);
  });
});

import { compareRuns, type StoredEvalRun } from "./compareRuns";

describe("compareRuns", () => {
  const run = (over: Partial<StoredEvalRun> = {}, pass: Record<string, boolean> = {}): StoredEvalRun => ({
    ts: "t", suite: "basic", suiteVersion: 1, provider: "p", modelId: "m", modelVersion: "v1", total: 3, passed: 3,
    cases: (["a", "b", "c"] as const).map((id) => ({ id, pass: pass[id] ?? true, passes: (pass[id] ?? true) ? 1 : 0, n: 1 })), ...over,
  });
  it("一致→不一致と、不一致→一致を分ける。版の変化を示す", () => {
    const r = compareRuns(run({}, { c: false }), run({ modelVersion: "v2" }, { a: false }));
    expect(r).toEqual({ comparable: true, modelChanged: true, regressed: ["a"], fixed: ["c"] });
  });
  it("同じ結果なら差分なし・版も同じ", () => {
    expect(compareRuns(run(), run())).toEqual({ comparable: true, modelChanged: false, regressed: [], fixed: [] });
  });
  it("負例: 質問セットの版が違えば比べない。版が不明（null）なら変化とは言わない。前回に無い質問は無視", () => {
    expect(compareRuns(run({ suiteVersion: 1 }), run({ suiteVersion: 2 })).comparable).toBe(false);
    expect(compareRuns(run({ suite: "basic" }), run({ suite: "plugin-pos" })).comparable).toBe(false);
    expect(compareRuns(run({ modelVersion: null }), run({ modelVersion: "v2" })).modelChanged).toBe(false);
    const cur = run();
    cur.cases.push({ id: "new", pass: false, passes: 0, n: 1 });
    expect(compareRuns(run(), cur).regressed).toEqual([]);
  });
});
