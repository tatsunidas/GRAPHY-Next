/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// キーボードショートカットの単一ソース。fw/keyboard-shortcuts.md と同期すること。
// combo: "Mod+," / "Mod+Shift+Z" / "Escape" / "?" / "ArrowUp" / "Space" / "W" など。
//   Mod = Win/Linux:Ctrl, macOS:Cmd。
// planned=true は将来配線（ハンドラ未登録でも一覧には表示）。
// 文脈依存（例: Esc はダイアログが開いていれば閉じ、ビューアでは表示リセット）は
//   有効な Window/Dialog 側で挙動を切り替える。

export type ShortcutGroup = "global" | "tools" | "navigation" | "display" | "system";

export interface ShortcutDef {
  id: string;
  combo: string;
  /** 説明の i18n キー。 */
  descriptionKey: string;
  group: ShortcutGroup;
  planned?: boolean;
}

export const SHORTCUTS: ShortcutDef[] = [
  // --- グローバル（実装済み） ---
  { id: "open-settings", combo: "Mod+,", descriptionKey: "sc.openSettings", group: "global" },
  { id: "open-db", combo: "Mod+Shift+D", descriptionKey: "sc.openDb", group: "global" },
  { id: "show-help", combo: "?", descriptionKey: "sc.showHelp", group: "global" },
  { id: "close-dialog", combo: "Escape", descriptionKey: "sc.closeDialog", group: "global" },

  // --- ツール（将来・予約） ---
  { id: "tool-wl", combo: "W", descriptionKey: "sc.toolWl", group: "tools", planned: true },
  { id: "tool-pan", combo: "P", descriptionKey: "sc.toolPan", group: "tools", planned: true },
  { id: "tool-zoom", combo: "Z", descriptionKey: "sc.toolZoom", group: "tools", planned: true },
  { id: "tool-length", combo: "L", descriptionKey: "sc.toolLength", group: "tools", planned: true },
  { id: "tool-angle", combo: "A", descriptionKey: "sc.toolAngle", group: "tools", planned: true },
  { id: "tool-roi-rect", combo: "R", descriptionKey: "sc.toolRoiRect", group: "tools", planned: true },
  { id: "tool-roi-ellipse", combo: "E", descriptionKey: "sc.toolRoiEllipse", group: "tools", planned: true },
  { id: "tool-crosshairs", combo: "C", descriptionKey: "sc.toolCrosshairs", group: "tools", planned: true },

  // --- 画像ナビゲーション ---
  { id: "nav-next-slice", combo: "ArrowDown", descriptionKey: "sc.navNextSlice", group: "navigation" },
  { id: "nav-prev-slice", combo: "ArrowUp", descriptionKey: "sc.navPrevSlice", group: "navigation" },
  { id: "nav-next-series", combo: "ArrowRight", descriptionKey: "sc.navNextSeries", group: "navigation", planned: true },
  { id: "nav-prev-series", combo: "ArrowLeft", descriptionKey: "sc.navPrevSeries", group: "navigation", planned: true },
  { id: "nav-cine", combo: "Space", descriptionKey: "sc.navCine", group: "navigation" },
  { id: "nav-first", combo: "Home", descriptionKey: "sc.navFirst", group: "navigation" },
  { id: "nav-last", combo: "End", descriptionKey: "sc.navLast", group: "navigation" },

  // --- 表示調整・リセット ---
  { id: "disp-reset", combo: "Escape", descriptionKey: "sc.dispReset", group: "display", planned: true },
  { id: "disp-invert", combo: "I", descriptionKey: "sc.dispInvert", group: "display" },
  { id: "disp-overlay", combo: "O", descriptionKey: "sc.dispOverlay", group: "display" },
  { id: "disp-fullscreen", combo: "F", descriptionKey: "sc.dispFullscreen", group: "display", planned: true },

  // --- 汎用・システム（Redo は Win:Ctrl+Y / Mac:Cmd+Shift+Z） ---
  { id: "sys-undo", combo: "Mod+Z", descriptionKey: "sc.sysUndo", group: "system" },
  { id: "sys-redo", combo: "Mod+Shift+Z", descriptionKey: "sc.sysRedo", group: "system" },
  { id: "sys-delete", combo: "Delete", descriptionKey: "sc.sysDelete", group: "system", planned: true },
];

const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

/** combo を OS に応じた表示文字列に（Mod→Ctrl/⌘）。 */
export function displayCombo(combo: string): string {
  const SYM: Record<string, string> = {
    Mod: IS_MAC ? "⌘" : "Ctrl",
    Shift: IS_MAC ? "⇧" : "Shift",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Space: "Space",
    Escape: "Esc",
  };
  return combo
    .split("+")
    .map((p) => SYM[p] ?? p)
    .join(IS_MAC ? "" : " + ");
}

/** keydown イベントが combo に一致するか。 */
export function matchesCombo(combo: string, e: KeyboardEvent): boolean {
  const parts = combo.split("+");
  const wantMod = parts.includes("Mod");
  const wantShift = parts.includes("Shift");
  const key = parts[parts.length - 1];

  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (wantMod !== mod) return false;
  if (wantShift !== e.shiftKey) return false;
  // Mod 不要なのに Ctrl/Cmd が押されていたら不一致（Ctrl+R リロード等の誤爆防止）
  if (!wantMod && (IS_MAC ? e.metaKey : e.ctrlKey)) return false;

  const eventKey = key === "Space" ? " " : key;
  return e.key === eventKey || e.key.toLowerCase() === eventKey.toLowerCase();
}
