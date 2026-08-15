/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * レポートへ差し込める「直近の解析結果」の登録簿（`fw/angio-design.md` §21.5 / A14）。
 *
 * <p>解析はビューアのウィンドウで走り、レポートはメイン（またはレポート）ウィンドウで書く。
 * **別ウィンドウなので `BroadcastChannel` で配る**（`xaRecon3dStore` と同じ作法。
 * あちらでウィンドウ跨ぎを取りこぼした経験がそのまま効いている）。
 *
 * <p>⚠️ **`localStorage` に置かない。** automator の実行を跨いで前回の結果が残り、
 * 「前の検証の数値がレポートに出る」という気づきにくい汚染になる
 * （`automator-verification-hygiene` の既知の罠）。代わりに、常時開いているメインウィンドウが
 * 中継役として保持する（`ensureAnalysisResultChannel()` を `App.tsx` から呼ぶ）。
 */

import { useSyncExternalStore } from "react";
import { assertHasCaveats, type AnalysisResultRecord } from "./analysisResults";

let records: AnalysisResultRecord[] = [];
const listeners = new Set<() => void>();

/** 保持する上限。古いものから捨てる（レポートに使うのは直近の解析だけ）。 */
const MAX = 20;

function notify(): void {
  records = records.slice();
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

const CHANNEL = "graphy-analysis-results";
type Msg = { type: "add"; record: AnalysisResultRecord } | { type: "request" } | { type: "sync"; records: AnalysisResultRecord[] };

let channel: BroadcastChannel | null = null;

function post(msg: Msg): void {
  try {
    channel?.postMessage(msg);
  } catch {
    /* 非対応環境では単一ウィンドウとして動く */
  }
}

function merge(incoming: readonly AnalysisResultRecord[]): void {
  let changed = false;
  let next = records;
  for (const r of incoming) {
    const cur = next.find((x) => x.id === r.id);
    if (cur && cur.at >= r.at) continue;
    next = [...next.filter((x) => x.id !== r.id), r];
    changed = true;
  }
  if (!changed) return;
  records = next.slice(-MAX);
  notify();
}

function ensureChannel(): void {
  if (channel || typeof BroadcastChannel === "undefined") return;
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {
    channel = null;
    return;
  }
  channel.onmessage = (e) => {
    const msg = e.data as Msg;
    if (msg.type === "add") merge([msg.record]);
    else if (msg.type === "sync") merge(msg.records);
    else if (msg.type === "request" && records.length > 0) post({ type: "sync", records });
  };
  post({ type: "request" });
}

/** メインウィンドウから呼ぶ（中継役として参加する）。 */
export function ensureAnalysisResultChannel(): void {
  ensureChannel();
}

/**
 * 解析結果を登録する。
 *
 * <p>🚨 **注意書きの無い記録は受け付けない**（{@link assertHasCaveats}）。
 * レポートに載ってから気づいても遅い。
 */
export function publishAnalysisResult(record: AnalysisResultRecord): void {
  assertHasCaveats(record);
  ensureChannel();
  records = [...records.filter((r) => r.id !== record.id), record].slice(-MAX);
  notify();
  post({ type: "add", record });
}

export function listAnalysisResults(): AnalysisResultRecord[] {
  return records;
}

export function clearAnalysisResults(): void {
  if (records.length === 0) return;
  records = [];
  notify();
}

/** 指定スタディの結果だけ（レポートは 1 スタディに紐づく）。 */
export function useAnalysisResults(studyUid: string | null): AnalysisResultRecord[] {
  const all = useSyncExternalStore(
    (cb) => {
      ensureChannel();
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    listAnalysisResults,
    listAnalysisResults,
  );
  // 🚨 **別スタディの結果を出さない**。取り違えたまま差し込むと、レポートに他患者の数値が載る。
  return studyUid ? all.filter((r) => r.studyUid === studyUid) : [];
}
