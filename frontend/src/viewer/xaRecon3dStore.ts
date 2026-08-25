/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D QCA（A6a）に使える「2D QCA 実行済みの方向」の登録簿。
 *
 * <h3>なぜ登録簿にするのか</h3>
 * 3D 再構成には**2 方向**が要るが、2D QCA は「今表示しているフレーム」に対して走る。
 * 2 つの方向を同時に画面へ出す UI を作るより、**各方向で 2D QCA を済ませてから合成する**ほうが
 * 既存の導線（中心線抽出・手修正・校正）をそのまま使えて、実際の製品の使い方とも合う。
 *
 * <p>非リアクティブな配列＋`useSyncExternalStore` で持つ（`scene3dStore.ts` と同じ流儀）。
 * 保持するのは**中心線と幾何だけ**で、画素は持たない（メモリを食うのと、再解析すれば作れるため）。
 *
 * <h3>🚨 ウィンドウを跨ぐ</h3>
 * 2D ビューアは**シリーズごとに別ウィンドウ**で開く。方向 A と方向 B は別ウィンドウで解析される
 * ので、モジュール変数に置いただけでは**どちらのウィンドウからも 1 件しか見えない**
 * （実機検証で最初にここに突き当たった）。`BroadcastChannel` で同一オリジンの他ウィンドウへ配る。
 *
 * <p>後から開いたウィンドウは過去の登録を知らないので、起動時に**問い合わせを投げて**
 * 既存ウィンドウに返させる（`request` → `sync`）。
 *
 * <p>⚠️ **セッション限り**。永続化しないのは意図的で、`localStorage` に置くと
 * **automator の実行を跨いで前回のデータが残る**（`automator-verification-hygiene` の既知の罠）。
 * その代わり、全ウィンドウを閉じると登録は消える。永続化は残件
 * （設計ヘッダの「校正値の永続化」と同じ扱い）。
 */

import { useSyncExternalStore } from "react";
import { formatViewAngles, type XaViewGeometry } from "./xaGeometry";
import { type QcaDiameterMethod } from "./qca";

export interface XaQcaRun {
  /** imageId（どのフレームを解析したか）。**鍵ではない**——{@link runKey} を見ること。 */
  imageId: string;
  /**
   * 登録の鍵 ＝ `imageId` ＋ **解析区間**。
   *
   * <p>🔴 **imageId だけを鍵にしてはいけない**（2026-08-16 の実機検証で判明）。
   * 分岐部（A6b）は**同じフレームから 3 本の区間**を解析するので、imageId を鍵にすると
   * 後の区間が前の区間を置き換えてしまい、**6 本登録したはずが 2 本しか残らない**。
   * 同じ区間を解析し直したときだけ置き換わるように、区間の端点まで鍵に含める。
   */
  runKey: string;
  studyUid: string;
  seriesUid: string;
  sopInstanceUid: string | null;
  /** 0 origin。 */
  frameIndex: number;
  /** 一覧に出す名前（角度とフレーム番号）。 */
  label: string;
  geometry: XaViewGeometry;
  /** 中心線（画像 px・近位→遠位）。 */
  centerline: [number, number][];
  /**
   * 各中心線点の径。**`unit` が "px" のときは断面の合成に使えない**（mm でないと面積が出ない）。
   * 点数は `centerline` と同じとは限らない（QCA の計測点は中心線の部分集合）。
   */
  diameters: number[];
  /** 径の対応する中心線インデックス。 */
  diameterPathIndices: number[];
  unit: "mm" | "px";
  /**
   * 径を何で測ったか（§16.5）。**3D 側も出自を失わない**ための項目。
   * 半値法と密度計測では絶対値が 10% 以上違うので、合成した断面積の意味も変わる。
   */
  diameterMethod: QcaDiameterMethod;
  /** 手修正が入っているか（出自を 3D 側でも失わない）。 */
  edited: boolean;
  at: number;
}

let runs: XaQcaRun[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  runs = runs.slice();
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

/* ── ウィンドウ間の同期 ─────────────────────────────────────── */

const CHANNEL = "graphy-xa-recon3d";
type Msg =
  | { type: "register"; run: XaQcaRun }
  | { type: "remove"; runKey: string }
  | { type: "request" }
  | { type: "sync"; runs: XaQcaRun[] };

let channel: BroadcastChannel | null = null;

function post(msg: Msg): void {
  try {
    channel?.postMessage(msg);
  } catch {
    /* BroadcastChannel 非対応環境では単一ウィンドウとして動く */
  }
}

/**
 * 受け取った登録を取り込む（**通知はするが再送しない**＝無限ループを避ける）。
 *
 * <p>🔴 **突き合わせは `runKey`**（imageId ではない）。ここだけ imageId のままだと、
 * ウィンドウを跨いだ瞬間に**同じフレームの 3 区間が 1 本に潰れる**——登録側を
 * runKey に直しても、受け側が古い鍵なら同じ症状が別の場所で再発する
 * （分岐部で「6 本のはずが 4 本」として実際に出た）。
 */
function merge(incoming: readonly XaQcaRun[]): void {
  let changed = false;
  let next = runs;
  for (const run of incoming) {
    const cur = next.find((r) => r.runKey === run.runKey);
    // 同じ区間を解析し直した場合は新しいほうを採る。
    if (cur && cur.at >= run.at) continue;
    next = [...next.filter((r) => r.runKey !== run.runKey), run];
    changed = true;
  }
  if (!changed) return;
  runs = next;
  notify();
}

/** 他ウィンドウからの削除を取り込む（自分は再送しない）。 */
function applyRemove(runKey: string): void {
  const next = runs.filter((r) => r.runKey !== runKey);
  if (next.length === runs.length) return;
  runs = next;
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
  // Node（vitest）では開いたチャンネルがプロセスを生かし続ける。ブラウザには無いメソッドなので
  // 任意呼び出しにする（挙動は変わらない。テストが終わらなくなるのを防ぐだけ）。
  (channel as unknown as { unref?: () => void }).unref?.();
  channel.onmessage = (e) => {
    const msg = e.data as Msg;
    if (msg.type === "register") merge([msg.run]);
    else if (msg.type === "remove") applyRemove(msg.runKey);
    else if (msg.type === "sync") merge(msg.runs);
    // 問い合わせには**自分が持っているぶんだけ**返す（持っていなければ黙る）。
    else if (msg.type === "request" && runs.length > 0) post({ type: "sync", runs });
  };
  // 後から開いたウィンドウが過去の登録を拾えるようにする。
  post({ type: "request" });
}

/**
 * チャンネルに参加する（登録が無くても）。
 *
 * <p>🚨 **メインウィンドウから必ず呼ぶこと。** 2D ビューアは 1 つのウィンドウを使い回すので、
 * 方向 A を解析 → ビューアを閉じる → 方向 B を解析、という順になると、**A の登録を覚えている
 * ウィンドウが誰も居なくなる**。セッション中ずっと開いているメインウィンドウを中継役にして、
 * そこに溜める（実機検証で最初にここに突き当たった）。
 */
export function ensureQcaRunChannel(): void {
  ensureChannel();
}

/**
 * チャンネルから抜けて、登録を捨てる（＝このウィンドウは中継役をやめる）。
 *
 * <p>ウィンドウが閉じるときにブラウザが後始末するので本番では要らない。**テストで要る**——
 * 同一プロセスに複数のインスタンスを作って「ウィンドウ跨ぎ」を再現するので、閉じないと
 * **前のテストのウィンドウが問い合わせに答えてしまい**、検査が次々に汚染される（実際に踏んだ）。
 */
export function closeQcaRunChannel(): void {
  try {
    channel?.close();
  } catch {
    /* ignore */
  }
  channel = null;
  runs = [];
  notify();
}

/** 同じ imageId の登録は置き換える（解析し直したら新しいほうが正しい）。 */
export function registerQcaRun(run: XaQcaRun): void {
  ensureChannel();
  // 同じ区間の解析し直しだけを置き換える（別の区間は足す）。
  runs = [...runs.filter((r) => r.runKey !== run.runKey), run];
  notify();
  post({ type: "register", run });
}

export function removeQcaRun(runKey: string): void {
  ensureChannel();
  const next = runs.filter((r) => r.runKey !== runKey);
  // 自分が持っていなくても**他ウィンドウへは流す**（中継役のメインウィンドウが
  // 持っている場合があり、そこで消さないと一覧に残り続ける）。
  post({ type: "remove", runKey });
  if (next.length === runs.length) return;
  runs = next;
  notify();
}

export function listQcaRuns(): XaQcaRun[] {
  return runs;
}

export function clearQcaRuns(): void {
  if (runs.length === 0) return;
  runs = [];
  notify();
}

export function useQcaRuns(): XaQcaRun[] {
  return useSyncExternalStore(
    (cb) => {
      // 購読された時点でチャンネルを開く（＝ビューアを開いただけで他ウィンドウの登録を拾える）。
      ensureChannel();
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    listQcaRuns,
    listQcaRuns,
  );
}

/**
 * 解析区間まで含めた登録の鍵。**端点は丸めてから**使う（同じ計測を選び直しただけで
 * 別区間として増えないように）。
 */
export function qcaRunKey(imageId: string, start: readonly number[], end: readonly number[]): string {
  const r = (v: number) => Math.round(v);
  return `${imageId}#${r(start[0])},${r(start[1])}-${r(end[0])},${r(end[1])}`;
}

/** 一覧に出す名前。角度が分かれば角度で呼ぶ（利用者が方向を選ぶときの手掛かりはそれ）。 */
export function describeView(g: XaViewGeometry, frameIndex: number): string {
  return `${formatViewAngles(g.primaryAngleDeg, g.secondaryAngleDeg)} · f${frameIndex + 1}`;
}
