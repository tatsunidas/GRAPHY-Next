/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 1 回の質問に対するツール呼び出しのループ。gateway は 1 呼び出し＝1 ターンなので、
// 「ツール結果を返して次を呼ぶ」往復はここ（呼び出し側）が持つ（設計書 §15）。
import type { AiChatMessage, AiChatResult, AiToolCall } from "../desktopBridge";
import {
  GET_STATE_TOOL,
  PROPOSE_TOOL,
  isActionId,
  validateAction,
  validateProposal,
  type ActionResult,
  type ToolDef,
} from "./actions/registry";
import type { UiAction, UiProposal } from "./chatState";
import { PLAN_TOOL, validatePlan } from "./robot/planModel";
import type { MacroStep } from "./macros/macroModel";

/**
 * 1 質問あたりの往復の上限。暴走（同じ操作を延々と繰り返す）を止めるための目安で、データから決めた値ではない。
 * getState → 操作 → 確認の getState → 回答、で 4 往復なので、それに余裕を足した。
 */
export const MAX_ROUNDS = 6;

export interface LoopDeps {
  chat(messages: AiChatMessage[], tools: ToolDef[]): Promise<AiChatResult>;
  viewer(cmd: { kind: "action" | "getState"; id?: string; params?: unknown }): Promise<ActionResult>;
  onAction(a: UiAction): void;
  onActionUpdate(id: string, patch: Partial<UiAction>): void;
  onProposal(p: UiProposal): void;
  /** ロボットモード: 検証済みの計画（実行は利用者の承認後。ここでは何も実行しない）。 */
  onPlan?(p: { id: string; title: string; steps: MacroStep[] }): void;
  /** "robot" のとき操作を直接実行せず、計画だけ受け付ける。 */
  mode?: "chat" | "robot";
  onRoundDone(text?: string): void;
  /** 中止されたか（中止後は次の往復・操作をしない）。 */
  aborted(): boolean;
}

/** モデルへ返すツール結果（逆操作は画面用なので含めない）。 */
function toToolText(r: ActionResult): string {
  return JSON.stringify(r.ok ? { ok: true, ...(r.state ? { state: r.state } : {}) } : { ok: false, error: r.error });
}

async function runOne(call: AiToolCall, deps: LoopDeps): Promise<string> {
  if (deps.mode === "robot" && call.name !== GET_STATE_TOOL) {
    // ロボットでは計画の提示だけ。tools に載せていない名前（操作の直呼び・propose_steps）は実行しない。
    if (call.name !== PLAN_TOOL) return JSON.stringify({ ok: false, error: "not-allowed-in-robot-mode" });
    if (call.argsError) return JSON.stringify({ ok: false, error: `bad-arguments: ${call.argsError}` });
    const v = validatePlan(call.args);
    if (!v.ok) return JSON.stringify({ ok: false, error: v.error });
    deps.onPlan?.({ id: call.id, title: v.title, steps: v.steps });
    return JSON.stringify({ ok: true, note: "plan shown to the user; nothing was executed until they approve" });
  }
  if (call.argsError) return JSON.stringify({ ok: false, error: `bad-arguments: ${call.argsError}` });
  if (call.name === GET_STATE_TOOL) {
    const r = await deps.viewer({ kind: "getState" });
    deps.onAction({ id: call.id, name: call.name, status: r.ok ? "done" : "failed", error: r.ok ? undefined : r.error });
    return toToolText(r);
  }
  if (call.name === PROPOSE_TOOL) {
    const v = validateProposal(call.args);
    if (!v.ok) return JSON.stringify({ ok: false, error: v.error });
    deps.onProposal({ id: call.id, title: v.title, steps: v.steps });
    return JSON.stringify({ ok: true, note: "shown to the user; nothing was executed" });
  }
  if (!isActionId(call.name)) return JSON.stringify({ ok: false, error: "unknown-tool" });
  // 送る前に自分でも検証する（落ちた引数は 2D 窓へ届けない）。受信側でも再検証される。
  const v = validateAction(call.name, call.args);
  if (!v.ok) {
    deps.onAction({ id: call.id, name: call.name, params: call.args, status: "failed", error: v.error });
    return JSON.stringify({ ok: false, error: v.error });
  }
  deps.onAction({ id: call.id, name: call.name, params: v.params, status: "running" });
  const r = await deps.viewer({ kind: "action", id: call.name, params: v.params });
  deps.onActionUpdate(call.id, r.ok ? { status: "done", inverse: r.inverse } : { status: "failed", error: r.error });
  return toToolText(r);
}

export type LoopResult = AiChatResult | { ok: false; error: "max-rounds" };

export async function runToolLoop(initial: AiChatMessage[], tools: ToolDef[], deps: LoopDeps): Promise<LoopResult> {
  const messages = [...initial];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await deps.chat(messages, tools);
    if (!res.ok || !res.toolCalls?.length) return res;
    deps.onRoundDone(res.text);
    messages.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls });
    for (const call of res.toolCalls) {
      if (deps.aborted()) return { ok: false, error: "canceled" } as AiChatResult;
      const text = await runOne(call, deps);
      messages.push({ role: "tool", toolCallId: call.id, toolName: call.name, text });
    }
    if (deps.aborted()) return { ok: false, error: "canceled" } as AiChatResult;
  }
  return { ok: false, error: "max-rounds" };
}
