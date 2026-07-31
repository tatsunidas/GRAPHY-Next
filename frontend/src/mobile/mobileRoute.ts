/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * モバイルシェルの単画面ナビゲーション（設計: `fw/mobile-ui-design.md` §3.2）。
 *
 * <p>デスクトップ UI は「1 画面 = 1 ウィンドウ」で `window.open` を使うが、モバイルブラウザでは
 * **新規タブ扱い＋ポップアップブロック対象**になり、iOS Safari では名前付き target の再利用も不安定。
 * そこでモバイルは**同一タブの hash 遷移**にする。`location.hash` への代入は履歴に積まれるので、
 * **ブラウザの「戻る」がそのままナビゲーションスタックの戻るになる**。
 *
 * <p>ルート文字列は `App.tsx` の既存の hash ルータ（`#2dviewer` 等）と同じ名前空間に置き、
 * `mobile` を親にしたサブパスで表す。
 */

/** モバイルシェルの画面。 */
export type MobileView = "studies" | "series" | "viewer" | "report";

/** hash の親セグメント。 */
export const MOBILE_HASH_ROOT = "mobile";

const VIEW_SEGMENT: Record<MobileView, string> = {
  studies: "",
  series: "series",
  viewer: "viewer",
  report: "report",
};

/**
 * 🚧 **モバイルシェルが実用に足るか**（`fw/mobile-ui-design.md` のフェーズ）。
 *
 * <p>`false` の間は**自動振り分けを行わない**。M1 時点のシェルは骨格だけで、スマホから来た
 * 利用者を自動でここへ送ると「準備中の画面しか出ない」という後退になるため。
 * **M3（2D ビューア）が入った時点で true にする。** 手動切替（メニュー）は `false` でも動く。
 */
export const MOBILE_SHELL_READY: boolean = false;

/** `location.hash`（`#` 有無どちらでも可）がモバイルシェルのルートか。 */
export function isMobileRoute(hash: string): boolean {
  const s = hash.replace(/^#/, "");
  return s === MOBILE_HASH_ROOT || s.startsWith(`${MOBILE_HASH_ROOT}/`);
}

/**
 * `location.hash` から表示すべき画面を求める。モバイルルートでなければ null。
 * 未知のサブパスは root（`studies`）に倒す（壊れた URL で白画面にしない）。
 */
export function parseMobileRoute(hash: string): MobileView | null {
  if (!isMobileRoute(hash)) return null;
  const seg = hash.replace(/^#/, "").slice(MOBILE_HASH_ROOT.length).replace(/^\//, "");
  if (seg === "") return "studies";
  const hit = (Object.keys(VIEW_SEGMENT) as MobileView[]).find((v) => VIEW_SEGMENT[v] === seg);
  return hit ?? "studies";
}

/** 画面 → `location.hash` に代入する文字列（`#` 付き）。 */
export function mobileHash(view: MobileView): string {
  const seg = VIEW_SEGMENT[view];
  return seg ? `#${MOBILE_HASH_ROOT}/${seg}` : `#${MOBILE_HASH_ROOT}`;
}

/** 戻り先（親画面）。root なら null。 */
export function parentView(view: MobileView): MobileView | null {
  switch (view) {
    case "studies":
      return null;
    case "series":
      return "studies";
    case "viewer":
      return "series";
    case "report":
      return "viewer";
  }
}
