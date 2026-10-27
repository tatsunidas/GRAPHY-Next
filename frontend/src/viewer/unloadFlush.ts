/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 閉じる・再読み込み・タブを離れる直前に、保存待ちの ROI・塗り ROI を送る。
 *
 * <p>保存はデバウンス（形 1.5 秒・塗り 0.5 秒）で遅らせてあるため、その間にページごと閉じると失われる。
 * React のアンマウントではページごと閉じるときに何も走らないので、`pagehide` と `visibilitychange` で拾う。
 * 持ち越すデータは作らない（送る先の DB に、早く書くだけ）。
 */
import { flushRoiSavesForUnload } from "./roiSaveStore";
import { flushMasksForUnload } from "./maskSaveStore";

/** 画面が開いている間だけ呼ぶ。返り値でリスナーを外す。 */
export function startUnloadFlush(): () => void {
  const flushAll = (): void => {
    flushRoiSavesForUnload();
    flushMasksForUnload();
  };
  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") flushAll();
  };
  window.addEventListener("pagehide", flushAll);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("pagehide", flushAll);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
