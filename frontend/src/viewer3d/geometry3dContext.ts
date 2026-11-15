/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 幾何だけの 3D ウィンドウ（`#geometry3d`）へ渡す起動コンテキスト。
 *
 * <p>`graphy-viewer-ctx` / `graphy-viewer3d-ctx` と同じく **localStorage 経由**。
 * 別ウィンドウを開く既存の作法に合わせてある（`window.open` の named target ＋ ctx の読み出し）。
 *
 * <p>⚠️ **これは「起動時に読む使い捨ての引数」であって、保存領域ではない。**
 * 開くたびに上書きされる。3D QCA の結果そのものの保存は SR（§10.2.7）で行う。
 */

/** 患者 LPS mm の点列（[x,y,z] の配列）。 */
export type LpsPolyline = number[][];

/** 木の 1 区間（`ct-vessel`・`xa-bifurcation3d` の表示に使う）。 */
export interface Geometry3DSegment {
  /** モデル内で一意（H12 の色の宛先 `segmentId` と同じ）。 */
  id: string;
  /** 表示名。無ければ `id`。 */
  name?: string;
  /** 中心線（患者 LPS mm・近位→遠位）。 */
  points: LpsPolyline;
}

export interface Geometry3DContext {
  /** 何を出すのか（表示名・注記の決定に使う）。 */
  kind: "xa-qca3d" | "xa-bifurcation3d" | "ct-vessel";
  /** ウィンドウのタイトルに出す名前。 */
  name: string;
  /**
   * 3D 中心線（患者 LPS mm）。単一血管（`xa-qca3d`）はこれだけを描く。
   * 木（`segments` あり）では**先頭区間のコピー**（古い読み手・検査のため。描くのは `segments`）。
   */
  centerlineLps: LpsPolyline;
  /**
   * 木の全区間。あれば**区間ごとに 1 つの物体**として描き、H12 の色も `segmentId` で区間ごとに乗せる。
   * 無ければ（単一の XA）従来どおり `centerlineLps` を 1 本だけ描く。
   */
  segments?: Geometry3DSegment[];
  /**
   * 血管モデルの `runId`（`viewer/xaVesselModelStore`）。A7 の解析値（H12）を
   * 色で乗せる宛先。**モデルはこのコンテキストではなく登録簿から読む**——
   * ここは使い捨ての引数で、点ごとの径も出自も持たないため。
   */
  runId?: string;
  /** 情報バーに出す数値（**再計算しない**。ダイアログで出したものと同じ値を見せる）。 */
  info?: {
    lengthMm?: number;
    percentDiameterStenosis?: number;
    minEquivalentDiameterMm?: number;
    /** 角度補正が掛かっていたか。掛かっていない結果は歪みを含む（§10.2.2）。 */
    angleCorrected?: boolean;
    /** 各方向で見えている長さの割合（短縮。§10.2.5）。 */
    visibleFractionA?: number;
    visibleFractionB?: number;
  };
  ts: number;
}

const KEY = "graphy-geometry3d-ctx";
const CHANNEL = "graphy-geometry3d";

/**
 * 開いているウィンドウへ「コンテキストを読み直せ」と伝える。
 *
 * <p>🚨 **ビューアのウィンドウは画面キーごとのシングルトン**で、既に開いていると
 * `openViewer` は**フォーカスするだけ**（読み直さない）。これが無いと、2 回目以降に
 * 「押しても何も変わらない」という壊れ方をする。
 */
function notify(): void {
  try {
    const bc = new BroadcastChannel(CHANNEL);
    bc.postMessage({ type: "updated" });
    bc.close();
  } catch {
    /* 非対応環境ではウィンドウを開き直してもらう */
  }
}

/** コンテキストの更新を購読する。返り値で解除。 */
export function subscribeGeometry3dContext(cb: () => void): () => void {
  let bc: BroadcastChannel | null = null;
  try {
    bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = () => cb();
  } catch {
    bc = null;
  }
  return () => bc?.close();
}

export function writeGeometry3dContext(ctx: Omit<Geometry3DContext, "ts">): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...ctx, ts: Date.now() }));
    notify();
  } catch {
    /* 書けなければ画面側が「コンテキストが無い」と出す */
  }
}

export function readGeometry3dContext(): Geometry3DContext | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const ctx = JSON.parse(raw) as Geometry3DContext;
    return Array.isArray(ctx?.centerlineLps) && ctx.centerlineLps.length >= 2 ? ctx : null;
  } catch {
    return null;
  }
}
