// GRAPHY-Next — 終了の流れ（Exit メニュー・メイン窓の ×・トレイの［終了］・Cmd+Q など、利用者が決める終了すべての入口）。
//
// 純粋なモジュール（Electron を import しない。依存は deps で渡す）。順序と、失敗しても終われることを試験で固定する:
//   1. いま走っている処理を backend に聞く（無ければ確認なしで進む。聞けなければ「確認できない」として同じ確認を出す）
//   2. あれば［終了しない（既定）］／［中止して終了］を出す。終了しないなら何も変えずに戻る
//   3. 承認 → 中止できるものを中止 → 全窓を閉じる（保存待ちの送り出しを backend が生きているうちに流す）
//      → backend を穏当に止める（上限で強制）→ アプリを終える
// 承認のあとは、どこかが失敗しても終了までは必ず進める（終了できないアプリにしない）。

/** @typedef {{kind:'none'}|{kind:'items', items:{kind:string,count:number,cancellable:boolean}[]}|{kind:'unknown', reason?:string}} Activity */

function createQuitFlow(deps) {
  const log = deps.log || (() => {});
  let running = false;

  /** @returns {Promise<'quit'|'stay'|'ignored'>} */
  async function request(source) {
    if (running) return "ignored"; // 確認中・終了中にもう一度来ても、二重に動かさない
    running = true;
    let approved = false;
    try {
      /** @type {Activity} */
      let act;
      try {
        act = await deps.getActivity();
      } catch (e) {
        log("getActivity failed", e);
        act = { kind: "unknown", reason: String((e && e.message) || e) };
      }
      const items = act.kind === "items" ? act.items : [];
      if (items.length > 0 || act.kind === "unknown") {
        let choice;
        try {
          choice = await deps.ask({ items, unknown: act.kind === "unknown", source });
        } catch (e) {
          log("ask failed", e);
          choice = "stay"; // 確認できなければ終わらせない
        }
        if (choice !== "quit") return "stay";
      }
      approved = true;
      deps.approve();
      if (items.some((i) => i.cancellable)) {
        try {
          await deps.cancelAll();
        } catch (e) {
          log("cancelAll failed", e);
        }
      }
      try {
        await deps.closeWindows();
      } catch (e) {
        log("closeWindows failed", e);
      }
      try {
        await deps.stopBackend();
      } catch (e) {
        log("stopBackend failed", e);
      }
      deps.quitApp();
      return "quit";
    } finally {
      if (!approved) running = false; // 承認したあとは「終了中」のまま（以後の要求は無視する）
    }
  }

  return { request, isRunning: () => running };
}

module.exports = { createQuitFlow };
