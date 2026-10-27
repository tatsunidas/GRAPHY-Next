/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// スキルの実行。モデルは使わない。ツールのステップは 1 つずつ、動的な値を束ねてからマクロと同じ実行器（runMacro）に渡す
// （registry / プラグイン仕様の再検証・main 中継・write の確認はそこで行われる）。ask / confirm では利用者の応答を待って止まる。
import type { InverseStep } from "../actions/registry";
import { isPluginToolName, planEligible, type PluginToolEntry, type PluginToolResult } from "../pluginTools";
import { runMacro, type Viewer } from "../macros/runMacro";
import { bindParams, checkInputValue, pick, upFrontInputs, validateSkill, type Skill, type SkillInput } from "./skillModel";

export interface SkillRunDeps {
  viewer: Viewer;
  pluginTools?: readonly PluginToolEntry[];
  pluginTool?: (cmd: { kind: "pluginTool"; name: string; params: Record<string, unknown> }) => Promise<PluginToolResult>;
  aborted: () => boolean;
  /** 入力を尋ねる。`null` は取り消し（スキルは止まる）。 */
  ask: (spec: SkillInput) => Promise<unknown | null>;
  /** 確認。`false`（既定）はそこで止める。 */
  confirm: (message: string) => Promise<boolean>;
  locale: string;
  /** i 番目のステップを始める直前。 */
  onStep?: (i: number) => void;
  /** プラグインのツールが返した値（信用しない値。画面にテキストとして出すだけで、モデルにも後続の引数にも渡さない）。 */
  onResult?: (i: number, data: unknown) => void;
}

export interface SkillRunOutcome {
  status: "done" | "failed" | "aborted" | "declined";
  /** 実行できたツールのステップ数。 */
  executed: number;
  /** 実行できた分の逆操作（実行順）。 */
  inverses: InverseStep[][];
  failedAt?: number;
  error?: string;
}

export async function runSkill(skill: Skill, start: Record<string, unknown>, deps: SkillRunDeps): Promise<SkillRunOutcome> {
  const inverses: InverseStep[][] = [];
  const fail = (error: string, failedAt?: number): SkillRunOutcome => ({ status: "failed", executed: inverses.length, inverses, failedAt, error });
  // 実行の直前にもう一度、全体を検証する（保存後に書き換えられていても、有効でないプラグインのツールがあっても動かさない）。
  const chk = validateSkill(skill, deps.pluginTools ?? []);
  if (!chk.ok) return fail(`invalid-skill:${chk.error}`);
  const sk = chk.skill;

  const values: Record<string, unknown> = {};
  for (const spec of upFrontInputs(sk)) {
    const given = spec.key in start ? start[spec.key] : spec.default;
    const c = given === undefined ? { ok: false as const } : checkInputValue(spec, given);
    if (!c.ok) return fail(`bad-input:${spec.key}`);
    values[spec.key] = c.value;
  }

  const eligible = planEligible(deps.pluginTools);
  let lastResult: PluginToolResult | undefined;
  const pluginTool = deps.pluginTool
    ? async (cmd: { kind: "pluginTool"; name: string; params: Record<string, unknown> }) => {
        lastResult = await deps.pluginTool!(cmd);
        return lastResult;
      }
    : undefined;
  for (let i = 0; i < sk.steps.length; i++) {
    if (deps.aborted()) return { status: "aborted", executed: inverses.length, inverses };
    deps.onStep?.(i);
    const s = sk.steps[i];
    if (s.kind === "ask") {
      const spec = sk.inputs.find((x) => x.key === s.input)!;
      const v = await deps.ask(spec);
      if (v === null || v === undefined) return { status: "aborted", executed: inverses.length, inverses };
      const c = checkInputValue(spec, v);
      if (!c.ok) return fail(`bad-input:${spec.key}`, i);
      values[spec.key] = c.value;
    } else if (s.kind === "confirm") {
      if (!(await deps.confirm(pick(s.message, deps.locale)))) return { status: deps.aborted() ? "aborted" : "declined", executed: inverses.length, inverses };
    } else {
      const bound = bindParams(s.params, values);
      if (!bound.ok) return fail(bound.error, i);
      const out = await runMacro([{ id: s.id, params: bound.params }], {
        viewer: deps.viewer,
        aborted: deps.aborted,
        pluginTools: eligible,
        pluginTool,
      });
      if (out.status === "aborted") return { status: "aborted", executed: inverses.length, inverses };
      if (out.status === "failed") return fail(out.error ?? "failed", i);
      inverses.push(...out.inverses);
      if (isPluginToolName(s.id) && lastResult?.ok) {
        deps.onResult?.(i, lastResult.data);
        // プラグインのツールは失敗を `{ok:false, error}` の値で返すことがある（実行器の成否とは別）。後続の手順に進まず止める。
        const d = lastResult.data as { ok?: unknown; error?: unknown } | null;
        if (d && typeof d === "object" && d.ok === false) return { ...fail(`tool-error:${String(d.error ?? "?").slice(0, 60)}`, i), executed: inverses.length };
      }
    }
  }
  return { status: "done", executed: inverses.length, inverses };
}
