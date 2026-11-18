// 外部 AI クライアントのための確認ダイアログの共通部分: 待ち行列（同時に 2 枚出さない）・自動取り消し・文面。
// 設計: roadmap fw/mcp-server-design.md §6（段 4c-2a）。electron に依存しない純モジュール（`node --test` で検査する）。
//
// 🔴 外部 AI クライアントは write を連続して呼べる。確認が同時に何枚も積み上がると、どれがどの操作か分からないまま押される。
//    確認は 1 枚ずつ、先に来たものから出す。利用者が答えないまま放置されたときは、一定時間で［取り消す］とみなす
//    （AI クライアント側の時間切れの後も、画面にダイアログが残り続けないように）。

/** 確認に答えない場合の自動取り消しまでの時間。設計上の選択（読んで判断するのに足りる長さ）で、根拠から導いた値ではない。 */
const CONFIRM_TIMEOUT_MS = 120_000;

/**
 * @param {object} o
 * @param {(options: object, signal: AbortSignal) => Promise<{response: number}>} o.show  実際のダイアログ（main が dialog.showMessageBox を渡す）
 */
function createDialogQueue({ show }) {
  let chain = Promise.resolve();
  /**
   * @param {object} options  showMessageBox のオプション（cancelId を持つこと。自動取り消しのとき、その応答になる）
   * @param {{timeoutMs?: number}} [opt]  timeoutMs が 0 / 未指定なら自動取り消しなし（最初の接続の同意など、答えるまで待つもの）
   * @returns {Promise<{response: number, timedOut: boolean}>}
   */
  function ask(options, { timeoutMs = 0 } = {}) {
    const run = async () => {
      const ac = new AbortController();
      let timedOut = false;
      const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs) : null;
      try {
        const r = await show(options, ac.signal);
        return { response: typeof r?.response === "number" ? r.response : options.cancelId, timedOut };
      } catch {
        return { response: options.cancelId, timedOut }; // 表示できない・中断は［取り消す］（実行しない側）
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const p = chain.then(run, run);
    chain = p.then(() => {}, () => {});
    return p;
  }
  return { ask };
}

const oneLine = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, n);
const pct = (v) => `${(Number(v) * 100).toFixed(1)}%`;
const mm = (v) => `${Number(v).toFixed(1)} mm`;

const SELF_REPORTED = "クライアント名は相手の自己申告で、確認できません。";

/** write（ROI の作成・計測の全削除）を実行する前の確認の文面。値は 2D 窓の検査（dryRun）を通った引数だけが来る。 */
function writeConfirmText(client, id, params = {}) {
  const who = `外部 AI クライアント「${oneLine(client, 64)}」`;
  if (id === "clearMeasurements") {
    return {
      message: `${who}が、2D ビューアの計測線（長さ・角度など）をすべて消します。`,
      detail: `元に戻せません。ロックされた計測は残ります。\n対象: 2D ビューアで選んでいるタイル\n\n${SELF_REPORTED}実行しますか？`,
    };
  }
  const undo = "追加した ROI は、AI クライアントの「元に戻す」（undo_viewer_action）で、この ROI だけ消せます（手で描いた ROI・プラグインの ROI は消えません）。";
  if (id === "createRoi") {
    const shape = params.shape === "rectangle" ? "矩形" : "楕円";
    return {
      message: `${who}が、2D ビューアに ROI（${shape}）を 1 つ追加します。`,
      detail: `位置: 横 ${pct(params.u)} ／ 縦 ${pct(params.v)}（見えている画像の領域に対する割合）\n半径: 横 ${mm(params.radiusXmm)} ／ 縦 ${mm(params.radiusYmm)}\n対象: 2D ビューアで選んでいるタイル（表示中のスライス）\n\n${undo}\n${SELF_REPORTED}追加しますか？`,
    };
  }
  if (id === "createContourRoi") {
    const shape = params.shape === "freehand" ? "自由曲線" : "多角形";
    const n = Array.isArray(params.points) ? params.points.length : 0;
    return {
      message: `${who}が、2D ビューアに ROI（${shape}・頂点 ${n} 個）を 1 つ追加します。`,
      detail: `対象: 2D ビューアで選んでいるタイル（表示中のスライス）\n\n${undo}\n${SELF_REPORTED}追加しますか？`,
    };
  }
  return null;
}

module.exports = { createDialogQueue, writeConfirmText, CONFIRM_TIMEOUT_MS };
