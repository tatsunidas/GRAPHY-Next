"use strict";

/**
 * 描画プロセスが落ちた（render-process-gone）ときの行動の判断。Electron には触れない純粋な状態機械。
 *
 * - clean-exit は正常終了なので何もしない。それ以外（crashed・oom・killed など）は「読み込み直す」。
 * - 読み込み直した窓が、その読み込みを終える（did-finish-load）前にまた落ちたら、読み込み直しても直らない
 *   （同じ原因で落ち続ける）と見なし、読み込み直さずに諦める（"giveup"）。無限に読み込み直さないための歯止め。
 *   読み込みを終えたあとの落ちは、新しい 1 回目として読み込み直す。
 */

/** 落ちたと見なさない reason。 */
const IGNORED_REASONS = ["clean-exit"];

function createRecovery() {
  /** webContents.id → 読み込み直しを始めて、まだ読み込みを終えていない */
  const reloading = new Map();

  return {
    /** 落ちた。返り値の action: "ignore" | "reload" | "giveup" */
    onGone(id, reason) {
      if (IGNORED_REASONS.includes(reason)) return { action: "ignore" };
      if (reloading.get(id)) {
        reloading.delete(id);
        return { action: "giveup" };
      }
      reloading.set(id, true);
      return { action: "reload" };
    },
    /** 読み込みを終えた（did-finish-load）。 */
    onLoaded(id) {
      reloading.delete(id);
    },
    /** 窓が閉じた。 */
    forget(id) {
      reloading.delete(id);
    },
  };
}

/** 案内の文面。colab: 保持中の Colab ランタイムがあるか。giveup: 読み込み直さなかったか。 */
function describe({ giveup, colab }) {
  const message = giveup
    ? "表示が続けて異常終了しました。"
    : "表示が異常終了したので、読み込み直しました。";
  const detail =
    (giveup
      ? "読み込み直しても同じ原因で落ちています。この窓を閉じて、開き直してください。"
      : "表示していた内容（開いていたシリーズ・未保存の ROI など）は失われています。") +
    (colab
      ? "\n\nColab の GPU をまだ確保しています。使わないなら解放してください（他の窓で実行中のジョブがある場合は「そのまま」を選んでください）。"
      : "");
  const buttons = colab ? ["そのまま", "GPU を解放する"] : ["OK"];
  return { message, detail, buttons, releaseIndex: colab ? 1 : -1 };
}

module.exports = { createRecovery, describe, IGNORED_REASONS };
