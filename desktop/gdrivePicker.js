// Drive の保存先（親フォルダ）を選ぶ。利用者の既定ブラウザで Google Picker を開き、結果を loopback で受ける。
//
// なぜ Electron の窓ではなくブラウザか: Picker は利用者の Google のセッション（Cookie）を使う。
// Electron の窓には無く（実測: 「Google アカウントにログイン」が出る）、Google は埋め込みブラウザからのログインを
// 制限している。OAuth のログイン（gdriveAuth.js）と同じく、利用者のブラウザで行う。
//
// 守っていること:
//   - 待ち受けは 127.0.0.1 の空きポート。経路は推測できない nonce で始まり、それ以外は 404
//   - Host が自分のものでなければ 404（DNS リバインディング対策）。結果の POST は Origin も自分のものだけ
//   - 結果の id は形を検査する。アクセストークンはブラウザの Picker にだけ渡る（レンダラへは返さない）
//   - 同時に開くのは 1 つだけ。5 分で閉じる
//
// electron を import しない（テストできるように。ブラウザを開く関数は呼び出し側が渡す）。

const crypto = require("node:crypto");
const http = require("node:http");

const TIMEOUT_MS = 5 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{10,128}$/;

const STRINGS = {
  ja: { title: "バックアップの保存先を選ぶ", opening: "Google Drive を開いています…", done: "受け取りました。この画面は閉じてかまいません。", myDrive: "マイドライブ", sharedDrives: "共有ドライブ" },
  en: { title: "Choose where to back up", opening: "Opening Google Drive…", done: "Received. You can close this tab.", myDrive: "My Drive", sharedDrives: "Shared drives" },
};

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>GRAPHY-Next</title>
<style>body{font-family:system-ui,"Segoe UI","Yu Gothic UI",sans-serif;padding:16px 20px;font-size:14px;color:#1f2933}</style>
</head><body><p id="msg"></p><script src="view.js"></script></body></html>`;

// Picker を開く。マイドライブと共有ドライブの 2 つの view を並べる（1 つにすると既定が共有ドライブになる。fw/gdrive-p0.md）。
// 選べるのはフォルダだけ。drive.file では既存フォルダの中身は読めないので、選ぶ場所は「保存先の親」。
const VIEW_JS = `(async () => {
  const msg = document.getElementById("msg");
  const post = (o) => fetch("done", { method: "POST", body: JSON.stringify(o) }).then(() => { if (o.ok || o.error === "cancelled") msg.textContent = init.strings.done; });
  const init = await (await fetch("init")).json();
  document.title = init.strings.title;
  msg.textContent = init.strings.opening;
  const s = document.createElement("script");
  s.src = "https://apis.google.com/js/api.js";
  s.onerror = () => post({ ok: false, error: "picker-script-load" });
  s.onload = () => {
    gapi.load("picker", { callback: () => {
      const view = (label) => new google.picker.DocsView(google.picker.ViewId.FOLDERS)
        .setIncludeFolders(true).setSelectFolderEnabled(true)
        .setMimeTypes("application/vnd.google-apps.folder").setLabel(label);
      new google.picker.PickerBuilder()
        .addView(view(init.strings.myDrive).setParent("root"))
        .addView(view(init.strings.sharedDrives).setEnableDrives(true))
        .enableFeature(google.picker.Feature.SUPPORT_DRIVES)
        .setOAuthToken(init.token).setDeveloperKey(init.apiKey).setAppId(init.projectNumber)
        .setTitle(init.strings.title).setLocale(init.locale)
        .setCallback((d) => {
          if (d.action === "picked" && d.docs && d.docs[0]) post({ ok: true, id: String(d.docs[0].id), name: String(d.docs[0].name) });
          else if (d.action === "cancel") post({ ok: false, error: "cancelled" });
        })
        .build().setVisible(true);
    }, onerror: () => post({ ok: false, error: "picker-load" }) });
  };
  document.head.appendChild(s);
})();`;

let active = false;

function busy() {
  return active;
}

/**
 * @param info  { token, apiKey, projectNumber, locale, openExternal(url), timeoutMs? }（main が持つ。レンダラからは渡さない）
 * @returns Promise<{ok:true,id,name}|{ok:false,error}>
 */
function pick(info) {
  return new Promise((resolve) => {
    if (active) return resolve({ ok: false, error: "busy" });
    active = true;
    const nonce = crypto.randomBytes(24).toString("base64url");
    const locale = info.locale === "en" ? "en" : "ja";
    const server = http.createServer();
    let done = false;
    let timer = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      active = false;
      // 受け取った応答を返し終えてから閉じる
      setTimeout(() => server.close(), 200);
      server.closeAllConnections?.();
      resolve(result);
    };
    server.on("error", (e) => finish({ ok: false, error: `loopback: ${e.message}` }));
    server.listen(0, "127.0.0.1", () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const base = `/${nonce}/`;
      const send = (res, status, type, body, extra = {}) => {
        res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
        res.end(body);
      };
      const notFound = (res) => send(res, 404, "text/plain", "");
      server.on("request", (req, res) => {
        if (req.headers.host !== origin.slice("http://".length)) return notFound(res);
        const url = String(req.url || "");
        if (!url.startsWith(base)) return notFound(res);
        const rest = url.slice(base.length);
        if (req.method === "GET" && rest === "") {
          return send(res, 200, "text/html; charset=utf-8", PAGE, {
            "Content-Security-Policy":
              "default-src 'none'; script-src 'self' https://apis.google.com https://www.gstatic.com; frame-src https://*.google.com https://*.googleusercontent.com; connect-src 'self' https://*.google.com https://*.googleapis.com; img-src https: data:; style-src 'unsafe-inline' https://www.gstatic.com; base-uri 'none'",
          });
        }
        if (req.method === "GET" && rest === "view.js") return send(res, 200, "text/javascript; charset=utf-8", VIEW_JS);
        if (req.method === "GET" && rest === "init") {
          return send(res, 200, "application/json", JSON.stringify({
            token: info.token, apiKey: info.apiKey, projectNumber: info.projectNumber, locale, strings: STRINGS[locale],
          }));
        }
        if (req.method === "POST" && rest === "done") {
          // 🔴 自分のページからの POST だけ（別のサイトのページから叩かせない）
          if (req.headers.origin !== origin) return notFound(res);
          let body = "";
          req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
          req.on("end", () => {
            send(res, 200, "text/plain", "ok");
            let r = null;
            try {
              r = JSON.parse(body);
            } catch {
              r = null;
            }
            if (r && r.ok === true && typeof r.id === "string" && ID_RE.test(r.id)) {
              finish({ ok: true, id: r.id, name: typeof r.name === "string" ? r.name.slice(0, 200) : "" });
            } else {
              finish({ ok: false, error: r && typeof r.error === "string" && /^[a-z-]{1,30}$/.test(r.error) ? r.error : "cancelled" });
            }
          });
          return;
        }
        return notFound(res);
      });
      timer = setTimeout(() => finish({ ok: false, error: "timeout" }), info.timeoutMs || TIMEOUT_MS);
      try {
        info.openExternal(`${origin}${base}`);
      } catch (e) {
        finish({ ok: false, error: `open: ${e && e.message}` });
      }
    });
  });
}

module.exports = { pick, busy, ID_RE };
