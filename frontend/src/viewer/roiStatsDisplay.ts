/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI 統計の**表示モード**（`fw/roi-stats-design.md` §5・§8）。
 *
 * <p>「常に出ていてほしいわけではない」という要求に対し、**1 本の列挙にせず 3 つの独立した軸**に
 * してある。組み合わせで欲しい状態が全部作れ、後から値を足しても破綻しないため。
 * <ul>
 *   <li>{@link RoiStatsPlacement} … どこに出すか（出さない / ROI 脇 / ビューポート右下に一覧）</li>
 *   <li>{@link RoiStatsDetail} … どこまで出すか（要約 / 全項目）</li>
 *   <li>selectedOnly … 選択中の ROI にだけ出すか</li>
 * </ul>
 *
 * <p>正本は環境設定（`roi.statsPlacement` / `roi.statsDetail` / `roi.statsSelectedOnly`）。
 * ここはそれをアプリ内へ配るだけのランタイム状態で、**メニューから変えたら設定へ書き戻す**
 * （セッション限りの隠れ状態を作らない＝次に開いたとき同じ見え方になる）。
 *
 * <p>Cornerstone のツール（React の外）からも読むので、React に依存しない購読を持つ。
 */
import { useSyncExternalStore } from "react";
import { saveSettings } from "../settings/settingsApi";

export type RoiStatsPlacement = "off" | "beside" | "corner";
export type RoiStatsDetail = "compact" | "full";

export interface RoiStatsDisplay {
  placement: RoiStatsPlacement;
  detail: RoiStatsDetail;
  selectedOnly: boolean;
}

/** 既定＝**今までと同じ見え方**（ROI 脇・要約・全 ROI）。既存利用者の画面をいきなり変えない。 */
export const DEFAULT_ROI_STATS_DISPLAY: RoiStatsDisplay = {
  placement: "beside",
  detail: "compact",
  selectedOnly: false,
};

export const ROI_STATS_PLACEMENTS: RoiStatsPlacement[] = ["off", "beside", "corner"];
export const ROI_STATS_DETAILS: RoiStatsDetail[] = ["compact", "full"];

/** 設定値（文字列・未知の値・undefined）を安全に解釈する。純関数。 */
export function parseRoiStatsDisplay(settings: Record<string, string> | undefined): RoiStatsDisplay {
  const p = settings?.["roi.statsPlacement"];
  const d = settings?.["roi.statsDetail"];
  const s = settings?.["roi.statsSelectedOnly"];
  return {
    placement: ROI_STATS_PLACEMENTS.includes(p as RoiStatsPlacement)
      ? (p as RoiStatsPlacement)
      : DEFAULT_ROI_STATS_DISPLAY.placement,
    detail: ROI_STATS_DETAILS.includes(d as RoiStatsDetail)
      ? (d as RoiStatsDetail)
      : DEFAULT_ROI_STATS_DISPLAY.detail,
    selectedOnly: s === "true" || s === "1" ? true : DEFAULT_ROI_STATS_DISPLAY.selectedOnly,
  };
}

let current: RoiStatsDisplay = { ...DEFAULT_ROI_STATS_DISPLAY };
const listeners = new Set<() => void>();

export function getRoiStatsDisplay(): RoiStatsDisplay {
  return current;
}

/** 表示モードを差し替える（変化が無ければ通知しない）。 */
export function setRoiStatsDisplay(next: Partial<RoiStatsDisplay>): void {
  const merged = { ...current, ...next };
  if (
    merged.placement === current.placement &&
    merged.detail === current.detail &&
    merged.selectedOnly === current.selectedOnly
  ) {
    return;
  }
  current = merged;
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch {
      /* 1 つの購読者の失敗で他を巻き込まない */
    }
  }
}

export function subscribeRoiStatsDisplay(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** React から表示モードを購読する。 */
export function useRoiStatsDisplay(): RoiStatsDisplay {
  return useSyncExternalStore(subscribeRoiStatsDisplay, getRoiStatsDisplay);
}

/**
 * メニューからの切り替え。ランタイムへ即時反映し、**環境設定へも書き戻す**。
 *
 * <p>セッション限りの隠れ状態を作らないため（次に 2D Viewer を開いたとき同じ見え方になる）。
 * 保存に失敗しても表示は変える——見た目が変わらない方が混乱する。
 */
export function changeRoiStatsDisplay(next: Partial<RoiStatsDisplay>): void {
  setRoiStatsDisplay(next);
  const d = getRoiStatsDisplay();
  void saveSettings({
    "roi.statsPlacement": d.placement,
    "roi.statsDetail": d.detail,
    "roi.statsSelectedOnly": String(d.selectedOnly),
  }).catch(() => {
    /* 保存できなくてもランタイムには効いている */
  });
}
