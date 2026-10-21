/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * シリーズ選択の窓（`host.db.pickSeries`・H72）。設計: `fw/remote-compute-design.md` §29。
 *
 * <p>一括（`compute.runBatch`）のように「保管庫のシリーズを横断して選ぶ」プラグインのために、<b>本体が描く窓</b>で
 * 検索・絞り込み・チェックをしてもらい、選んだ <b>UID だけ</b>（`[{studyUid, seriesUid}]`）を返す。患者名・記述は窓に
 * 出るがプラグインには渡らない。新しい権限・同意は作らない（外へ出すのは `runBatch` の同意が別に聞く）。
 *
 * <p>React の外から呼ばれるので、ストアを本体のツリーの中の {@link SeriesPickHost} が購読して `createPortal` で出す
 * （`createRoot` の別ルートは i18n コンテキストが効かない。`pluginAiApi.tsx` と同じ流儀）。2D ビューアとメイン画面は
 * 別ルートなので Host は両方に置く。同時に出すのは 1 つで、2 件目以降は順番を待つ。取り消しは空配列。例外は投げない。
 */
import { useSyncExternalStore, type ReactNode } from "react";
import { SeriesPickDialog } from "./SeriesPickDialog";
import { normalizeOptions, type PickedSeries } from "./seriesPickLogic";

export type { PickedSeries } from "./seriesPickLogic";

export interface PickSeriesOptions {
  /** 窓のタイトル（120 字まで）。 */
  title?: string;
  /** 選べるシリーズの種類（`["CT"]` など。英大文字）。窓の絞り込みの初期値になり、それ以外のシリーズは選べない。 */
  modalities?: string[];
  /** 複数選べるか。既定 true。 */
  multiple?: boolean;
}

export interface PendingPick {
  title: string;
  modalities: string[];
  multiple: boolean;
  resolve: (r: PickedSeries[]) => void;
}

let current: PendingPick | null = null;
const waiting: PendingPick[] = [];
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

/** 窓を描く側（{@link SeriesPickHost}）が使う購読の口。 */
export function subscribeSeriesPick(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** いま出す 1 件（無ければ null）。 */
export function peekSeriesPick(): PendingPick | null {
  return current;
}

/** 窓の結果を確定する（決定＝選んだ順の UID・取り消し＝空配列）。待っている次があればそれを開く。 */
export function settleSeriesPick(result: PickedSeries[]): void {
  const done = current;
  current = waiting.shift() ?? null;
  emit();
  done?.resolve(result);
}

/** `host.db.pickSeries`。 */
export function pickSeries(opts?: PickSeriesOptions): Promise<PickedSeries[]> {
  const o = normalizeOptions(opts);
  return new Promise((resolve) => {
    const p: PendingPick = { ...o, resolve };
    if (current) {
      waiting.push(p); // 同時に 2 つ出すと、どちらの選択か分からなくなる。順番に開く
      return;
    }
    current = p;
    emit();
  });
}

/** テスト用: ストアを空に戻す（待っている呼び出しは取り消し＝空配列で終える）。 */
export function resetSeriesPickForTest(): void {
  const all = [current, ...waiting].filter((x): x is PendingPick => x != null);
  current = null;
  waiting.length = 0;
  all.forEach((p) => p.resolve([]));
  emit();
}

/** 窓の置き場。**本体のツリーの中で描くこと**。2D ビューアとメイン画面の両方に置く。 */
export function SeriesPickHost(): ReactNode {
  const p = useSyncExternalStore(subscribeSeriesPick, peekSeriesPick, peekSeriesPick);
  if (!p) return null;
  return (
    <SeriesPickDialog
      title={p.title}
      modalities={p.modalities}
      multiple={p.multiple}
      onDone={(r) => settleSeriesPick(r)}
      onCancel={() => settleSeriesPick([])}
    />
  );
}
