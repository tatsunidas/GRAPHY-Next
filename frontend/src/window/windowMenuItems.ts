/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Window メニュー（フルスクリーン・最大化・最小化・元に戻す）の項目と、窓の状態を追う hook。
// メイン・2D・3D のメニューバーが共有する。デスクトップ（Electron）専用: web では null を返し、メニュー自体を出さない。
import { useCallback, useEffect, useState } from "react";
import { desktop, type WindowAction } from "../desktopBridge";

export interface WindowState {
  maximized: boolean;
  fullscreen: boolean;
  minimized: boolean;
}

export interface WindowMenuItem {
  label: string;
  onClick: () => void;
  disabled: boolean;
  testId: string;
}

const NORMAL: WindowState = { maximized: false, fullscreen: false, minimized: false };

/** F11 は Win/Linux のみ（macOS のフルスクリーンは OS 標準の ⌃⌘F）。 */
function fullscreenHint(platform: string): string {
  return /^Mac/i.test(platform) ? "⌃⌘F" : "F11";
}

export function windowMenuItems(
  t: (key: string) => string,
  state: WindowState,
  run: (action: WindowAction) => void,
  platform = typeof navigator !== "undefined" ? navigator.platform : "",
): WindowMenuItem[] {
  const hint = fullscreenHint(platform);
  const normal = !state.maximized && !state.fullscreen;
  return [
    {
      label: `${t("window.fullscreen")} (${hint})`,
      onClick: () => run("fullscreen"),
      disabled: state.fullscreen, // 抜けるのは「元に戻す」か F11
      testId: "menu-item-window-fullscreen",
    },
    {
      label: t("window.maximize"),
      onClick: () => run("maximize"),
      disabled: state.maximized && !state.fullscreen,
      testId: "menu-item-window-maximize",
    },
    { label: t("window.minimize"), onClick: () => run("minimize"), disabled: false, testId: "menu-item-window-minimize" },
    {
      label: t("window.restore"),
      onClick: () => run("restore"),
      disabled: normal,
      testId: "menu-item-window-restore",
    },
  ];
}

/**
 * Window メニューの項目。デスクトップでなければ null（メニューを出さない）。
 * 窓の状態は、最初と、リサイズ（最大化・フルスクリーンの切り替えでも起きる）と操作のあとに取り直す。
 */
export function useWindowMenu(t: (key: string) => string): WindowMenuItem[] | null {
  const bridge = desktop();
  const available = !!bridge?.windowControl && !!bridge?.windowState;
  const [state, setState] = useState<WindowState>(NORMAL);

  const refresh = useCallback(() => {
    const b = desktop();
    if (!b?.windowState) return;
    void b.windowState().then((r) => {
      if (r.ok) setState({ maximized: r.maximized, fullscreen: r.fullscreen, minimized: r.minimized });
    });
  }, []);

  useEffect(() => {
    if (!available) return;
    refresh();
    window.addEventListener("resize", refresh);
    return () => window.removeEventListener("resize", refresh);
  }, [available, refresh]);

  if (!available) return null;
  const run = (action: WindowAction) => {
    void desktop()!.windowControl!(action).then((r) => {
      if (r.ok) setState({ maximized: r.maximized, fullscreen: r.fullscreen, minimized: r.minimized });
    });
  };
  return windowMenuItems(t, state, run);
}
