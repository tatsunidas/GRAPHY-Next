/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * スライス（フレーム）送りを一時的に止めるための錠。
 *
 * <h3>なぜ要るのか（実機で言われた・2026-08-28）</h3>
 * **QCA の解析結果が出ている最中でもホイールでフレームが送れてしまう。**
 * 解析は「あるフレーム」に対して走り、中心線・エッジ・手修正・校正はすべてその 1 枚に
 * 紐付いている。裏でフレームが変わると、
 *
 * - 画面の画像と、ダイアログに出ている数値が**別のフレームのもの**になる
 * - それでも**エラーは何も出ない**（値は内部整合したまま残る）
 * - 保存すると、参照 SOP とフレーム番号は変わっているのに計測値は前のまま
 *
 * という、**気付けない食い違い**が生まれる。少し回しただけで送られるので事故りやすい。
 *
 * <h3>設計</h3>
 * 参照カウント式にしてある（ダイアログが入れ子で開くことがあるため）。
 * 掛けた側が返ってきた解除関数を必ず呼ぶ。**この窓のなかだけ**の状態で、
 * 他ウィンドウのビューアには波及しない（別ウィンドウは別の解析をしていてよい）。
 *
 * <p>🔴 **錠を掛けた側が「なぜ止まっているか」を画面に出すこと。** 動かないのに理由が
 * 出ていないと「壊れている」と読まれる（押せないボタンと同じ）。
 */

import { useSyncExternalStore } from "react";

let lockCount = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 錠を掛ける。**返ってきた関数で必ず解除する**（`useEffect` のクリーンアップで呼ぶ）。
 * 二重解除しても壊れない。
 */
export function lockSliceNavigation(): () => void {
  lockCount++;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockCount = Math.max(0, lockCount - 1);
    notify();
  };
}

export function isSliceNavigationLocked(): boolean {
  return lockCount > 0;
}

/** テスト用。掛けっぱなしの錠を捨てる。 */
export function resetSliceNavigationLock(): void {
  if (lockCount === 0) return;
  lockCount = 0;
  notify();
}

export function useSliceNavigationLocked(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    isSliceNavigationLocked,
    isSliceNavigationLocked,
  );
}
