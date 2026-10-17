/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";
import { fetchSettings, type SettingsMap } from "../settings/settingsApi";
import { log } from "../log";

/** 環境設定キー。シリーズビューのツールパネルを最初から開くか（既定: 開かない）。 */
export const TOOL_PANEL_DEFAULT_KEY = "viewer.toolPanelDefault";

/** 設定値（文字列の KV）から既定の開閉を決める。未設定・不正値は閉。 */
export function parseToolPanelDefault(settings: SettingsMap | null | undefined): boolean {
  return settings?.[TOOL_PANEL_DEFAULT_KEY] === "true";
}

/**
 * ツールパネルを既定で開くか。設定の取得が済むまでは null（呼び出し側は閉として扱う）。
 * 取得に失敗したときも閉（false）に確定させ、理由はログに残す。
 */
export function useToolPanelDefault(): boolean | null {
  const [value, setValue] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchSettings()
      .then((s) => { if (!cancelled) setValue(parseToolPanelDefault(s)); })
      .catch((e) => {
        log.warn("viewer.toolPanelDefault: 設定を取得できないため閉で表示します", e);
        if (!cancelled) setValue(false);
      });
    return () => { cancelled = true; };
  }, []);
  return value;
}
