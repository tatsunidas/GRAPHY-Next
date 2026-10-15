// モード A（Drive 正本・手元はキャッシュ）の切替・解除の条件と、復元の見守り（main が使う。electron は import しない）。
// 設計: fw/gdrive-p2.md。判断を main.js から切り出してあるのは、条件の正例・負例を `node --test` で確かめるため。

const MODES = ["backup", "cache"];

/**
 * 切替してよいか。st は backend の GET /api/gdrive/status（取れなければ null）。
 * - backup → cache: 同期が済んでいること（Drive に全件が載っている）。済んでいないまま手元を消し始めると、未送信を失う。
 * - cache → backup: 追い出し済みが 0 件（全件が手元にある）こと。手元が正本になるので、欠けていてはいけない。
 * @returns {{ok:true, noop?:true}|{ok:false, error:string}}
 */
function canSwitchMode(current, target, st) {
  if (!MODES.includes(target)) return { ok: false, error: "invalid-mode" };
  if (target === current) return { ok: true, noop: true };
  if (!st || typeof st !== "object") return { ok: false, error: "backend-unavailable" };
  if (target === "cache") {
    const synced = st.state === "CONNECTED" && st.pending === 0 && st.blocked === 0;
    return synced ? { ok: true } : { ok: false, error: "not-synced" };
  }
  return st.evictedCount === 0 ? { ok: true } : { ok: false, error: "not-all-local" };
}

/** Drive との連携を解除してよいか。モード A で手元に無いファイルがあるうちは解除できない（解除すると、取り寄せる手段を失う）。 */
function canDisable(current, st) {
  if (current !== "cache") return { ok: true };
  if (!st || typeof st !== "object") return { ok: false, error: "backend-unavailable" };
  return st.evictedCount === 0 ? { ok: true } : { ok: false, error: "not-all-local" };
}

/**
 * 復元の完了を見守る。FAILED なら onFailed を呼ぶ（紐付けを外すため）。DONE・IDLE（backend が入れ替わった）・上限回数で止まる。
 * @param {{getProgress:()=>Promise<{phase:string}|null>, onFailed:()=>void, intervalMs?:number, maxPolls?:number, sleep?:(ms:number)=>Promise<void>}} o
 * @returns {Promise<"DONE"|"FAILED"|"STOPPED">}
 */
async function watchRestore({ getProgress, onFailed, intervalMs = 2000, maxPolls = 21600, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  for (let i = 0; i < maxPolls; i++) {
    let p = null;
    try {
      p = await getProgress();
    } catch {
      p = null; // 一時的に取れない。続ける
    }
    if (p && p.phase === "DONE") return "DONE";
    if (p && p.phase === "FAILED") {
      onFailed();
      return "FAILED";
    }
    if (p && p.phase === "IDLE") return "STOPPED"; // backend が入れ替わった。判断できないので何も外さない
    await sleep(intervalMs);
  }
  return "STOPPED";
}

module.exports = { MODES, canSwitchMode, canDisable, watchRestore };
