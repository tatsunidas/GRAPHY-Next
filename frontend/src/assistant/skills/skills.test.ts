/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { ActionResult } from "../actions/registry";
import type { PluginToolEntry } from "../pluginTools";
import { BUNDLED_SKILLS } from "./bundled";
import { runSkill, type SkillRunDeps } from "./runSkill";
import { bindParams, exportSkill, parseSkillText, skillEffect, upFrontInputs, validateSkill, type Skill } from "./skillModel";
import { initialText, mergeSkills, parseFieldText } from "./skillView";

const lt = (s: string) => ({ ja: s, en: s });
const base = (over: Partial<Skill> = {}): Skill => ({
  schemaVersion: 1,
  id: "t1",
  title: lt("t"),
  description: lt("d"),
  inputs: [],
  steps: [{ kind: "tool", id: "resetWindow", params: {} }],
  ...over,
});
const withStep = (step: unknown, inputs: unknown[] = []) => ({ ...base(), inputs, steps: [step] });

describe("validateSkill", () => {
  it("同梱スキルはすべて検証に通る", () => {
    for (const s of BUNDLED_SKILLS) expect(validateSkill(s).ok, s.id).toBe(true);
  });
  it("未知の操作・未知の引数・範囲外・NaN は落ちる", () => {
    expect(validateSkill(withStep({ kind: "tool", id: "deleteEverything", params: {} })).ok).toBe(false);
    expect(validateSkill(withStep({ kind: "tool", id: "goToSlice", params: { index: 1, x: 1 } })).ok).toBe(false);
    expect(validateSkill(withStep({ kind: "tool", id: "goToSlice", params: { index: -1 } })).ok).toBe(false);
    expect(validateSkill(withStep({ kind: "tool", id: "goToSlice", params: { index: NaN } })).ok).toBe(false);
  });
  it("$input 以外のオブジェクト（式・入れ子）は落ちる", () => {
    const r = validateSkill(withStep({ kind: "tool", id: "goToSlice", params: { index: { $expr: "prev.slice + 1" } } }));
    expect(r.ok).toBe(false);
    expect(validateSkill(withStep({ kind: "tool", id: "goToSlice", params: { index: { $input: "a", extra: 1 } } }, [{ key: "a", label: lt("a"), type: "integer", min: 0, max: 9 }])).ok).toBe(false);
  });
  it("未定義の入力・ask より前の使用・二重の ask は落ちる", () => {
    expect(validateSkill(withStep({ kind: "tool", id: "goToSlice", params: { index: { $input: "nope" } } })).ok).toBe(false);
    const inp = [{ key: "s", label: lt("s"), type: "integer", min: 0, max: 9 }];
    const use = { kind: "tool", id: "goToSlice", params: { index: { $input: "s" } } };
    const early = { ...base(), inputs: inp, steps: [use, { kind: "ask", input: "s" }] };
    expect(validateSkill(early).ok).toBe(false);
    const dup = { ...base(), inputs: inp, steps: [{ kind: "ask", input: "s" }, { kind: "ask", input: "s" }] };
    expect(validateSkill(dup).ok).toBe(false);
    const good = { ...base(), inputs: inp, steps: [{ kind: "ask", input: "s" }, use] };
    expect(validateSkill(good).ok).toBe(true);
  });
  it("入力の既定値が範囲外なら落ち、ステップ数の上限を超えても落ちる", () => {
    expect(validateSkill({ ...base(), inputs: [{ key: "s", label: lt("s"), type: "integer", min: 0, max: 9, default: 99 }] }).ok).toBe(false);
    const many = Array.from({ length: 41 }, () => ({ kind: "tool", id: "resetWindow", params: {} }));
    expect(validateSkill({ ...base(), steps: many }).ok).toBe(false);
    expect(validateSkill({ ...base(), steps: [] }).ok).toBe(false);
  });
  it("余計なキーは捨てて作り直す", () => {
    const r = validateSkill({ ...base(), evil: "x", steps: [{ kind: "tool", id: "resetWindow", params: {}, run: "rm" }] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(JSON.stringify(r.skill)).not.toContain("evil");
      expect(JSON.stringify(r.skill)).not.toContain("rm");
    }
  });
  it("プラグインのツールは、有効で宣言どおりのものだけ通る（pluginTools を渡したとき）", () => {
    const entry: PluginToolEntry = {
      name: "plugin__p__go", pluginId: "p", pluginName: "P", tool: "go", effect: "display", description: "d", enabled: true,
      parameters: { type: "object", properties: { n: { type: "integer", minimum: 1, maximum: 5 } }, required: ["n"] },
    };
    const sk = withStep({ kind: "tool", id: "plugin__p__go", params: { n: 3 } });
    expect(validateSkill(sk, [entry]).ok).toBe(true);
    expect(validateSkill(sk, [{ ...entry, enabled: false }]).ok).toBe(false);
    expect(validateSkill(withStep({ kind: "tool", id: "plugin__p__go", params: { n: 9 } }), [entry]).ok).toBe(false);
    expect(validateSkill(withStep({ kind: "tool", id: "plugin__p__other", params: {} }), [entry]).ok).toBe(false);
  });
});

describe("書き出しと取り込み", () => {
  it("往復で同じになり、壊れた・大きすぎるものは受け付けない", () => {
    for (const s of BUNDLED_SKILLS) {
      const r = parseSkillText(exportSkill(s));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.skill).toEqual(s);
    }
    expect(parseSkillText("{").ok).toBe(false);
    expect(parseSkillText("x".repeat(70 * 1024)).ok).toBe(false);
  });
});

describe("効果・入力・表示", () => {
  it("write のプラグインツールを含めば write", () => {
    const e = { name: "plugin__p__w", pluginId: "p", pluginName: "P", tool: "w", effect: "write", description: "", parameters: { type: "object", properties: {} }, enabled: true } as PluginToolEntry;
    expect(skillEffect(base(), [e])).toBe("display");
    expect(skillEffect(withStep({ kind: "tool", id: "plugin__p__w", params: {} }) as Skill, [e])).toBe("write");
  });
  it("開始前の入力は ask の無いものだけ", () => {
    const sr = BUNDLED_SKILLS.find((s) => s.id === "slice-review")!;
    expect(upFrontInputs(sr).map((i) => i.key)).toEqual(["preset"]);
  });
  it("入力欄: 既定値なしは空、数値の空文字・非数・範囲外は落ちる", () => {
    const spec = { key: "n", label: lt("n"), type: "integer", min: 1, max: 5 } as const;
    expect(initialText(spec)).toBe("");
    expect(parseFieldText(spec, "").ok).toBe(false);
    expect(parseFieldText(spec, "abc").ok).toBe(false);
    expect(parseFieldText(spec, "6").ok).toBe(false);
    expect(parseFieldText(spec, "2.5").ok).toBe(false);
    expect(parseFieldText(spec, "3")).toEqual({ ok: true, value: 3 });
  });
  it("同じ id は同梱が優先", () => {
    const m = mergeSkills([base({ id: "ct-window-tour" }), base({ id: "mine" })]);
    expect(m.map((e) => `${e.skill.id}:${e.source}`)).toEqual(["ct-window-tour:bundled", "slice-review:bundled", "mine:user"]);
  });
  it("bindParams: 未束縛は落ちる", () => {
    expect(bindParams({ a: { $input: "x" } }, {}).ok).toBe(false);
    expect(bindParams({ a: { $input: "x" }, b: 1 }, { x: 2 })).toEqual({ ok: true, params: { a: 2, b: 1 } });
  });
});

function harness(over: Partial<SkillRunDeps> = {}) {
  const calls: { id: string; params: Record<string, unknown> }[] = [];
  const deps: SkillRunDeps = {
    viewer: async (cmd): Promise<ActionResult> => {
      calls.push({ id: cmd.id, params: cmd.params });
      return { ok: true, inverse: [{ id: "resetWindow", params: {} }] } as ActionResult;
    },
    aborted: () => false,
    ask: async () => 7,
    confirm: async () => true,
    locale: "ja",
    ...over,
  };
  return { calls, deps };
}

describe("runSkill", () => {
  it("同梱の巡回: 確認を続けると 3 操作を順に実行する", async () => {
    const { calls, deps } = harness();
    const out = await runSkill(BUNDLED_SKILLS[0], {}, deps);
    expect(out.status).toBe("done");
    expect(calls.map((c) => c.params.name)).toEqual(["lung", "soft", "bone"]);
    expect(out.executed).toBe(3);
  });
  it("確認で止めるとそれ以降は実行されない（負例）", async () => {
    const answers = [true, false];
    const { calls, deps } = harness({ confirm: async () => answers.shift() ?? false });
    const out = await runSkill(BUNDLED_SKILLS[0], {}, deps);
    expect(out.status).toBe("declined");
    expect(calls.map((c) => c.params.name)).toEqual(["lung", "soft"]);
    expect(out.inverses).toHaveLength(2);
  });
  it("入力: 開始前の値と ask の値が束ねられる", async () => {
    const { calls, deps } = harness({ ask: async () => 12 });
    const out = await runSkill(BUNDLED_SKILLS[1], { preset: "bone" }, deps);
    expect(out.status).toBe("done");
    expect(calls).toEqual([
      { id: "applyWlPreset", params: { name: "bone" } },
      { id: "goToSlice", params: { index: 12 } },
    ]);
  });
  it("入力が不正（範囲外の ask・未知の preset）なら実行しない／そこで止まる", async () => {
    const a = harness({ ask: async () => -3 });
    const out = await runSkill(BUNDLED_SKILLS[1], { preset: "soft" }, a.deps);
    expect(out.status).toBe("failed");
    expect(out.error).toBe("bad-input:slice");
    expect(a.calls.map((c) => c.id)).toEqual(["applyWlPreset"]); // goToSlice は呼ばれない
    const b = harness();
    const out2 = await runSkill(BUNDLED_SKILLS[1], { preset: "evil" }, b.deps);
    expect(out2).toMatchObject({ status: "failed", error: "bad-input:preset", executed: 0 });
    expect(b.calls).toHaveLength(0);
  });
  it("ask の取り消し・停止は aborted、実行器が失敗したらそのステップ番号で止まる", async () => {
    const a = harness({ ask: async () => null });
    expect((await runSkill(BUNDLED_SKILLS[1], { preset: "soft" }, a.deps)).status).toBe("aborted");
    let n = 0;
    const f = harness({
      viewer: async () => {
        n++;
        return n === 2 ? ({ ok: false, error: "boom" } as ActionResult) : ({ ok: true, inverse: [] } as ActionResult);
      },
    });
    const out = await runSkill(BUNDLED_SKILLS[0], {}, f.deps);
    expect(out).toMatchObject({ status: "failed", failedAt: 2, error: "boom", executed: 1 });
  });
  it("書き換えられた（不正な）スキルは 1 操作も実行しない", async () => {
    const { calls, deps } = harness();
    const bad = { ...base(), steps: [{ kind: "tool", id: "resetWindow", params: {} }, { kind: "tool", id: "wipeDisk", params: {} }] } as unknown as Skill;
    const out = await runSkill(bad, {}, deps);
    expect(out.status).toBe("failed");
    expect(out.error).toMatch(/^invalid-skill:/);
    expect(calls).toHaveLength(0);
  });
  it("abort 済みなら最初の操作の前に止まる", async () => {
    const { calls, deps } = harness({ aborted: () => true });
    expect((await runSkill(BUNDLED_SKILLS[0], {}, deps)).status).toBe("aborted");
    expect(calls).toHaveLength(0);
  });
});
