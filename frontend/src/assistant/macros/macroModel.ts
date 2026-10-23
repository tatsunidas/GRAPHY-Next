/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// マクロ = 検証済みの表示操作 {id, params} の並び。保存と再生の**両方**で registry の validateAction を通す
// （保存ファイルが書き換えられても、許可リストにない操作は実行されない）。
import { validateAction } from "../actions/registry";
import type { UiAction } from "../chatState";

/** desktop/assistantMacros.js と同じ上限（暫定値）。 */
export const MAX_STEPS = 30;
export const MAX_NAME = 60;

export interface MacroStep {
  id: string;
  params: Record<string, unknown>;
}

export interface Macro {
  id: string;
  name: string;
  steps: MacroStep[];
  createdAt: string;
}

/** 会話で「実行できた」操作を、マクロの候補ステップにする（上限を超える分は切る）。 */
export function candidatesFromActions(actions: readonly UiAction[]): MacroStep[] {
  const out: MacroStep[] = [];
  for (const a of actions) {
    if (a.status !== "done") continue;
    const v = validateAction(a.name, a.params);
    if (v.ok) out.push({ id: a.name, params: v.params });
  }
  return out.slice(0, MAX_STEPS);
}

export type StepsCheck = { ok: true; steps: MacroStep[] } | { ok: false; index: number; error: string };

/** 全ステップを registry で検証して整形する。最初の不正で止める。 */
export function checkSteps(steps: readonly MacroStep[]): StepsCheck {
  if (!steps.length || steps.length > MAX_STEPS) return { ok: false, index: -1, error: "bad-length" };
  const out: MacroStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const v = validateAction(steps[i].id, steps[i].params);
    if (!v.ok) return { ok: false, index: i, error: v.error };
    out.push({ id: steps[i].id, params: v.params });
  }
  return { ok: true, steps: out };
}
