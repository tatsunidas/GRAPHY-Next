/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D ビューア共通の **Undo/Redo コマンドスタック**。旧 GRAPHY `view/D3/ui/UndoManager` の TS 移植。
 *
 * 「操作を実行した後に、取り消し方(undo)/やり直し方(redo)のクロージャを push する」記録型。
 * ROI 編集・3D カット・内視鏡経路編集・計測など、すべての 3D 操作が同じスタックに載る土台。
 *
 * - `push(cmd)`: undo スタックへ積み、redo スタックをクリア（実行はしない＝呼び出し側が既に適用済み）。
 * - 連続操作の合体（coalesce）: 直前コマンドと同じ `coalesceKey` なら、undo は元のまま redo だけ差し替え
 *   （スライダのドラッグ 1 ジェスチャを 1 コマンドに畳む）。
 * - `useUndoState()` で UI（ボタンの活性/ラベル）を購読。
 */
import { useSyncExternalStore } from "react";

export interface UndoCommand {
  /** UI 表示・デバッグ用のラベル。 */
  label: string;
  undo: () => void;
  redo: () => void;
  /** 同一キーの連続 push を 1 コマンドに合体（例: `opacity:<id>`）。 */
  coalesceKey?: string;
}

const MAX_STACK = 100;
let undoStack: UndoCommand[] = [];
let redoStack: UndoCommand[] = [];
const listeners = new Set<() => void>();

/** UI 購読用のスナップショット（参照が変わると再描画）。 */
export interface UndoSnapshot {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  version: number;
}
let snapshot: UndoSnapshot = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, version: 0 };

function refresh(): void {
  snapshot = {
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoLabel: undoStack.length ? undoStack[undoStack.length - 1].label : null,
    redoLabel: redoStack.length ? redoStack[redoStack.length - 1].label : null,
    version: snapshot.version + 1,
  };
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

/** 操作を記録（適用は呼び出し側で済ませておく）。 */
export function pushCommand(cmd: UndoCommand): void {
  const top = undoStack[undoStack.length - 1];
  if (cmd.coalesceKey && top && top.coalesceKey === cmd.coalesceKey) {
    // 同一ジェスチャの継続: undo は最初の状態を保持、redo のみ最新へ。
    top.redo = cmd.redo;
    top.label = cmd.label;
    redoStack = [];
    refresh();
    return;
  }
  undoStack.push(cmd);
  if (undoStack.length > MAX_STACK) undoStack.shift();
  redoStack = [];
  refresh();
}

/** 内部からのプログラム的変更中は記録を抑止する（undo/redo 実行中の二重記録防止）。 */
let suppress = false;
export function isSuppressed(): boolean {
  return suppress;
}
/** fn 実行中の pushCommand を無視する。 */
export function withoutRecording<T>(fn: () => T): T {
  const prev = suppress;
  suppress = true;
  try {
    return fn();
  } finally {
    suppress = prev;
  }
}

/** 記録（suppress 中は無視）。scene3d 等の公開 API から使う。 */
export function record(cmd: UndoCommand): void {
  if (suppress) return;
  pushCommand(cmd);
}

export function undo(): void {
  const cmd = undoStack.pop();
  if (!cmd) return;
  withoutRecording(() => {
    try {
      cmd.undo();
    } catch {
      /* ignore */
    }
  });
  redoStack.push(cmd);
  refresh();
}

export function redo(): void {
  const cmd = redoStack.pop();
  if (!cmd) return;
  withoutRecording(() => {
    try {
      cmd.redo();
    } catch {
      /* ignore */
    }
  });
  undoStack.push(cmd);
  refresh();
}

export function clearUndo(): void {
  undoStack = [];
  redoStack = [];
  refresh();
}

export function getUndoSnapshot(): UndoSnapshot {
  return snapshot;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** React フック: Undo/Redo 状態（ボタン活性・ラベル）を購読。 */
export function useUndoState(): UndoSnapshot {
  return useSyncExternalStore(subscribe, getUndoSnapshot, getUndoSnapshot);
}
