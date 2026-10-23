/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// マクロの再生。モデルは使わず、各ステップを検証して既存の口（main 中継 → 2D 窓）で順に実行する。
// 失敗したらそこで止める。実行できた分の逆操作は呼び出し側が保持し、undoRun で逆順に戻せる。
import type { ActionResult, InverseStep } from "../actions/registry";
import { checkSteps, type MacroStep } from "./macroModel";

export type Viewer = (cmd: { kind: "action"; id: string; params: Record<string, unknown> }) => Promise<ActionResult>;

export interface RunDeps {
  viewer: Viewer;
  aborted: () => boolean;
  /** i 番目の実行を始める直前。 */
  onStep?: (i: number) => void;
}

export interface RunOutcome {
  status: "done" | "failed" | "aborted";
  /** 実行できたステップ数。 */
  executed: number;
  /** 実行できた分の逆操作（実行順）。 */
  inverses: InverseStep[][];
  failedAt?: number;
  error?: string;
}

export async function runMacro(steps: readonly MacroStep[], deps: RunDeps): Promise<RunOutcome> {
  const inverses: InverseStep[][] = [];
  // 1 つも実行しないうちに全体を検証する（途中で不正に気づいて中途半端に動かさない）。
  const chk = checkSteps(steps);
  if (!chk.ok) return { status: "failed", executed: 0, inverses, failedAt: chk.index >= 0 ? chk.index : undefined, error: chk.error };
  for (let i = 0; i < chk.steps.length; i++) {
    if (deps.aborted()) return { status: "aborted", executed: i, inverses };
    deps.onStep?.(i);
    const r = await deps.viewer({ kind: "action", id: chk.steps[i].id, params: chk.steps[i].params });
    if (!r.ok) return { status: "failed", executed: i, inverses, failedAt: i, error: r.error };
    inverses.push(r.inverse ?? []);
  }
  return { status: "done", executed: chk.steps.length, inverses };
}

export type UndoOutcome = { ok: true; skipped: number } | { ok: false; error: string };

/** 実行できた分を逆順に戻す。逆操作を持たないステップは数えて飛ばす（戻せなかったことを呼び出し側が伝える）。 */
export async function undoRun(inverses: readonly InverseStep[][], viewer: Viewer): Promise<UndoOutcome> {
  let skipped = 0;
  for (let i = inverses.length - 1; i >= 0; i--) {
    if (!inverses[i].length) {
      skipped++;
      continue;
    }
    for (const step of inverses[i]) {
      const r = await viewer({ kind: "action", id: step.id, params: step.params });
      if (!r.ok) return { ok: false, error: r.error };
    }
  }
  return { ok: true, skipped };
}
