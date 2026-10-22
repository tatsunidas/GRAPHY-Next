// ローカル AI（llama-server と小型モデル）の取得と検証。設計: fw/ai-routing-design.md §18
//
// 🔴 取得先 URL はマニフェスト（本体に同梱）にあるものだけ。renderer から URL は受けない。
// 🔴 https だけ・許可ホストだけ。リダイレクトは自分で追い、1 回ごとに同じ検査をする（回数上限あり）。
//    GitHub Releases / Hugging Face は実体を別ホスト（CDN）へ 302 で渡すため、追わないと取れない。
// 🔴 sha256 がマニフェストと違うファイルは使わず、消す。`rejectUnauthorized:false` は入れない。
// 🔴 electron を import しない（CI の Desktop ジョブは npm install しない）。

const fs = require("node:fs");
const https = require("node:https");
const crypto = require("node:crypto");

/** 取得してよいホスト。完全一致、または「.」で区切った末尾一致。 */
const ALLOWED_HOST_SUFFIXES = ["github.com", "githubusercontent.com", "huggingface.co", "hf.co"];
const MAX_REDIRECTS = 5;
/** 無通信でこの時間を超えたら中断する。暫定値（実測で見直す）。 */
const IDLE_TIMEOUT_MS = 60000;

const SHA256_RE = /^[0-9a-f]{64}$/;

function isAllowedUrl(u) {
  let url;
  try { url = new URL(u); } catch { return false; }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const h = url.hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((s) => h === s || h.endsWith("." + s));
}

/** OS・arch → マニフェストのキー。 */
function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function validateAsset(a, what) {
  const problems = [];
  if (!a || typeof a !== "object") return [`${what}:not-an-object`];
  if (!isAllowedUrl(a.url)) problems.push(`${what}:url-not-allowed`);
  if (typeof a.sha256 !== "string" || !SHA256_RE.test(a.sha256)) problems.push(`${what}:bad-sha256`);
  if (!Number.isInteger(a.size) || a.size <= 0) problems.push(`${what}:bad-size`);
  return problems;
}

/** マニフェストを検査する。問題があれば一覧で返す（空なら使える）。 */
function validateManifest(m) {
  const problems = [];
  if (!m || typeof m !== "object" || m.schema !== 1) return ["manifest:bad-schema"];
  const assets = m.runtime && m.runtime.assets;
  if (!assets || typeof assets !== "object") problems.push("runtime:no-assets");
  else {
    for (const [k, a] of Object.entries(assets)) {
      problems.push(...validateAsset(a, `runtime:${k}`));
      if (!a || !/\.(zip|tar\.gz)$/.test(String(a.file || ""))) problems.push(`runtime:${k}:bad-file`);
      if (!a || typeof a.exe !== "string" || /[\\/]/.test(a.exe)) problems.push(`runtime:${k}:bad-exe`);
    }
  }
  if (!Array.isArray(m.models) || m.models.length === 0) problems.push("models:empty");
  else {
    const seen = new Set();
    for (const md of m.models) {
      const id = md && typeof md.id === "string" ? md.id : "?";
      if (!/^[a-z0-9-]{1,48}$/.test(id) || seen.has(id)) problems.push(`model:${id}:bad-id`);
      seen.add(id);
      problems.push(...validateAsset(md, `model:${id}`));
      if (!md || typeof md.file !== "string" || !/^[A-Za-z0-9._-]+\.gguf$/.test(md.file)) problems.push(`model:${id}:bad-file`);
      if (!md || typeof md.license !== "string" || !md.license) problems.push(`model:${id}:no-license`);
      if (md && md.reasoning != null && !["on", "off", "auto"].includes(md.reasoning)) problems.push(`model:${id}:bad-reasoning`);
    }
  }
  if (!Array.isArray(m.models) || !m.models.some((x) => x && x.id === m.defaultModelId)) problems.push("manifest:bad-default-model");
  return problems;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(file);
    s.on("data", (c) => h.update(c));
    s.once("error", reject);
    s.once("end", () => resolve(h.digest("hex")));
  });
}

/** 既定の取得: https GET。🔴 redirect は追わない（呼び出し側が検査して追う）。 */
function defaultRequest(url, headers, signal) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "GRAPHY-Next", ...headers }, signal }, (res) => {
      resolve({ statusCode: res.statusCode || 0, headers: res.headers, stream: res });
    });
    req.once("error", reject);
    req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error("timeout")));
  });
}

/**
 * 1 件取得する。`<dest>.part` に書き、sha256 を確かめてから `dest` へ rename する。
 * `.part` があれば Range で再開する（サーバーが 206 を返さなければ最初から）。
 *
 * @param o.url,o.dest,o.sha256,o.size  マニフェストの値。size を超える分は受け取らない
 * @param o.onProgress  ({received, total}) を呼ぶ
 * @param o.signal      AbortSignal（中止）。`.part` は残す（再開用）
 * @param o.request     試験で差し替える。既定は https GET
 * @returns {Promise<{ok:true}|{ok:false,error:string}>}
 */
async function download(o) {
  const request = o.request || defaultRequest;
  const part = `${o.dest}.part`;
  let url = o.url;
  if (!isAllowedUrl(url)) return { ok: false, error: "url-not-allowed" };
  let have = 0;
  try { have = fs.statSync(part).size; } catch { /* 無ければ最初から */ }
  if (have > o.size) { fs.rmSync(part, { force: true }); have = 0; }

  try {
    let res;
    for (let hop = 0; ; hop++) {
      res = await request(url, have > 0 ? { Range: `bytes=${have}-` } : {}, o.signal);
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.stream.resume();
        const loc = res.headers.location;
        if (!loc || hop >= MAX_REDIRECTS) return { ok: false, error: "too-many-redirects" };
        const next = new URL(loc, url).toString();
        if (!isAllowedUrl(next)) return { ok: false, error: "redirect-not-allowed" };
        url = next;
        continue;
      }
      break;
    }
    if (res.statusCode === 416 && have === o.size) {
      res.stream.resume(); // 全部ある（検証だけ行う）
    } else if (res.statusCode === 200) {
      have = 0; // 再開できない（最初から）
    } else if (res.statusCode !== 206) {
      res.stream.resume();
      return { ok: false, error: `http-${res.statusCode}` };
    }
    if (res.statusCode !== 416) {
      let received = have;
      const out = fs.createWriteStream(part, { flags: have > 0 ? "a" : "w", mode: 0o600 });
      let tooBig = false;
      let idleTimer = null;
      await new Promise((resolve, reject) => {
        const arm = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => res.stream.destroy(new Error("timeout")), IDLE_TIMEOUT_MS); };
        arm();
        res.stream.on("data", (c) => {
          arm();
          received += c.length;
          if (received > o.size) { tooBig = true; res.stream.destroy(); return; }
          if (!out.write(c)) { res.stream.pause(); out.once("drain", () => res.stream.resume()); }
          if (o.onProgress) o.onProgress({ received, total: o.size });
        });
        res.stream.once("error", reject);
        res.stream.once("close", () => { clearTimeout(idleTimer); out.end(() => resolve()); });
        if (o.signal) o.signal.addEventListener("abort", () => res.stream.destroy(new Error("aborted")), { once: true });
      }).catch((e) => { clearTimeout(idleTimer); out.destroy(); throw e; });
      if (tooBig) { fs.rmSync(part, { force: true }); return { ok: false, error: "size-exceeded" }; }
    }
    const size = fs.statSync(part).size;
    if (size !== o.size) return { ok: false, error: "incomplete" }; // .part は残す（再開できる）
    const digest = await sha256File(part);
    if (digest !== o.sha256) { fs.rmSync(part, { force: true }); return { ok: false, error: "sha256-mismatch" }; }
    fs.renameSync(part, o.dest);
    return { ok: true };
  } catch (e) {
    if (o.signal && o.signal.aborted) return { ok: false, error: "canceled" };
    return { ok: false, error: `network:${e && e.code ? e.code : (e && e.message) || "error"}` };
  }
}

/** 利用者が選んだファイルを、マニフェストの sha256 と size で確かめる（手動導入）。 */
async function verifyAgainst(file, asset) {
  let st;
  try { st = fs.statSync(file); } catch { return { ok: false, error: "not-found" }; }
  if (!st.isFile()) return { ok: false, error: "not-a-file" };
  if (st.size !== asset.size) return { ok: false, error: "size-mismatch" };
  return (await sha256File(file)) === asset.sha256 ? { ok: true } : { ok: false, error: "sha256-mismatch" };
}

module.exports = {
  ALLOWED_HOST_SUFFIXES,
  MAX_REDIRECTS,
  IDLE_TIMEOUT_MS,
  isAllowedUrl,
  platformKey,
  validateManifest,
  sha256File,
  download,
  verifyAgainst,
};
