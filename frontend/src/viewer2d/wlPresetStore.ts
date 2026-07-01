/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// W/L プリセットの永続化（backend 設定キー `viewer.wlPresets` に JSON 直列化）＋
// 別ウィンドウ横断の変更通知（remoteAeEvents と同じ BroadcastChannel＋localStorage 二重経路）。
// GRAPHY WwWlPresets（単一プロパティ直列化＋既定フォールバック）の Next 版。

import { useEffect, useState } from "react";
import { fetchSettings, saveSettings } from "../settings/settingsApi";
import { DEFAULT_PRESETS, type WlPreset } from "./wlPresets";

const SETTINGS_KEY = "viewer.wlPresets";
const CHANNEL = "graphy-wl-presets";
const LS_KEY = "graphy-wl-presets-changed";

/** 1 件のプリセットとして妥当か（数値・名前）。 */
function normalize(v: unknown): WlPreset | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const center = Number(o.center);
  const width = Number(o.width);
  if (!Number.isFinite(center) || !Number.isFinite(width)) return null;
  const key = typeof o.key === "string" && o.key ? o.key : `p-${center}-${width}`;
  const name = typeof o.name === "string" ? o.name : undefined;
  const labelKey = typeof o.labelKey === "string" ? o.labelKey : undefined;
  return { key, name, labelKey, center, width };
}

/** 保存済みプリセットを取得。未設定/空/壊れは組み込み既定にフォールバック。 */
export async function loadWlPresets(): Promise<WlPreset[]> {
  try {
    const m = await fetchSettings();
    const raw = m[SETTINGS_KEY];
    if (!raw || !raw.trim()) return DEFAULT_PRESETS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_PRESETS;
    const list = parsed.map(normalize).filter((p): p is WlPreset => p !== null);
    return list.length > 0 ? list : DEFAULT_PRESETS;
  } catch {
    return DEFAULT_PRESETS;
  }
}

/** プリセット一覧を保存し、全ウィンドウへ変更通知。 */
export async function saveWlPresets(presets: WlPreset[]): Promise<void> {
  await saveSettings({ [SETTINGS_KEY]: JSON.stringify(presets) });
  emitWlPresetsChanged();
}

/** 組み込み既定に戻す（保存値をクリア → ロード時に既定へフォールバック）。 */
export async function resetWlPresets(): Promise<void> {
  await saveSettings({ [SETTINGS_KEY]: "" });
  emitWlPresetsChanged();
}

/** プリセット変更を他ウィンドウへ通知。 */
export function emitWlPresetsChanged(): void {
  const payload = JSON.stringify({ ts: Date.now() });
  try {
    const bc = new BroadcastChannel(CHANNEL);
    bc.postMessage(payload);
    bc.close();
  } catch {
    /* 非対応環境は localStorage のみ */
  }
  try {
    localStorage.setItem(LS_KEY, payload);
  } catch {
    /* ストレージ不可は無視 */
  }
}

/** プリセット変更通知を購読（返り値で解除）。 */
export function subscribeWlPresetsChanged(cb: () => void): () => void {
  let bc: BroadcastChannel | null = null;
  try {
    bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = () => cb();
  } catch {
    bc = null;
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key === LS_KEY && e.newValue) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    bc?.close();
    window.removeEventListener("storage", onStorage);
  };
}

/** 現在のプリセットを購読する React フック（変更通知で自動再読込）。 */
export function useWlPresets(): WlPreset[] {
  const [presets, setPresets] = useState<WlPreset[]>(DEFAULT_PRESETS);
  useEffect(() => {
    let alive = true;
    const reload = () =>
      loadWlPresets()
        .then((p) => {
          if (alive) setPresets(p);
        })
        .catch(() => {
          /* 既定のまま */
        });
    reload();
    const unsub = subscribeWlPresetsChanged(reload);
    return () => {
      alive = false;
      unsub();
    };
  }, []);
  return presets;
}
