/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 画面を描き直す隙を作る（`fw/angio-design.md` §6.16）。
 *
 * <h3>🚨 `await` があれば描き直される、というのは誤り</h3>
 * `await readModalitySlice(...)` のようなループは、画像が**キャッシュ済みだと microtask で
 * 解決する**。microtask はレンダラへ制御を返さないので、**ループが終わるまで 1 度も
 * 描き直されない**。進捗を state に入れていても画面には出ず、利用者からは固まって見える。
 *
 * <p>実機で「Diagnose を押してもバーが出ない」と言われたのがこれ。進捗は正しく更新されて
 * いたのに、描き直しが最後まで来なかった。
 *
 * <p>🔴 **`setTimeout` でなければならない。** `Promise.resolve()` も `queueMicrotask` も
 * microtask なので同じく描き直されない。マクロタスクへ落として初めてレンダラが走る。
 */
export function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 何フレームごとに {@link yieldToUi} を挟むか。細かすぎると全体が遅くなる。 */
export const UI_YIELD_EVERY = 8;

/** ループの中から呼ぶ。`i` が {@link UI_YIELD_EVERY} の倍数のときだけ隙を作る。 */
export async function yieldEvery(i: number, every = UI_YIELD_EVERY): Promise<void> {
  if (i > 0 && i % every === 0) await yieldToUi();
}
