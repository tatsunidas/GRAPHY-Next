import { describe, expect, it } from "vitest";
import { buildTools } from "../actions/registry";
import type { AiChatResult, AiToolCall } from "../../desktopBridge";
import { EVAL_CASES_2, EVAL_SUITES, gridCell, SYNTH_PLUGIN_TOOLS, type EvalCase } from "./cases";
import { runEval } from "./runEval";
import { scoreCase } from "./scoreCase";
import { wilson95 } from "./wilson";

const byId = (id: string): EvalCase => EVAL_CASES_2.find((c) => c.id === id)!;
const P = "plugin__eval-synth__";

describe("wilson95", () => {
  it("既知の値（Wilson 区間の定義から手計算）", () => {
    const a = wilson95(5, 5)!;
    expect(a.rate).toBe(1);
    expect(a.lo).toBeCloseTo(0.5655, 3);
    expect(a.hi).toBeCloseTo(1, 6);
    const b = wilson95(0, 5)!;
    expect(b.lo).toBe(0);
    expect(b.hi).toBeCloseTo(0.4345, 3);
    const c = wilson95(38, 60)!;
    expect(c.lo).toBeCloseTo(0.5068, 3);
    expect(c.hi).toBeCloseTo(0.7438, 3);
  });
  it("負例: 回数 0・範囲外・非整数は null（0% と書かない）", () => {
    expect(wilson95(0, 0)).toBeNull();
    expect(wilson95(3, 2)).toBeNull();
    expect(wilson95(-1, 4)).toBeNull();
    expect(wilson95(1.5, 4)).toBeNull();
  });
});

describe("第 2 組の整合", () => {
  it("組ごとに id は一意で形式に合い、組の id と版が定義されている", () => {
    expect(EVAL_SUITES.map((s) => s.id)).toEqual(["basic", "plugin-pos"]);
    const ids = EVAL_CASES_2.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of EVAL_CASES_2) expect(c.id).toMatch(/^[a-z0-9-]{1,24}$/);
  });
  it("期待するツールは、組み込みか合成プラグインツールに実在する。合成ツールの引数仕様は閉じた形", () => {
    const names = new Set([...buildTools().map((t) => t.name), ...SYNTH_PLUGIN_TOOLS.map((t) => t.name)]);
    for (const c of EVAL_CASES_2) for (const o of c.expect.ops) expect(names.has(o.id), `${c.id}: ${o.id}`).toBe(true);
    for (const t of SYNTH_PLUGIN_TOOLS) expect(t.name.startsWith(P)).toBe(true);
  });
  it("曖昧な依頼（ops 空）が複数ある", () => {
    expect(EVAL_CASES_2.filter((c) => c.id.startsWith("vague-") && c.expect.ops.length === 0).length).toBeGreaterThanOrEqual(2);
  });
  it("3×3 のマス: 隣り合って [0,1] を隙間なく覆う", () => {
    expect(gridCell(1, 1)).toEqual({ u: [1 / 3, 2 / 3], v: [1 / 3, 2 / 3] });
    expect(gridCell(2, 0).u[1]).toBe(1);
    expect(gridCell(0, 2).v[1]).toBe(1);
  });
});

describe("scoreCase ranges", () => {
  const mk = (u: number, v: number) => [{ name: `${P}place_marker`, args: { u, v } }];
  it("正例: マスの内側（境界を含む）", () => {
    expect(scoreCase(byId("mk-center"), mk(0.5, 0.5)).pass).toBe(true);
    expect(scoreCase(byId("mk-upper-right"), mk(0.9, 0.1)).pass).toBe(true);
    expect(scoreCase(byId("mk-lower-left"), mk(1 / 3, 1)).pass).toBe(true);
  });
  it("負例: 隣のマス・数値でない・別のツール", () => {
    expect(scoreCase(byId("mk-center"), mk(0.9, 0.5)).pass).toBe(false);
    expect(scoreCase(byId("mk-upper-right"), mk(0.1, 0.9)).reason).toMatch(/place_marker\.u/);
    expect(scoreCase(byId("mk-center"), [{ name: `${P}place_marker`, args: { u: "0.5", v: 0.5 } }]).pass).toBe(false);
    expect(scoreCase(byId("mk-center"), [{ name: "flipH", args: {} }]).pass).toBe(false);
  });
  it("曖昧な依頼: 何も実行しなければ合格、write のプラグインツールを呼べば不合格", () => {
    expect(scoreCase(byId("vague-delete"), []).pass).toBe(true);
    expect(scoreCase(byId("vague-delete"), [{ name: `${P}delete_series`, args: {} }]).pass).toBe(false);
  });
});

describe("runEval 第 2 組（k 回反復）", () => {
  const prov = { providerId: "p", kind: "openai", model: "m", endpointHost: "h" };
  const tc = (id: string, name: string, args: Record<string, unknown> = {}): AiToolCall => ({ id, name, args });
  /** 期待どおり呼ぶ偽モデル。`wrong(caseId, rep)` が真の回だけ、位置を別のマスにする。 */
  function fake(wrong: (id: string, rep: number) => boolean = () => false) {
    const seen: string[] = [];
    const chat = async (sessionId: string, messages: { role: string; text?: string }[]): Promise<AiChatResult> => {
      seen.push(sessionId);
      const q = messages.find((m) => m.role === "user")!.text!;
      const c = EVAL_CASES_2.find((x) => x.text === q)!;
      if (messages.some((m) => m.role === "tool") || c.expect.ops.length === 0) return { ok: true, text: "どこに置きますか", provenance: prov } as AiChatResult;
      const rep = Number(sessionId.split("-").pop());
      const calls = c.expect.ops.map((o, i) => {
        const args: Record<string, unknown> = {};
        for (const [k, [lo, hi]] of Object.entries(o.ranges ?? {})) args[k] = wrong(c.id, rep) ? (lo < 0.3 ? 0.9 : 0.1) : (lo + hi) / 2;
        for (const [k, v] of Object.entries(o.args ?? {})) args[k] = Array.isArray(v) ? v[0] : v;
        return tc(`c${i}`, o.id, args);
      });
      return { ok: true, toolCalls: calls, provenance: prov } as AiChatResult;
    };
    return { chat, seen };
  }
  const suite = EVAL_SUITES[1];
  const deps = (chat: ReturnType<typeof fake>["chat"], extra = {}) => ({
    cases: suite.cases, pluginTools: suite.pluginTools, systemPrompt: "sys", tools: buildTools(), chat: chat as never, runId: "t", ...extra,
  });

  it("正例: k=3 で全問 3/3。送信は 問数×k、セッション ID は反復ごとに別、進行の総数も 問数×k", async () => {
    const m = fake();
    const prog: [number, number][] = [];
    const r = await runEval(deps(m.chat, { k: 3, onProgress: (d: number, t: number) => prog.push([d, t]) }));
    expect(r.cases.filter((c) => !c.pass), JSON.stringify(r.cases.filter((c) => !c.pass))).toEqual([]);
    expect(r.cases.every((c) => c.passes === 3 && c.n === 3)).toBe(true);
    const sends = EVAL_CASES_2.length * 3;
    expect(prog.at(-1)).toEqual([sends, sends]);
    expect(new Set(m.seen).size).toBe(sends); // 1 回の質問は複数往復でも同じセッション ID
    expect(m.seen.every((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s))).toBe(true);
  });
  it("負例: 5 回中 1 回だけ別のマスにすると 4/5（予測どおり）で、その質問だけが不合格", async () => {
    const m = fake((id, rep) => id === "mk-center" && rep === 2);
    const r = await runEval(deps(m.chat, { k: 5 }));
    const c = r.cases.find((x) => x.id === "mk-center")!;
    expect(c).toMatchObject({ pass: false, passes: 4, n: 5 });
    expect(r.cases.filter((x) => !x.pass).map((x) => x.id)).toEqual(["mk-center"]);
    expect(c.reason).toMatch(/place_marker\.u/);
  });
  it("チャットが失敗した回は不合格に数え、応答時間は入れない", async () => {
    const m = fake();
    const failing = async (sid: string, msgs: never) => (sid.endsWith("-1") ? ({ ok: false, error: "rate-limited" } as AiChatResult) : m.chat(sid, msgs));
    const r = await runEval(deps(failing as never, { k: 3 }));
    const c = r.cases[0];
    expect(c).toMatchObject({ passes: 2, n: 3, pass: false, error: "rate-limited" });
    expect(c.latencyMs).toBeUndefined();
  });
  it("既定 k=1 は従来どおり（セッション ID に反復番号を付けない）", async () => {
    const m = fake();
    const r = await runEval(deps(m.chat));
    expect(r.cases.every((c) => c.n === 1 && c.passes === 1)).toBe(true);
    expect(m.seen[0]).toBe("eval-t-0");
  });
});
