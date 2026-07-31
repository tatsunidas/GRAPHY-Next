/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * モバイルシェルの選択状態の保存（`fw/mobile-ui-design.md` §3.2）。
 *
 * <p>単画面ナビゲーションは同一タブの hash 遷移なので、画面を跨いでも React の state は生き残る。
 * ここで永続化しているのは**リロード / 直接 URL で深い画面に入った場合**のため
 * （スマホはタブが裏に回るとブラウザに破棄されやすく、復帰＝リロードになる）。
 *
 * <p>デスクトップ側のビューア起動コンテキスト（`graphy-viewer-ctx` 等 4 系統）とは**別のキー**にする。
 * あちらは「別ウィンドウへ受け渡す」ためのもので、こちらは「自分の続きから開く」ためのもの。
 * M3 以降でモバイルからビューアを開くときは、あちらの形式へ**書き出して**使う。
 */
import type { Series, Study, StudyFilters } from "../api";

export const MOBILE_CTX_KEY = "graphy-mobile-ctx";

export interface MobileCtx {
  filters?: StudyFilters | null;
  study?: Study | null;
  series?: Series | null;
}

/** 壊れた JSON・古い形式は捨てて空を返す（復元失敗で白画面にしない）。 */
export function readMobileCtx(): MobileCtx {
  try {
    const raw = localStorage.getItem(MOBILE_CTX_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return {};
    return v as MobileCtx;
  } catch {
    return {};
  }
}

export function writeMobileCtx(ctx: MobileCtx): void {
  try {
    localStorage.setItem(MOBILE_CTX_KEY, JSON.stringify(ctx));
  } catch {
    /* プライベートモード等で書けなくても、このセッション中は state で動く */
  }
}
