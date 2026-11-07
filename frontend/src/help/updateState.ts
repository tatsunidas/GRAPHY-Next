/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 自動更新の進行（main の UpdateController の状態）を、ウィンドウ内で 1 つ持つストア。
// main が全ウィンドウへ送る通知（graphy:update-state）を購読する。web 版（desktop が無い）では常に idle。

import { useSyncExternalStore } from "react";
import { desktop, type UpdateProgress } from "../desktopBridge";

let state: UpdateProgress = { phase: "idle" };
const listeners = new Set<() => void>();
let started = false;
/** このウィンドウで更新を始めたか（失敗の通知を、始めたウィンドウだけで出すため）。 */
let startedHere = false;

function set(next: UpdateProgress): void {
  state = next;
  for (const l of listeners) l();
}

function ensureSubscribed(): void {
  if (started) return;
  started = true;
  const d = desktop();
  if (!d) return;
  void d.updateState?.().then((s) => { if (s) set(s); }).catch(() => {});
  d.onUpdateState?.((s) => set(s));
}

export function getUpdateState(): UpdateProgress {
  ensureSubscribed();
  return state;
}

function subscribe(l: () => void): () => void {
  ensureSubscribed();
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useUpdateState(): UpdateProgress {
  return useSyncExternalStore(subscribe, getUpdateState);
}

export function wasUpdateStartedHere(): boolean {
  return startedHere;
}

/** 「今すぐ」「終了時」を選んだ。ダウンロードはここで初めて始まる。 */
export async function startUpdate(mode: "now" | "onQuit"): Promise<{ ok: boolean; reason?: string }> {
  const d = desktop();
  if (!d?.updateStart) return { ok: false, reason: "unavailable" };
  startedHere = true;
  return d.updateStart(mode);
}

export async function cancelUpdate(): Promise<void> {
  await desktop()?.updateCancel?.();
}

/** テスト用: 状態を入れる（通知の代わり）。 */
export function __setUpdateStateForTest(s: UpdateProgress): void {
  set(s);
}
