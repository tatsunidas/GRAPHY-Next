/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 再構成済み血管モデル（A6a / A6b の結果）と、外部モジュールが返した解析値の登録簿。
 * `fw/angio-design.md` §11（A7 — Angio-FFR インターフェース）の土台。
 *
 * <h3>なぜ登録簿が要るのか</h3>
 * 3D 再構成の結果は、これまで {@link ../viewer3d/geometry3dContext} に**中心線だけ**を
 * 書いて 3D ウィンドウへ渡していた。あれは「開くときの使い捨ての引数」で、
 *
 * - **径も出自も持たない**（FFR の入力に足りない）
 * - **1 件しか置けない**（分岐部は 3 区間ある）
 * - **`runId` で指せない**（プラグインが「どの再構成か」を言えない）
 *
 * ので、A7 の契約（H11 / H12）はここに載せる。
 *
 * <h3>🔴 本体は FFR を計算しない</h3>
 * 流体解析・学習モデルは**外部（プラグイン）**の担当（§11.1）。本体がやるのは
 * **モデルを渡すこと**（H11）と、**返ってきた値を色で見せること**（H12）だけ。
 * したがってこの登録簿は「値の意味」を一切解釈しない——範囲も凡例名も免責文も、
 * 返してきた側が言うとおりに持ち回る。
 *
 * <h3>🚨 ウィンドウを跨ぐ</h3>
 * 解析ダイアログ（2D ビューアのウィンドウ）と 3D 表示（`#geometry3d` の別ウィンドウ）は
 * 別ウィンドウなので、モジュール変数に置くだけでは 3D 側から見えない。
 * {@link ./xaRecon3dStore} と同じ `BroadcastChannel` 方式で配る（同じ罠を 2 回踏まないよう、
 * 突き合わせの鍵・`request`/`sync` の作法もあちらに揃えてある）。
 *
 * <p>⚠️ **セッション限り**。永続化しないのは意図的（`xaRecon3dStore` と同じ理由＝
 * automator の実行を跨いで前回のデータが残るのを避ける）。結果そのものの保存は SR（§10.2.7）。
 */

import { useSyncExternalStore } from "react";
import { type QcaDiameterMethod } from "./qca";

/** 血管ツリーの 1 区間。分岐部は `parentId` で近位に繋がる。 */
export interface XaVesselSegment {
  /** モデル内で一意（単一血管は `"main"`、分岐部は `"proximal"` / `"distal"` / `"side"`）。 */
  id: string;
  /** 中心線（患者 LPS mm・近位→遠位）。 */
  points: [number, number, number][];
  /**
   * 各点の内腔径 [mm]。**測れなかった点は `null`**。
   *
   * <p>🔴 **0 や補間値で埋めないこと。** FFR ソルバは径から断面積を作るので、
   * 埋めた値は「そこが細い / 太い」という所見に化ける。測れていない点は
   * 測れていないと言うのが唯一の正しい渡し方。未校正（px）なら**全点 null**。
   */
  diameterMm: (number | null)[];
  /** 近位側の区間 id。根なら null。 */
  parentId: string | null;
}

/** 径をどう測ったか。系統誤差が方式で変わるので、値と一緒に必ず運ぶ（§16.4 / §16.5）。 */
export interface XaVesselCalibration {
  /**
   * 径が mm で出せているか。false なら {@link XaVesselSegment.diameterMm} は全点 null。
   * 🔴 **false のモデルで FFR を計算させてはいけない**——断面積が作れないので、
   * 受け取る側は計算を断るべき（本体は止めないが、この旗を見れば分かる）。
   */
  diameterCalibrated: boolean;
  /** 方向ごとの校正の出自（H35 と同じ語彙）。 */
  sources: string[];
  /** 方向ごとの縮退区分（H35 と同じ語彙）。`approximate` が混ざれば結果も近似。 */
  tiers: ("calibrated" | "approximate" | "uncalibrated")[];
  /**
   * 径の測り方（半値法 / 密度計測）。絶対値が 10% 以上変わる（§16.5）。
   * 🚨 2 方向で測り方が違えば `"mixed"`——合成した断面積は**どちらの意味でもない**。
   * 分からなければ null（推測で埋めない）。
   */
  diameterMethod: QcaDiameterMethod | "mixed" | null;
}

/** 「この数字はどこから来たのか」。受け取った側が注記を書けるだけの材料を渡す。 */
export interface XaVesselProvenance {
  studyUid: string;
  seriesUids: string[];
  sopUids: string[];
  /** 方向ごとの [primary, secondary] 角度 [deg]。 */
  angles: [number, number][];
  /** 角度補正（バンドル調整）が掛かったか。掛かっていない結果は歪みを含む（§10.2.2）。 */
  angleCorrected: boolean;
  /** 方向ごとの可視割合（短縮）。取れなければ null（§10.2.5）。 */
  visibleFractions: (number | null)[];
  /** アンカーの再投影誤差 RMS [px]。**幾何の検算はこれ**（対応付けの残差ではない）。 */
  anchorReprojectionPx: number;
  /** 2 方向の角度差 [deg]。 */
  separationDeg: number;
}

export interface XaVesselModel {
  /** プラグインが指す鍵。セッション内で一意。 */
  runId: string;
  kind: "xa-qca3d" | "xa-bifurcation3d";
  /** 一覧・凡例に出す名前。 */
  label: string;
  segments: XaVesselSegment[];
  calibration: XaVesselCalibration;
  provenance: XaVesselProvenance;
  at: number;
}

/** 中心線点ごとの解析値（H12 で外部モジュールが返してくるもの）。 */
export interface XaVesselAnalysisPoint {
  segmentId: string;
  /** {@link XaVesselSegment.points} の添字。 */
  index: number;
  value: number;
}

export interface XaVesselAnalysis {
  runId: string;
  kind: "ffr" | "custom";
  /** 凡例名（例 "FFR"）。 */
  label: string;
  /** 色マップの範囲 [min, max]（FFR なら [0.5, 1.0]）。 */
  range: [number, number];
  perPoint: XaVesselAnalysisPoint[];
  /**
   * モジュール提供元の免責文。**そのまま表示する**（本体は書き換えない・要約しない）。
   * 🔴 FFR は治療方針を左右する値なので、出所と限界が画面から消えてはいけない（§19）。
   */
  disclaimer?: string;
  /** 出自。**host が入れる**（プラグインには書かせない）。 */
  source: { pluginId: string; pluginName: string; version: string };
  at: number;
}

let models: XaVesselModel[] = [];
let analyses: XaVesselAnalysis[] = [];
const listeners = new Set<() => void>();

/** 直近 N 件だけ持つ（セッション限りなので上限は緩くてよい）。 */
const MAX_MODELS = 20;

function notify(): void {
  models = models.slice();
  analyses = analyses.slice();
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

/* ── ウィンドウ間の同期 ─────────────────────────────────────── */

const CHANNEL = "graphy-xa-vessel-model";
type Msg =
  | { type: "model"; model: XaVesselModel }
  | { type: "analysis"; analysis: XaVesselAnalysis }
  | { type: "request" }
  | { type: "sync"; models: XaVesselModel[]; analyses: XaVesselAnalysis[] };

let channel: BroadcastChannel | null = null;

function post(msg: Msg): void {
  try {
    channel?.postMessage(msg);
  } catch {
    /* BroadcastChannel 非対応環境では単一ウィンドウとして動く */
  }
}

/** 受け取ったモデルを取り込む（**通知はするが再送しない**＝無限ループを避ける）。 */
function mergeModels(incoming: readonly XaVesselModel[]): boolean {
  let changed = false;
  let next = models;
  for (const m of incoming) {
    const cur = next.find((x) => x.runId === m.runId);
    if (cur && cur.at >= m.at) continue;
    next = [...next.filter((x) => x.runId !== m.runId), m];
    changed = true;
  }
  if (!changed) return false;
  models = next.slice(-MAX_MODELS);
  return true;
}

function mergeAnalyses(incoming: readonly XaVesselAnalysis[]): boolean {
  let changed = false;
  let next = analyses;
  for (const a of incoming) {
    const cur = next.find((x) => x.runId === a.runId);
    if (cur && cur.at >= a.at) continue;
    next = [...next.filter((x) => x.runId !== a.runId), a];
    changed = true;
  }
  if (!changed) return false;
  analyses = next.slice(-MAX_MODELS);
  return true;
}

function ensureChannel(): void {
  if (channel || typeof BroadcastChannel === "undefined") return;
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {
    channel = null;
    return;
  }
  // Node（vitest）では開いたチャンネルがプロセスを生かし続ける（`xaRecon3dStore` と同じ）。
  (channel as unknown as { unref?: () => void }).unref?.();
  channel.onmessage = (e) => {
    const msg = e.data as Msg;
    if (msg.type === "model") {
      if (mergeModels([msg.model])) notify();
    } else if (msg.type === "analysis") {
      if (mergeAnalyses([msg.analysis])) notify();
    } else if (msg.type === "sync") {
      const a = mergeModels(msg.models);
      const b = mergeAnalyses(msg.analyses);
      if (a || b) notify();
    } else if (msg.type === "request" && (models.length > 0 || analyses.length > 0)) {
      post({ type: "sync", models, analyses });
    }
  };
  // 後から開いたウィンドウ（＝3D ウィンドウ）が過去の登録を拾えるようにする。
  post({ type: "request" });
}

/**
 * チャンネルに参加する（登録が無くても）。
 *
 * <p>🚨 **メインウィンドウから必ず呼ぶこと。** 解析ダイアログのウィンドウを閉じると
 * モデルを覚えている相手が居なくなり、あとから開いた 3D ウィンドウが空になる
 * （`xaRecon3dStore` で実際に踏んだのと同じ形）。
 */
export function ensureVesselModelChannel(): void {
  ensureChannel();
}

/** チャンネルから抜けて登録を捨てる（**テスト用**。`xaRecon3dStore` と同じ理由）。 */
export function closeVesselModelChannel(): void {
  try {
    channel?.close();
  } catch {
    /* ignore */
  }
  channel = null;
  models = [];
  analyses = [];
  notify();
}

/** 再構成結果を登録する。同じ `runId` は置き換える（解析し直したら新しいほうが正しい）。 */
export function registerVesselModel(model: XaVesselModel): void {
  ensureChannel();
  models = [...models.filter((m) => m.runId !== model.runId), model].slice(-MAX_MODELS);
  // 🔴 モデルを差し替えたら、その runId の解析値は捨てる。
  //    点数も形も変わりうるので、古い値をそのまま重ねると**別の血管の色**が乗る。
  analyses = analyses.filter((a) => a.runId !== model.runId);
  notify();
  post({ type: "model", model });
}

/** 外部モジュールが返した解析値を登録する（H12）。 */
export function putVesselAnalysis(analysis: XaVesselAnalysis): void {
  ensureChannel();
  analyses = [...analyses.filter((a) => a.runId !== analysis.runId), analysis].slice(-MAX_MODELS);
  notify();
  post({ type: "analysis", analysis });
}

export function listVesselModels(): XaVesselModel[] {
  return models;
}

export function getVesselModel(runId: string): XaVesselModel | null {
  return models.find((m) => m.runId === runId) ?? null;
}

export function getVesselAnalysis(runId: string): XaVesselAnalysis | null {
  return analyses.find((a) => a.runId === runId) ?? null;
}

function subscribe(cb: () => void): () => void {
  ensureChannel();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useVesselModels(): XaVesselModel[] {
  return useSyncExternalStore(subscribe, listVesselModels, listVesselModels);
}

/** 3D ウィンドウが「自分が出しているモデルの解析値」を購読するためのフック。 */
export function useVesselAnalysis(runId: string | null): XaVesselAnalysis | null {
  return useSyncExternalStore(
    subscribe,
    () => (runId ? getVesselAnalysis(runId) : null),
    () => (runId ? getVesselAnalysis(runId) : null),
  );
}

/**
 * 再構成の鍵。**方向 A・B と解析区間から作る**ので、同じ 2 方向を解析し直せば同じ鍵になり、
 * 別の区間なら別の鍵になる（`qcaRunKey` と同じ考え方）。
 */
export function vesselRunId(kind: XaVesselModel["kind"], runKeys: readonly string[]): string {
  return `${kind}:${[...runKeys].sort().join("|")}`;
}
