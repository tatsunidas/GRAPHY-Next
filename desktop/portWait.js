// 前のアプリの backend がポートを離すのを待つ（アプリの再起動のあと）。
//
// 再起動では、新しいアプリが前のアプリの後始末（backend の停止）と並んで起動する。前の backend が
// まだポートを持っていると、新しい backend は「ポートが使用中」で起動に失敗する。
//
// electron を import しない（CI の Desktop ジョブは npm install しない）。

const net = require("node:net");

/** そのポートに接続できるか（＝誰かが待ち受けているか）。 */
function portInUse(port, host = "127.0.0.1", timeoutMs = 500) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(timeoutMs, () => done(false));
  });
}

/**
 * ポートが空くまで待つ。
 * @returns {Promise<boolean>} 空いたら true、時間切れなら false（呼び出し側はそのまま起動を試みる）
 */
async function waitPortFree(port, { timeoutMs = 30000, intervalMs = 500, host = "127.0.0.1" } = {}) {
  const t0 = Date.now();
  while (await portInUse(port, host)) {
    if (Date.now() - t0 >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return true;
}

module.exports = { portInUse, waitPortFree };
