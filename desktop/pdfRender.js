// プラグイン向け `host.renderPdf`: プラグインが組んだ HTML を、表示しない窓で PDF にする。
//
// 🔴 入力の HTML は信用しない。患者由来の文字（血管名・コメントなど）が入り得るので、
//    ・JavaScript を切る  ・sandbox  ・使い捨てのセッションで、**自前の画面（メモリ上の 1 URL）以外へは一切通信しない**
//    （`http(s):` `file:` を通すと、HTML 経由でローカルのファイルやイントラの URL を読みに行ける）
//    ・大きさに上限を付ける（巨大な HTML でのメモリ枯渇を防ぐ）
//    ・窓は成否にかかわらず破棄する。同時に走らせるのは 1 件。
// 🔴 `electron` を import しない（`node --test` が npm install 無しで走る）。必要なものは create() に渡す。

const MAX_HTML_BYTES = 8 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 15000;
const PAGE_SIZES = new Set(["A4", "Letter"]);
/** メモリ上で返す自前の画面の URL。これ以外の要求は全部止める。 */
const REPORT_SCHEME = "graphy-pdf";
const REPORT_URL = `${REPORT_SCHEME}://report/index.html`;

/** 要求の検証。通ったら正規化した値を返す。 */
function validateRequest(req) {
  if (!req || typeof req !== "object" || Array.isArray(req)) return { ok: false, error: "bad-request" };
  const { html, pageSize, landscape } = req;
  if (typeof html !== "string" || html.length === 0) return { ok: false, error: "bad-request" };
  if (pageSize !== undefined && !PAGE_SIZES.has(pageSize)) return { ok: false, error: "bad-request" };
  if (landscape !== undefined && typeof landscape !== "boolean") return { ok: false, error: "bad-request" };
  // UTF-16 の長さの 3 倍が UTF-8 の上限なので、まず安い判定で弾き、通ったものだけ実バイトを数える
  if (html.length > MAX_HTML_BYTES || Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) return { ok: false, error: "too-large" };
  return { ok: true, html, pageSize: pageSize || "A4", landscape: landscape === true };
}

/** 窓の中から出る要求を通してよいか。自前の画面と、HTML に埋めた `data:` の画像だけ。 */
function isAllowedRequestUrl(url) {
  if (typeof url !== "string") return false;
  if (url === REPORT_URL) return true;
  return /^data:image\/(png|jpeg|gif|webp);base64,/i.test(url);
}

/**
 * @param {{ BrowserWindow: any, session: any, protocol?: any, randomId?: () => string, timeoutMs?: number }} deps
 * @returns {(req: unknown) => Promise<{ok:true, bytes: Uint8Array, blocked: string[]} | {ok:false, error:string}>}
 */
function create(deps) {
  const { BrowserWindow, session } = deps;
  const timeoutMs = deps.timeoutMs || RENDER_TIMEOUT_MS;
  const randomId = deps.randomId || (() => `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let chain = Promise.resolve();

  async function renderOne(v) {
    const blocked = [];
    // 先頭に `persist:` を付けない ＝ ディスクに何も残らない使い捨てのセッション
    const ses = session.fromPartition(`graphy-pdf-${randomId()}`);
    let win = null;
    let timer = null;
    try {
      ses.webRequest.onBeforeRequest((details, cb) => {
        if (isAllowedRequestUrl(details.url)) cb({});
        else { blocked.push(String(details.url).slice(0, 200)); cb({ cancel: true }); }
      });
      ses.protocol.handle(REPORT_SCHEME, () => new Response(v.html, { headers: { "content-type": "text/html; charset=utf-8" } }));
      win = new BrowserWindow({
        show: false, width: 900, height: 1200,
        webPreferences: {
          session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false,
          javascript: false, webSecurity: true, allowRunningInsecureContent: false,
        },
      });
      const wc = win.webContents;
      wc.on("will-navigate", (e) => e.preventDefault());
      wc.setWindowOpenHandler(() => ({ action: "deny" }));
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), timeoutMs); });
      await Promise.race([win.loadURL(REPORT_URL), timeout]);
      const pdf = await Promise.race([
        wc.printToPDF({ pageSize: v.pageSize, landscape: v.landscape, printBackground: true, preferCSSPageSize: true }),
        timeout,
      ]);
      return { ok: true, bytes: new Uint8Array(pdf), blocked };
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      return { ok: false, error: msg === "timeout" ? "timeout" : "render-failed" };
    } finally {
      if (timer) clearTimeout(timer);
      try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* 破棄の失敗は握りつぶしてよい（結果は返す） */ }
      try { ses.protocol.unhandle(REPORT_SCHEME); } catch { /* 同上 */ }
    }
  }

  return function renderPdf(req) {
    const v = validateRequest(req);
    if (!v.ok) return Promise.resolve(v);
    const run = chain.then(() => renderOne(v));
    chain = run.catch(() => undefined);   // 1 件の失敗で後ろを止めない
    return run;
  };
}

module.exports = { create, validateRequest, isAllowedRequestUrl, MAX_HTML_BYTES, RENDER_TIMEOUT_MS, REPORT_URL };
