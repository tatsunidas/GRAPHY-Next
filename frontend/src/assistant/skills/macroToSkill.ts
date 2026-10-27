/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 既存のマクロ（表示操作の並び）をスキルにする。手順は tool ステップに写し、validateSkill に通ったものだけ返す。マクロは残す。
import type { Macro } from "../macros/macroModel";
import { validateSkill, type SkillCheck } from "./skillModel";

export function macroToSkill(macro: Macro, newId: () => string): SkillCheck {
  return validateSkill({
    schemaVersion: 1,
    id: `macro-${newId()}`,
    title: { ja: macro.name, en: macro.name },
    description: { ja: `マクロ「${macro.name}」から作成`, en: `Created from the macro "${macro.name}"` },
    inputs: [],
    steps: macro.steps.map((s) => ({ kind: "tool", id: s.id, params: s.params })),
  });
}
