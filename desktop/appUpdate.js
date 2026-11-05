/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// アプリ内の自動更新（Windows の NSIS・Linux の AppImage だけ）。electron-updater は使わない
// （latest.yml・Mac の署名が前提で、`--publish never` のリリース CI と合わないため）。
// 公開済みの GitHub Release の資産を取得し、SHA-256（GitHub の digest）と minisign 署名を確かめてから実行する。
//
// 方針（利用者の決定 2026-11-05）:
//   - ダウンロードは「今すぐ」「終了時」を選んだときだけ始める（勝手に始めない）。
//   - 途中でネットワークが切れたら失敗として扱い、更新を見送る（再試行しない・部分ファイルは消す）。
//   - Mac・deb・（AppImage でない）Linux は対象外＝今までどおり通知だけ（pickAsset が理由つきで supported:false）。
//
// 🚨 任意の URL を実行させない: 資産の URL は GitHub のホストの https だけ（リダイレクトも毎回確かめる）。
//    開発（未パッケージ）のときだけ、環境変数でローカルの偽サーバー（http://127.0.0.1）を許す。
// 🚨 署名の trusted comment に「版 + ファイル名」を入れて突き合わせる（正規に署名された古い版への差し替えを防ぐ）。

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");

class UpdateError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail || "";
  }
}

// ── 版・資産の選択 ───────────────────────────────────────────────────────────

function normalizeVersion(tag) {
  return String(tag || "").trim().replace(/^v/i, "");
}

/** a > b なら true。ドット区切りの数値比較（プレリリース接尾辞は無視）。 */
function isNewer(a, b) {
  const pa = normalizeVersion(a).split(/[.+-]/).map((x) => parseInt(x, 10));
  const pb = normalizeVersion(b).split(/[.+-]/).map((x) => parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** 資産の取得を許すホスト（GitHub のリリース資産の配信元）。 */
function isAllowedHost(hostname) {
  const h = String(hostname).toLowerCase();
  return h === "github.com" || h.endsWith(".githubusercontent.com") || h === "githubusercontent.com";
}

const unsupported = (reason) => ({ supported: false, reason });

/**
 * 公開済みリリースから、この OS で自動更新できる資産を選ぶ。選べなければ理由つきで supported:false（通知だけに落とす）。
 * @param {object} release GitHub API の releases/latest の JSON
 * @param {{platform:string, arch:string, currentVersion:string, appImage?:string|null, appImageDirWritable?:boolean}} ctx
 */
function pickAsset(release, ctx) {
  const version = normalizeVersion(release && release.tag_name);
  if (!version) return unsupported("no-version");
  if (!isNewer(version, ctx.currentVersion)) return unsupported("not-newer");

  let kind, name;
  if (ctx.platform === "win32") {
    if (ctx.arch !== "x64") return unsupported("arch-unsupported");
    kind = "nsis";
    name = `GRAPHY-Next.Setup.${version}.exe`;
  } else if (ctx.platform === "linux") {
    if (!ctx.appImage) return unsupported("not-appimage"); // deb などは apt の管理。通知だけ
    if (ctx.arch !== "x64") return unsupported("arch-unsupported");
    if (!ctx.appImageDirWritable) return unsupported("appimage-dir-not-writable");
    kind = "appimage";
    name = `GRAPHY-Next-${version}.AppImage`;
  } else {
    return unsupported("platform-unsupported"); // Mac は署名がなく、アプリ自身の入れ替えができない
  }

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = assets.find((a) => a && a.name === name);
  if (!asset) return unsupported("asset-missing");
  const sig = assets.find((a) => a && a.name === `${name}.minisig`);
  if (!sig) return unsupported("signature-missing"); // 署名のない版は自動では入れない
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest || ""));
  if (!m) return unsupported("digest-missing");
  if (!Number.isInteger(asset.size) || asset.size <= 0) return unsupported("size-missing");
  for (const a of [asset, sig]) {
    let u;
    try { u = new URL(a.browser_download_url); } catch { return unsupported("bad-url"); }
    // 開発（未パッケージ）で偽サーバーを指したときだけ、ローカルの http を許す（allowLocalAssets。パッケージ版では常に false）
    const localOk = !!ctx.allowLocalAssets && u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
    if (!localOk && (u.protocol !== "https:" || !isAllowedHost(u.hostname))) return unsupported("bad-url");
  }
  return {
    supported: true,
    kind,
    version,
    asset: { name, size: asset.size, url: asset.browser_download_url, sha256: m[1].toLowerCase() },
    sig: { name: sig.name, url: sig.browser_download_url },
    expectTrusted: `graphy-next v${version} ${name}`,
  };
}

/**
 * 開発（未パッケージ）で偽のリリースサーバーを使うかどうか（GRAPHY_UPDATE_API_BASE があるとき）。
 * パッケージ版では常に false＝本番で更新元・資産の取得先・信頼鍵を環境変数で変えられない。
 */
function devOverrides(env, isPackaged) {
  const on = !isPackaged && !!(env && env.GRAPHY_UPDATE_API_BASE);
  return { allowLocal: on, extraKey: on && env.GRAPHY_UPDATE_TRUSTED_KEY ? [String(env.GRAPHY_UPDATE_TRUSTED_KEY)] : [] };
}

/** レンダラへ渡す要約（URL などは渡さない。開始はレンダラが指定できず、main が持つ計画で行う）。 */
function describePlan(plan) {
  if (!plan || !plan.supported) return { supported: false, reason: plan ? plan.reason : "no-plan" };
  return { supported: true, kind: plan.kind, version: plan.version, assetName: plan.asset.name, size: plan.asset.size };
}

/**
 * 更新確認に使う API の URL。開発（未パッケージ）のときだけ環境変数で差し替えられる
 * （パッケージ版では無視する＝本番で更新元を差し替えられない）。
 */
function releaseApiUrl(repo, env, isPackaged) {
  const override = !isPackaged && env && env.GRAPHY_UPDATE_API_BASE;
  if (override) return `${String(override).replace(/\/+$/, "")}/repos/${repo}/releases/latest`;
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

// ── ダウンロード ─────────────────────────────────────────────────────────────

/**
 * GET してレスポンスを handler に渡す。リダイレクトは許可ホストの https だけ追う。
 * opts: { stallMs（無通信でこの時間が経ったら失敗）, signal, insecureLocal（開発のみ: http://127.0.0.1 を許す）, redirects }
 */
function request(url, opts, handler) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new UpdateError("bad-url")); }
    const localOk = !!opts.insecureLocal && u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
    if (!localOk) {
      if (u.protocol !== "https:") return reject(new UpdateError("bad-url", u.protocol));
      if (!isAllowedHost(u.hostname)) return reject(new UpdateError("bad-host", u.hostname));
    }
    if (opts.signal && opts.signal.aborted) return reject(new UpdateError("cancelled"));
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get(u, { headers: { "User-Agent": "GRAPHY-Next", Accept: "application/octet-stream" } }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        const left = opts.redirects === undefined ? 5 : opts.redirects;
        if (left <= 0) return reject(new UpdateError("too-many-redirects"));
        return resolve(request(new URL(res.headers.location, u).toString(), { ...opts, redirects: left - 1 }, handler));
      }
      if (code !== 200) {
        res.resume();
        return reject(new UpdateError(`http-${code}`));
      }
      Promise.resolve(handler(res)).then(resolve, reject);
    });
    // 無通信（接続・応答・本体のどの段階でも）が続いたら失敗。ネットワークが切れたときに待ち続けない。
    req.setTimeout(opts.stallMs || 30_000, () => req.destroy(new UpdateError("stall")));
    req.on("error", (e) => reject(e instanceof UpdateError ? e : new UpdateError("network", e && e.message)));
    if (opts.signal) opts.signal.addEventListener("abort", () => req.destroy(new UpdateError("cancelled")), { once: true });
  });
}

/** 小さなテキスト（.minisig）を取る。上限を超えたら失敗。 */
function fetchText(url, opts, maxBytes = 8192) {
  return request(url, opts, (res) => new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    res.on("data", (c) => {
      n += c.length;
      if (n > maxBytes) { reject(new UpdateError("too-large")); res.destroy(); return; } // 先に reject（destroy が 'aborted' を同期で出す）
      parts.push(c);
    });
    res.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    res.on("error", (e) => reject(new UpdateError("network", e && e.message)));
    res.on("aborted", () => reject(new UpdateError("network", "aborted")));
  }));
}

/**
 * 資産を destFile へ落とす（`.part` に書いて、サイズ・SHA-256 が合ったときだけ rename）。
 * どの失敗でも部分ファイルを消して reject する。
 */
function downloadToFile(url, destFile, expected, opts, onProgress) {
  const part = `${destFile}.part`;
  const cleanup = () => { try { fs.rmSync(part, { force: true }); } catch { /* 無ければよい */ } };
  let out = null; // 書き込みストリーム（応答が来てから作る）
  // 🚨 どの経路の失敗でも「書き込みストリームを閉じてから」部分ファイルを消し、そのあとで reject する。
  //    createWriteStream の open は非同期で、閉じる前に消すとあとから .part が作られて残る。
  //    また、無通信・中止は request 層が先に reject するので、ここ（外側）でも後始末を待つ。
  const closeOut = () => new Promise((resolve) => {
    if (!out || out.closed) return resolve();
    out.once("close", resolve);
    out.destroy();
  });
  return request(url, opts, (res) => new Promise((resolve, reject) => {
    let settled = false;
    out = fs.createWriteStream(part, { mode: 0o600 });
    const sha = crypto.createHash("sha256");
    let bytes = 0;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      res.destroy();
      closeOut().then(() => {
        cleanup();
        reject(err instanceof UpdateError ? err : new UpdateError("network", err && err.message));
      });
    };
    const len = Number(res.headers["content-length"]);
    if (Number.isFinite(len) && len !== expected.size) return fail(new UpdateError("size-mismatch", `content-length ${len} != ${expected.size}`));
    res.on("data", (c) => {
      bytes += c.length;
      if (bytes > expected.size) return fail(new UpdateError("size-mismatch", "over"));
      sha.update(c);
      if (onProgress) onProgress(bytes);
    });
    res.on("error", fail);
    res.on("aborted", () => fail(new UpdateError("network", "aborted")));
    out.on("error", fail);
    res.pipe(out);
    out.on("finish", () => {
      if (settled) return;
      if (bytes !== expected.size) return fail(new UpdateError("size-mismatch", `${bytes} != ${expected.size}`));
      const got = sha.digest("hex");
      if (got !== expected.sha256) return fail(new UpdateError("digest-mismatch"));
      try { fs.renameSync(part, destFile); } catch (e) { return fail(e); }
      settled = true;
      resolve({ bytes, sha256: got });
    });
  })).catch(async (e) => {
    await closeOut();
    cleanup();
    throw e;
  });
}

// ── 適用 ─────────────────────────────────────────────────────────────────────

/** 適用の計画（副作用なし）。mode: "now"（再起動して使う）| "onQuit"（終了時に入れ替えるだけ）。 */
function buildApplyPlan(kind, file, mode, ctx) {
  if (kind === "nsis") {
    // `--updated`: electron-updater と同じ（旧版のアンインストーラがユーザーデータを消さない・ショートカットを作り直さない）。
    // `/S`: サイレント。`--force-run`: サイレントのあとアプリを起動（今すぐのときだけ）。
    return { kind: "spawn", command: file, args: ["--updated", "/S", ...(mode === "now" ? ["--force-run"] : [])] };
  }
  if (kind === "appimage") {
    return { kind: "replace-appimage", from: file, to: ctx.appImage, relaunch: mode === "now" };
  }
  throw new UpdateError("unknown-kind", kind);
}

/** 計画を実行する（終了の直前に呼ぶ）。spawn は分離して親の終了後も生きる。 */
function executeApplyPlan(ap, deps = {}) {
  const sp = deps.spawn || spawn;
  if (ap.kind === "spawn") {
    const child = sp(ap.command, ap.args, { detached: true, stdio: "ignore", windowsHide: true });
    if (child.on) child.on("error", (e) => console.error("[update] installer spawn failed:", e && e.message)); // 終了処理を落とさない
    child.unref();
    return;
  }
  if (ap.kind === "replace-appimage") {
    const dir = path.dirname(ap.to);
    const tmp = path.join(dir, `.${path.basename(ap.to)}.new`);
    // 同じディレクトリに置いてから rename する（別の領域をまたぐ rename は原子的でない）。実行中のファイルの置換は inode が残るので可。
    fs.copyFileSync(ap.from, tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, ap.to);
    if (ap.relaunch) {
      const env = { ...process.env, GRAPHY_RELAUNCHED: "1" }; // 起動側が前のアプリの backend のポート解放を待つ
      const child = sp(ap.to, [], { detached: true, stdio: "ignore", env });
      if (child.on) child.on("error", (e) => console.error("[update] relaunch failed:", e && e.message));
      child.unref();
    }
    return;
  }
  throw new UpdateError("unknown-plan", ap.kind);
}

// ── 状態遷移 ─────────────────────────────────────────────────────────────────

/**
 * 更新の進行を持つ。phase: idle → downloading → verifying → (now) applying | (onQuit) ready。
 * 失敗・中止は failed / cancelled（再試行しない。利用者が選び直せば最初から）。
 * deps（テストで差し替える）: download, fetchText, verifyFile, quit, execute。
 */
class UpdateController extends EventEmitter {
  /**
   * @param {{dir:string, trustedKeys:string[], ctx:object, netOpts?:object, deps?:object}} o
   *   ctx: { appImage } 適用に要る環境。netOpts: request の opts（stallMs・insecureLocal）。
   */
  constructor(o) {
    super();
    this.dir = o.dir;
    this.trustedKeys = o.trustedKeys;
    this.ctx = o.ctx || {};
    this.netOpts = o.netOpts || {};
    this.deps = {
      download: downloadToFile,
      fetchText,
      verifyFile: require("./minisign").verifyFile,
      quit: () => {},
      execute: executeApplyPlan,
      ...(o.deps || {}),
    };
    this.state = { phase: "idle" };
    this.abort = null;
    this.pending = null; // { kind, file, mode, version }
    this.applied = false;
  }

  getState() {
    return { ...this.state };
  }

  _set(patch) {
    this.state = { ...patch };
    this.emit("state", this.getState());
  }

  _busy() {
    return ["downloading", "verifying", "applying"].includes(this.state.phase);
  }

  /** 実行中（取得・検証・適用）か。IPC の入口で、二重開始を呼び出し元へ返すために使う。 */
  isBusy() {
    return this._busy();
  }

  /** 前回の起動で残ったもの（保留印・ダウンロード済みの資産）を、今の版に照らして整理する。 */
  reconcile(currentVersion) {
    const marker = path.join(this.dir, "pending.json");
    let p = null;
    try { p = JSON.parse(fs.readFileSync(marker, "utf8")); } catch { /* 無い・壊れている */ }
    if (!p || p.applied || !isNewer(p.version, currentVersion) || !p.file || !fs.existsSync(p.file)) {
      // 更新済み（版が追いついた）・適用を試みたのに版が上がっていない（インストーラの失敗など。毎回の終了で再試行し続けない）・
      // ファイルが無い・壊れている → 残骸ごと消す
      try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* 次回また試す */ }
      return;
    }
    // 前回「終了時に更新」を選んで、終了時に入れ替わらなかった（強制終了など）→ 次の終了時に入れ替える
    this.pending = { kind: p.kind, file: p.file, mode: "onQuit", version: p.version };
    this._set({ phase: "ready", version: p.version, mode: "onQuit" });
  }

  /** ダウンロード → 検証 → (今すぐ)終了して適用 / (終了時)保留。plan は pickAsset の戻り（supported:true）。 */
  async start(plan, mode) {
    if (!plan || !plan.supported) throw new UpdateError("unsupported", plan && plan.reason);
    if (mode !== "now" && mode !== "onQuit") throw new UpdateError("bad-mode", String(mode));
    if (this._busy()) throw new UpdateError("busy");
    this.abort = new AbortController();
    const total = plan.asset.size;
    const verDir = path.join(this.dir, plan.version);
    const file = path.join(verDir, plan.asset.name);
    const opts = { ...this.netOpts, signal: this.abort.signal };
    try {
      fs.rmSync(this.dir, { recursive: true, force: true }); // 古い残骸は持ち越さない
      fs.mkdirSync(verDir, { recursive: true, mode: 0o700 });
      this._set({ phase: "downloading", version: plan.version, mode, bytes: 0, total });
      const sigText = await this.deps.fetchText(plan.sig.url, opts);
      await this.deps.download(plan.asset.url, file, { size: total, sha256: plan.asset.sha256 }, opts, (bytes) => {
        this.state = { phase: "downloading", version: plan.version, mode, bytes, total };
        this.emit("state", this.getState());
      });
      this._set({ phase: "verifying", version: plan.version, mode, bytes: 0, total });
      const v = await this.deps.verifyFile(file, sigText, this.trustedKeys, {
        expectTrusted: plan.expectTrusted,
        onProgress: (bytes) => { this.state = { phase: "verifying", version: plan.version, mode, bytes, total }; this.emit("state", this.getState()); },
      });
      if (this.abort.signal.aborted) throw new UpdateError("cancelled");
      if (!v.ok) throw new UpdateError(`signature-${v.reason}`, v.detail);
      this.pending = { kind: plan.kind, file, mode, version: plan.version };
      fs.writeFileSync(path.join(this.dir, "pending.json"), JSON.stringify({ ...this.pending, savedAt: new Date().toISOString() }), { mode: 0o600 });
      if (mode === "now") {
        this._set({ phase: "applying", version: plan.version, mode });
        this.deps.quit();
      } else {
        this._set({ phase: "ready", version: plan.version, mode });
      }
    } catch (e) {
      try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* 無視 */ }
      this.pending = null;
      const cancelled = e instanceof UpdateError && e.code === "cancelled";
      this._set({ phase: cancelled ? "cancelled" : "failed", version: plan.version, reason: e instanceof UpdateError ? e.code : "error", detail: e instanceof UpdateError ? e.detail : String(e && e.message) });
    } finally {
      this.abort = null;
    }
  }

  cancel() {
    if (this.abort) this.abort.abort();
  }

  /** アプリの終了の直前に呼ぶ。保留があれば入れ替えを実行する（1 回だけ）。実行したら true。 */
  applyOnQuit() {
    if (this.applied || !this.pending || !["ready", "applying"].includes(this.state.phase)) return false;
    this.applied = true;
    // 適用を試みた印を先に残す（失敗しても次の終了で再試行しない。版が上がっていれば reconcile が残骸を消す）
    try { fs.writeFileSync(path.join(this.dir, "pending.json"), JSON.stringify({ ...this.pending, applied: true, appliedAt: new Date().toISOString() }), { mode: 0o600 }); } catch { /* 印が書けなくても適用は続ける */ }
    const ap = buildApplyPlan(this.pending.kind, this.pending.file, this.pending.mode, this.ctx);
    this.deps.execute(ap);
    return true;
  }
}

module.exports = {
  UpdateError, UpdateController,
  normalizeVersion, isNewer, isAllowedHost, pickAsset, describePlan, releaseApiUrl, devOverrides,
  request, fetchText, downloadToFile, buildApplyPlan, executeApplyPlan,
};
