/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Scissors（矩形・円・球で塗る／消す）の設定。ドラッグ即確定のツールなのでセッションは持たず、
 * ツールが有効な間だけ `active` を立てて、ダイアログ（形・操作）の表示に使う。
 * モジュールスコープ＋subscribe（wandStore と同型）。
 */
import { RectangleScissorsTool, CircleScissorsTool, SphereScissorsTool } from "@cornerstonejs/tools";

export type ScissorsShape = "rect" | "circle" | "sphere";
export type ScissorsOp = "fill" | "erase";

interface ScissorsState {
  active: boolean;
  shape: ScissorsShape;
  op: ScissorsOp;
}
let state: ScissorsState = { active: false, shape: "rect", op: "fill" };
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

export function getScissors(): ScissorsState {
  return state;
}

export function setScissorsActive(active: boolean): void {
  if (state.active === active) return;
  state = { ...state, active };
  notify();
}

export function updateScissors(patch: Partial<Pick<ScissorsState, "shape" | "op">>): void {
  state = { ...state, ...patch };
  notify();
}

export function subscribeScissors(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** 形から Cornerstone のツール名を引く。 */
export function scissorsToolName(shape: ScissorsShape): string {
  return shape === "circle" ? CircleScissorsTool.toolName : shape === "sphere" ? SphereScissorsTool.toolName : RectangleScissorsTool.toolName;
}

/** 3 種すべてのツール名（切替時に他方を passive へ戻す対象）。 */
export const SCISSORS_TOOL_NAMES: string[] = [RectangleScissorsTool.toolName, CircleScissorsTool.toolName, SphereScissorsTool.toolName];

/** 操作から Cornerstone のストラテジ名を引く（Scissors 3 種共通の名前）。 */
export function scissorsStrategy(op: ScissorsOp): string {
  return op === "erase" ? "ERASE_INSIDE" : "FILL_INSIDE";
}
