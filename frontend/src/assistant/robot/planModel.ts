/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// ロボットモードの計画。モデルは操作を直接呼べず、`plan_actions` で**計画を出す**だけ。
// 実行は利用者が計画を確認して「実行」を押したあと、マクロと同じ実行器（runMacro）が行う。
import { ACTIONS, GET_STATE_TOOL, type ToolDef } from "../actions/registry";
import { MAX_STEPS, checkSteps, type MacroStep } from "../macros/macroModel";

export const PLAN_TOOL = "plan_actions";
const MAX_TITLE = 120;

export function buildRobotTools(): ToolDef[] {
  return [
    {
      name: GET_STATE_TOOL,
      description:
        "Read the current state of the 2D viewer (tiles, modality, slice index/count, window/level, zoom, rotation, layout, active tool). Call this before planning. Contains no patient identifiers.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    {
      name: PLAN_TOOL,
      description:
        "Propose an ordered plan of viewer DISPLAY operations that achieves the user's goal. Nothing runs until the user reviews and approves the plan. Use only these operation ids: " +
        ACTIONS.map((a) => a.id).join(", ") +
        ".",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", maxLength: MAX_TITLE, description: "Short title of the plan." },
          steps: {
            type: "array",
            maxItems: MAX_STEPS,
            description: "Ordered operations.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", enum: ACTIONS.map((a) => a.id) },
                params: { type: "object", description: "Parameters of that operation." },
              },
              required: ["id"],
            },
          },
        },
        required: ["title", "steps"],
      },
    },
  ];
}

export type PlanCheck = { ok: true; title: string; steps: MacroStep[] } | { ok: false; error: string };

/** `plan_actions` の引数を registry で検証する。1 つでも不正なら計画ごと受け付けない。 */
export function validatePlan(args: unknown): PlanCheck {
  if (!args || typeof args !== "object") return { ok: false, error: "args-not-object" };
  const { title, steps } = args as { title?: unknown; steps?: unknown };
  if (typeof title !== "string" || !title.trim() || title.length > MAX_TITLE) return { ok: false, error: "bad-param:title" };
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) return { ok: false, error: "bad-param:steps" };
  const raw: MacroStep[] = [];
  for (const s of steps) {
    if (!s || typeof s !== "object" || typeof (s as { id?: unknown }).id !== "string") return { ok: false, error: "bad-param:steps" };
    const p = (s as { params?: unknown }).params;
    raw.push({ id: (s as { id: string }).id, params: p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {} });
  }
  const c = checkSteps(raw);
  if (!c.ok) return { ok: false, error: `step-${c.index + 1}:${c.error}` };
  return { ok: true, title: title.trim(), steps: c.steps };
}
