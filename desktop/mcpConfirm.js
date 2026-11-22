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

/** プラグインの説明（プラグインが書いた信用できない文字列）から、main が前置した `[plugin: 名] (writes data) ` を外して 1 行にする。 */
const bareDescription = (d) => oneLine(String(d ?? "").replace(/^\[plugin: [^\]]*\] (\(writes data\) )?/, ""), 300);

/**
 * プラグインの write ツールを実行する前の確認の文面（実行のたびに）。プラグインの記述は信用できない文字列なので、そう示して引用する。
 * remote-compute を持つプラグインには、外部の計算機へ送る機能があることと、**別に送信の確認（計算機の同意）が出る**ことを添える
 * （その同意はプラグインが送信を始めるときに必ず出る。ここの確認はその代わりにはならない）。
 */
function pluginWriteConfirmText(client, entry, argsPreview) {
  const external = Array.isArray(entry.permissions) && entry.permissions.includes("remote-compute");
  return {
    message: `外部 AI クライアント「${oneLine(client, 64)}」が、プラグイン「${oneLine(entry.pluginName, 60)}」のツール「${oneLine(entry.tool, 64)}」を実行します。このツールは、データを変更します。`,
    detail: `ツールの説明（プラグインの記述。信用できない文字列）: ${bareDescription(entry.description)}\n引数: ${oneLine(argsPreview, 300)}\n` +
      (external ? "\nこのプラグインは、外部の計算機へデータを送る機能を持っています。実行すると、送信してよいかの確認（計算機への送信の同意）が、別に出ます。\n" : "") +
      `\n元に戻せない場合があります。${SELF_REPORTED}実行しますか？`,
  };
}

/** プラグインのツールの結果を外部 AI クライアントへ返す前の確認の文面（接続 × プラグインで 1 回）。結果は信用できない文字列。 */
function pluginSendConfirmText(client, entry, preview) {
  return {
    message: `プラグイン「${oneLine(entry.pluginName, 60)}」のツールの結果を、外部 AI クライアント「${oneLine(client, 64)}」へ返します。`,
    detail: `結果の先頭（プラグインの出力。信用できない文字列）: ${oneLine(preview, 200)}\n\n返した内容は、そのクライアントを通じてクラウドの AI へ送られる可能性があります。患者情報が含まれていないか確認してください。${SELF_REPORTED}返しますか？`,
  };
}

/** 環境設定で、プラグインのツールを外部 AI クライアントへ公開するとき（追加するとき）の確認の文面。 */
function pluginExposeConfirmText(pluginId, entries) {
  const mine = entries.filter((e) => e.pluginId === pluginId);
  const name = mine[0] ? oneLine(mine[0].pluginName, 60) : oneLine(pluginId, 80);
  const list = mine.map((e) => `・${oneLine(e.tool, 64)}（${e.effect === "write" ? "データを変更。実行のたびに確認" : e.effect === "display" ? "表示を変える" : "読み取り"}）`).join("\n");
  const hasWrite = mine.some((e) => e.effect === "write");
  return {
    message: `外部 AI クライアントへ、プラグイン「${name}」のツールを公開します。`,
    detail: `公開されるツール:\n${list || "（ツールが見つかりません）"}\n\nプラグインのコードは、2D ビューアの中で動き、画像の画素や患者に関わる値に触れ得ます。結果は、最初に返すとき、内容を示して確認します。${hasWrite ? "\nデータを変更するツールは、さらに「ROI の作成・計測の全削除を許可する」がオンのときだけ使え、実行のたびに確認します。" : ""}`,
  };
}

/**
 * 2D ビューアの表示中の画像（画素）を外部 AI クライアントへ返す前の確認の文面（**実行のたびに**）。画像はダイアログにサムネイルで示す。
 * 🔴 画像に患者の氏名・ID などが焼き込まれていても、アプリは検出も塗りつぶしもできない。この確認が唯一の関門で、
 *    確認した上で返した画像の責任は、返すことを許可した利用者にある（2026-11-18 ユーザー決定）。
 */
function captureConfirmText(client, image = {}) {
  const dim = Number.isInteger(image.w) && Number.isInteger(image.h) && image.w > 0 && image.h > 0 ? `（${image.w}×${image.h}）` : "";
  return {
    message: `外部 AI クライアント「${oneLine(client, 64)}」へ、2D ビューアの表示中の画像${dim}を返します。`,
    detail: "画像に、患者の氏名・ID などの文字が焼き込まれていないか確認してください。アプリは、画像の中の患者情報を検出も除去もできません。\n" +
      "返した画像は、そのクライアントを通じてクラウドの AI へ送られる可能性があります。患者情報が含まれていた場合の責任は、返すことを許可したあなたにあります。\n\n" +
      `${SELF_REPORTED}返しますか？`,
  };
}

module.exports = { createDialogQueue, writeConfirmText, captureConfirmText, pluginWriteConfirmText, pluginSendConfirmText, pluginExposeConfirmText, CONFIRM_TIMEOUT_MS };
