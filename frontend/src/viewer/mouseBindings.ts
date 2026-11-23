/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 2D・動画ビューアの**中・右・戻る・進むボタンに割り当てるツール**（利用者の設定）。
 *
 * <p>左ボタンは従来どおりツールバーで選んだツール。ほかのボタンだけを設定で変えられる。**既定は従来の固定値**
 * （中＝Pan、右＝Zoom、戻る・進む＝なし）なので、設定しなければ挙動は変わらない。
 *
 * <p>ここは React・Cornerstone に依存しない純関数とランタイムの保持。Cornerstone への適用は
 * `mouseBindingsApply.ts`。別ウィンドウ（`#2dviewer` など）へは BroadcastChannel（と storage イベント）で配る。
 */
import { useSyncExternalStore } from "react";
import { fetchSettings, saveSettings } from "../settings/settingsApi";

export type MouseButtonTool = "pan" | "zoom" | "windowLevel" | "none";

/** サイドボタンのクリックで実行できる操作（2D ビューア画面の既存の操作。新しい挙動は作らない）。 */
export type MouseCommand = "reset" | "fit" | "invert" | "flipH" | "flipV" | "rotate90" | "syncOn" | "syncOff" | "undo" | "redo";
export const MOUSE_COMMANDS: MouseCommand[] = ["reset", "fit", "invert", "flipH", "flipV", "rotate90", "syncOn", "syncOff", "undo", "redo"];
/** 戻る・進むに割り当てられるもの: ドラッグのツール、またはクリックの操作（`cmd:<MouseCommand>`）。 */
export type MouseButtonAction = MouseButtonTool | `cmd:${MouseCommand}`;
export const MOUSE_SIDE_ACTIONS: MouseButtonAction[] = [
  ...(["pan", "zoom", "windowLevel", "none"] as MouseButtonTool[]),
  ...MOUSE_COMMANDS.map((c) => `cmd:${c}` as const),
];

export interface MouseBindingTable {
  middle: MouseButtonTool;
  right: MouseButtonTool;
  /** サイドボタン（戻る＝第 4、進む＝第 5）。ツール（ドラッグ）か操作（クリック）。 */
  back: MouseButtonAction;
  forward: MouseButtonAction;
}

/** `cmd:reset` → `reset`。操作でなければ null。 */
export function commandOf(action: MouseButtonAction): MouseCommand | null {
  return action.startsWith("cmd:") ? (action.slice(4) as MouseCommand) : null;
}

export const MOUSE_BUTTON_TOOLS: MouseButtonTool[] = ["pan", "zoom", "windowLevel", "none"];
export const DEFAULT_MOUSE_BINDINGS: MouseBindingTable = { middle: "pan", right: "zoom", back: "none", forward: "none" };

export const MOUSE_SETTING_KEYS = {
  middle: "mouse.middle",
  right: "mouse.right",
  back: "mouse.back",
  forward: "mouse.forward",
} as const;
const MOUSE_SETTING_KEY_LIST: string[] = Object.values(MOUSE_SETTING_KEYS);
/** 設定キーが、このモジュールの割り当て（中・右・戻る・進む）のものか。 */
export function isMouseSettingKey(key: string): boolean {
  return MOUSE_SETTING_KEY_LIST.includes(key);
}

/** 設定値（文字列・未知の値・undefined）を安全に解釈する。純関数。未知の値は既定に置き換える。 */
export function parseMouseBindings(settings: Record<string, string> | undefined): MouseBindingTable {
  const pick = <T extends string>(v: string | undefined, allowed: readonly string[], dflt: T): T =>
    allowed.includes(v as string) ? (v as T) : dflt;
  return {
    middle: pick(settings?.[MOUSE_SETTING_KEYS.middle], MOUSE_BUTTON_TOOLS, DEFAULT_MOUSE_BINDINGS.middle),
    right: pick(settings?.[MOUSE_SETTING_KEYS.right], MOUSE_BUTTON_TOOLS, DEFAULT_MOUSE_BINDINGS.right),
    back: pick(settings?.[MOUSE_SETTING_KEYS.back], MOUSE_SIDE_ACTIONS, DEFAULT_MOUSE_BINDINGS.back),
    forward: pick(settings?.[MOUSE_SETTING_KEYS.forward], MOUSE_SIDE_ACTIONS, DEFAULT_MOUSE_BINDINGS.forward),
  };
}

/** 抽象のボタン。Cornerstone の `MouseBindings` への写しは `mouseBindingsApply.ts`。 */
export type AbstractButton = "primary" | "auxiliary" | "secondary" | "fourth" | "fifth" | "touch2";

export interface ToolNames {
  windowLevel: string;
  pan: string;
  zoom: string;
}

/**
 * 左ボタンのツール `primaryTool` と中・右の割り当てから、**ツールごとに付けるボタン**を求める。純関数。
 *
 * <p>返す Record に無いツールは、どのボタンにも付かない（呼ぶ側で passive にする）。
 * ボタンの並びは primary → auxiliary（中）→ secondary（右）→ fourth（戻る）→ fifth（進む）→ touch2 の順。2 本指タッチは常に Zoom
 * （ピンチ拡大縮小＋平行移動を同時に扱えるのが ZoomTool のため）。
 */
export function computeToolBindings(
  primaryTool: string,
  table: MouseBindingTable,
  names: ToolNames,
  opts: { touchZoom: boolean },
): Record<string, AbstractButton[]> {
  const out: Record<string, AbstractButton[]> = {};
  const add = (tool: string, b: AbstractButton) => {
    const list = (out[tool] ??= []);
    if (!list.includes(b)) list.push(b);
  };
  // 操作（cmd:*）と「なし」はツールではないので、Cornerstone の割り当てを作らない。
  const nameOf = (t: MouseButtonAction): string | null =>
    t === "pan" ? names.pan : t === "zoom" ? names.zoom : t === "windowLevel" ? names.windowLevel : null;
  add(primaryTool, "primary");
  const mid = nameOf(table.middle);
  if (mid) add(mid, "auxiliary");
  const right = nameOf(table.right);
  if (right) add(right, "secondary");
  const back = nameOf(table.back);
  if (back) add(back, "fourth");
  const forward = nameOf(table.forward);
  if (forward) add(forward, "fifth");
  if (opts.touchZoom) add(names.zoom, "touch2");
  return out;
}

// ---- ランタイムの保持（React の外の Cornerstone 周りからも読む） ----

let current: MouseBindingTable = { ...DEFAULT_MOUSE_BINDINGS };
const listeners = new Set<() => void>();
const CHANNEL = "graphy-mouse-bindings";
const LS_KEY = "graphy-mouse-bindings";

export function getMouseBindings(): MouseBindingTable {
  return current;
}

/** 割り当てを差し替える（変化が無ければ通知しない）。 */
export function setMouseBindings(next: MouseBindingTable): void {
  if (sameTable(next, current)) return;
  current = { ...next };
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch {
      /* 1 つの購読者の失敗で他を巻き込まない */
    }
  }
}

function sameTable(a: MouseBindingTable, b: MouseBindingTable): boolean {
  return a.middle === b.middle && a.right === b.right && a.back === b.back && a.forward === b.forward;
}

export function subscribeMouseBindings(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useMouseBindings(): MouseBindingTable {
  return useSyncExternalStore(subscribeMouseBindings, getMouseBindings);
}

/** 設定画面での変更を、実行中の全ウィンドウへ配って保存する。保存に失敗しても、実行中の窓には効かせる。 */
export function changeMouseBindings(next: MouseBindingTable): Promise<unknown> {
  setMouseBindings(next);
  broadcast(next);
  return saveSettings(tableToSettings(next));
}

function broadcast(table: MouseBindingTable): void {
  try {
    const bc = new BroadcastChannel(CHANNEL);
    bc.postMessage(table);
    bc.close();
  } catch {
    /* BroadcastChannel 非対応環境は localStorage のみ */
  }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...table, ts: Date.now() }));
  } catch {
    /* ストレージ不可は無視 */
  }
}

let loaded: Promise<void> | null = null;
let channelWired = false;

/** 保存済みの設定を 1 回だけ読み、他ウィンドウからの変更の受信も始める。呼び出しは何度でもよい。 */
export function ensureMouseBindingsLoaded(): Promise<void> {
  installSideButtonGuard();
  if (!channelWired) {
    channelWired = true;
    try {
      const bc = new BroadcastChannel(CHANNEL);
      bc.onmessage = (e) => setMouseBindings(parseMouseBindings(tableToSettings(e.data as MouseBindingTable)));
    } catch {
      /* 無ければ storage イベントだけ */
    }
    try {
      window.addEventListener("storage", (e) => {
        if (e.key !== LS_KEY || !e.newValue) return;
        try {
          setMouseBindings(parseMouseBindings(tableToSettings(JSON.parse(e.newValue) as MouseBindingTable)));
        } catch {
          /* 壊れた値は無視 */
        }
      });
    } catch {
      /* window が無い環境 */
    }
  }
  if (!loaded) {
    loaded = fetchSettings()
      .then((m) => setMouseBindings(parseMouseBindings(m)))
      .catch(() => {
        /* 読めなければ既定のまま（再試行できるよう印を戻す） */
        loaded = null;
      });
  }
  return loaded;
}

function tableToSettings(t: MouseBindingTable | undefined): Record<string, string> {
  return {
    [MOUSE_SETTING_KEYS.middle]: String(t?.middle),
    [MOUSE_SETTING_KEYS.right]: String(t?.right),
    [MOUSE_SETTING_KEYS.back]: String(t?.back),
    [MOUSE_SETTING_KEYS.forward]: String(t?.forward),
  };
}

/**
 * 割り当てたサイドボタン（戻る＝button 3、進む＝button 4）の**既定動作（ページの戻る・進む）を止める**。
 * 割り当てていないボタンには触らない。`stopPropagation` はしない（Cornerstone にはそのまま届く）。
 * 適用範囲は document 全体（離す位置が画像の外でも効かせるため）。純関数 {@link shouldGuardSideButton} で判定する。
 */
export function shouldGuardSideButton(button: number, table: MouseBindingTable): boolean {
  return (button === 3 && table.back !== "none") || (button === 4 && table.forward !== "none");
}

/** 2D ビューア画面の操作（`Viewer2DScreen` の `actions`）のうち、ここで使う面だけ。 */
export interface MouseCommandActions {
  reset(): void;
  fit(): void;
  invert(): void;
  flipH(): void;
  flipV(): void;
  rotate90(): void;
  undo(): void;
  redo(): void;
  setSyncTargets(sync: boolean): void;
}

/** 操作を実行する。**既存の操作へ 1 対 1 で渡すだけ**（新しい挙動を作らない）。未知の操作は false。 */
export function runMouseCommand(cmd: MouseCommand, a: MouseCommandActions): boolean {
  switch (cmd) {
    case "reset": a.reset(); return true;
    case "fit": a.fit(); return true;
    case "invert": a.invert(); return true;
    case "flipH": a.flipH(); return true;
    case "flipV": a.flipV(); return true;
    case "rotate90": a.rotate90(); return true;
    case "undo": a.undo(); return true;
    case "redo": a.redo(); return true;
    case "syncOn": a.setSyncTargets(true); return true;
    case "syncOff": a.setSyncTargets(false); return true;
    default: return false;
  }
}

/** クリックとみなす移動量の上限 [px]（2D ビューアの右クリックのメニュー判定 `RIGHT_CLICK_SLOP_PX` と同じ）。 */
export const SIDE_CLICK_SLOP_PX = 4;

/** 画面（2D ビューア）が、サイドボタンのクリックで操作を実行する口を 1 つ登録する。 */
type MouseCommandHandler = (cmd: MouseCommand, target: EventTarget | null) => void;
let commandHandler: MouseCommandHandler | null = null;
export function registerMouseCommandHandler(handler: MouseCommandHandler): () => void {
  commandHandler = handler;
  return () => {
    if (commandHandler === handler) commandHandler = null;
  };
}

/**
 * サイドボタンの**クリック**（同じボタンを {@link SIDE_CLICK_SLOP_PX} 以内で押して離す）が、操作の割り当てなら、登録済みの口へ渡す。
 * 口が無い窓（動画だけの窓など）では何もしない。純関数。
 */
export function sideClickCommand(
  down: { button: number; x: number; y: number } | null,
  up: { button: number; x: number; y: number },
  table: MouseBindingTable,
): MouseCommand | null {
  if (!down || down.button !== up.button) return null;
  if (Math.hypot(up.x - down.x, up.y - down.y) > SIDE_CLICK_SLOP_PX) return null;
  const action = up.button === 3 ? table.back : up.button === 4 ? table.forward : null;
  return action ? commandOf(action) : null;
}

let guardInstalled = false;
export function installSideButtonGuard(): void {
  if (guardInstalled || typeof document === "undefined") return;
  guardInstalled = true;
  let down: { button: number; x: number; y: number } | null = null;
  const handler = (e: MouseEvent) => {
    if (shouldGuardSideButton(e.button, current)) e.preventDefault();
    if (e.type === "mousedown") {
      down = e.button === 3 || e.button === 4 ? { button: e.button, x: e.clientX, y: e.clientY } : null;
    } else if (e.type === "mouseup") {
      const cmd = sideClickCommand(down, { button: e.button, x: e.clientX, y: e.clientY }, current);
      down = null;
      if (cmd && commandHandler) commandHandler(cmd, e.target);
    }
  };
  for (const type of ["mousedown", "mouseup", "auxclick"] as const) document.addEventListener(type, handler, true);
}
