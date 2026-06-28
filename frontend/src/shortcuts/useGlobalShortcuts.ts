import { useEffect } from "react";
import { SHORTCUTS, matchesCombo } from "./registry";

/**
 * グローバルなキーボードショートカットを購読する。
 * @param handlers shortcut id -> ハンドラ。登録されている id のみ発火する。
 */
export function useGlobalShortcuts(handlers: Record<string, (() => void) | undefined>) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable === true;

      for (const sc of SHORTCUTS) {
        if (sc.planned) continue;
        if (!matchesCombo(sc.combo, e)) continue;
        // 入力中は Esc 以外のショートカットを無効化（誤爆防止）
        if (typing && sc.combo !== "Escape") return;
        const handler = handlers[sc.id];
        if (handler) {
          e.preventDefault();
          handler();
        }
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handlers]);
}
