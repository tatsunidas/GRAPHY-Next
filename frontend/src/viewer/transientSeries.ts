/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { PluginTransientSeriesHandle, PluginTransientSeriesSpec } from "../plugins/pluginTypes";
import type { SeriesLayout } from "./seriesLayout";

/**
 * 一時シリーズ（`host.openTransientSeries`）として開いたタイルの実体。保管庫には無く、タイルが消えたら捨てる。
 * `maps[c].window` / `colormap` は `setMapDisplay` で書き換わる（セッションの記録なので可変）。
 */
export interface TransientOpened {
  /** このタイルの id（`plugin-transient|<pluginId>|<n>`）。ビューアのコマンド登録の鍵。 */
  tileId: string;
  pluginId: string;
  pluginName: string;
  label: string;
  /** 合成のシリーズ UID（`2.25.<10 進>`）。タイルの series・合成 SOP・ROI の持ち主の判定に使う。 */
  seriesUid: string;
  maps: Array<{
    name: string;
    /** `createValueStack` のトークン。破棄は `releaseValueStack(token)`。 */
    token: string;
    imageIds: string[];
    unit: string;
    window: { center: number; width: number };
    colormap: string | null;
  }>;
  layout: SeriesLayout;
  scaleBar: boolean;
}

/** `crypto.randomUUID()` の 128 bit を 10 進にした `2.25.<n>`（DICOM の UUID 由来 UID）。 */
export function syntheticSeriesUid(): string {
  const hex = crypto.randomUUID().replace(/-/g, "");
  return `2.25.${BigInt("0x" + hex).toString(10)}`;
}

const validWindow = (w: { center: number; width: number } | undefined | null): boolean =>
  !!w && Number.isFinite(w.center) && Number.isFinite(w.width) && w.width > 0;

/**
 * 開く前の検証（純関数。stack を作る前に呼び、失敗なら何も作らない）。
 * 黙って合わせない: 合わせた結果は「別のスライスの絵」になり、見て気付けない。
 * `refInPlane` は参照スライスの行・列数（取れたときだけ。dims の x=列, y=行と照合する）。
 */
export function validateTransientSpec(
  spec: Pick<PluginTransientSeriesSpec, "maps" | "initialC">,
  refSliceCount: number,
  refInPlane?: { rows: number; columns: number } | null,
): void {
  if (!Array.isArray(spec.maps) || spec.maps.length === 0) throw new Error("openTransientSeries: maps is empty");
  if (!(refSliceCount > 0)) throw new Error("openTransientSeries: the reference stack has no slices");
  const first = spec.maps[0].volume.dims;
  for (const m of spec.maps) {
    const d = m.volume.dims;
    if (!validWindow(m.window)) throw new Error(`openTransientSeries: map "${m.name}" needs a finite window with width > 0`);
    if (d[2] !== refSliceCount) {
      throw new Error(`openTransientSeries: map "${m.name}" has ${d[2]} slices, the reference stack has ${refSliceCount}`);
    }
    if (d[0] !== first[0] || d[1] !== first[1] || d[2] !== first[2]) {
      throw new Error(`openTransientSeries: map "${m.name}" dims ${d.join("x")} differ from "${spec.maps[0].name}" ${first.join("x")}`);
    }
    if (refInPlane && (d[0] !== refInPlane.columns || d[1] !== refInPlane.rows)) {
      throw new Error(
        `openTransientSeries: map "${m.name}" is ${d[0]}x${d[1]} in plane, the reference is ${refInPlane.columns}x${refInPlane.rows}`,
      );
    }
  }
  const c = spec.initialC;
  if (c !== undefined && !(Number.isInteger(c) && c >= 0 && c < spec.maps.length)) {
    throw new Error(`openTransientSeries: initialC ${c} is out of range`);
  }
}

/** タイル一覧の差分から、消えた一時タイルの実体を返す（後始末の対象）。seriesUid で突き合わせる。 */
export function removedTransient(
  prevTiles: ReadonlyArray<{ transient?: TransientOpened }>,
  nextTiles: ReadonlyArray<{ transient?: TransientOpened }>,
): TransientOpened[] {
  const alive = new Set<string>();
  for (const tl of nextTiles) if (tl.transient) alive.add(tl.transient.seriesUid);
  const out: TransientOpened[] = [];
  for (const tl of prevTiles) if (tl.transient && !alive.has(tl.transient.seriesUid)) out.push(tl.transient);
  return out;
}

// ── ハンドルごとの購読（プラグインのコールバックは React の外に置く） ────────────────
interface HandleState {
  closed: boolean;
  dim: Set<(d: { c: number; z: number }) => void>;
  close: Array<() => void>;
  last: { c: number; z: number } | null;
}
const states = new Map<string, HandleState>();

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* プラグインの例外で本体を巻き込まない */
  }
}

export function createTransientHandle(opts: {
  tileId: string;
  seriesUid: string;
  setMapDisplay: PluginTransientSeriesHandle["setMapDisplay"];
  requestClose: () => void;
}): PluginTransientSeriesHandle {
  const st: HandleState = { closed: false, dim: new Set(), close: [], last: null };
  states.set(opts.seriesUid, st);
  return {
    tileId: opts.tileId,
    get closed() {
      return st.closed;
    },
    setMapDisplay: (c, d) => {
      if (!st.closed) opts.setMapDisplay(c, d);
    },
    onDimChange: (fn) => {
      st.dim.add(fn);
      return () => st.dim.delete(fn);
    },
    onClose: (fn) => {
      if (st.closed) safe(fn);
      else st.close.push(fn);
    },
    close: () => {
      if (!st.closed) opts.requestClose();
    },
  };
}

/** 表示中の C・Z を通知する。同じ値の再通知は捨てる（呼び出し側は描画のたびに呼んでよい）。 */
export function notifyTransientDim(seriesUid: string, c: number, z: number): void {
  const st = states.get(seriesUid);
  if (!st || st.closed) return;
  if (st.last && st.last.c === c && st.last.z === z) return;
  st.last = { c, z };
  for (const fn of [...st.dim]) safe(() => fn({ c, z }));
}

/** タイルが消えた。onClose を 1 度だけ呼び、以後の通知を止める。 */
export function notifyTransientClosed(seriesUid: string): void {
  const st = states.get(seriesUid);
  if (!st || st.closed) return;
  st.closed = true;
  const fns = st.close;
  st.close = [];
  st.dim.clear();
  states.delete(seriesUid);
  for (const fn of fns) safe(fn);
}
