/*
 * 自動更新（desktop/appUpdate.js）の実機検証（main・preload・実際の Electron）。画面の操作は段 B2 で足す。
 * ここでは preload の API（window.graphyDesktop.checkForUpdate / updateStart / updateState）を直接呼ぶ。
 *
 * 偽のリリースサーバー（ローカル）が GitHub Releases の JSON と資産を返す。資産は AppImage に見立てた小さなシェルスクリプト
 * （起動されたら目印のファイルを書く）で、**実際の minisign（CLI）で使い捨て鍵で署名**する（trusted comment は
 * `graphy-next v<版> <ファイル名>`）。開発（未パッケージ）のときだけ有効な環境変数で、更新元・信頼鍵・APPIMAGE を差し替える。
 *
 * 実行:  cd automator && npx tsx src/spike/appUpdateMainCheck.ts
 * 前提: backend/target/graphy-next-backend.jar、minisign（CLI）、Linux（AppImage の入れ替えを見る）。
 *
 * 見るもの（合格・失敗・未達を分けて数える）:
 *   S0 既定のまま（ボタンを押さない）: 自動更新できると分かるが、資産は 1 バイトも取りに行かない
 *   S1 終了時: 取得・検証して保留 → 終了で入れ替わる（再起動しない）
 *   S2 今すぐ: 取得・検証 → アプリが終了 → 入れ替わり、新しい AppImage が再起動される
 *   負例: 中身の差し替え（digest）／中身も digest も差し替え（署名）／途中で切断／署名なし の版 → 失敗・見送り、旧版は無傷
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const { check, summary } = createChecker();
const ROOT = path.resolve(AUTOMATOR_ROOT, "..");
const PORTS = { http: 18650, scp: 18651, vite: 18653 };
const FAKE_PORT = 18655;
const T = fs.mkdtempSync(path.join(os.tmpdir(), "app-update-spike-"));

const current: string = JSON.parse(fs.readFileSync(path.join(ROOT, "desktop", "package.json"), "utf8")).version;
const next = ((): string => { const p = current.split(".").map(Number); p[2] += 1; return p.join("."); })();
const ASSET = `GRAPHY-Next-${next}.AppImage`;

const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

// ── 資産と署名（実際の minisign）──
const marker = path.join(T, "relaunched.marker");
const asset = Buffer.from(`#!/bin/sh\necho "relaunched RELAUNCHED=$GRAPHY_RELAUNCHED" > '${marker}'\n# ${"x".repeat(700_000)}\n`);
fs.writeFileSync(path.join(T, ASSET), asset);
execFileSync("minisign", ["-G", "-f", "-W", "-p", path.join(T, "k.pub"), "-s", path.join(T, "k.key")], { stdio: "ignore" });
execFileSync("minisign", ["-S", "-s", path.join(T, "k.key"), "-m", path.join(T, ASSET), "-x", path.join(T, `${ASSET}.minisig`), "-t", `graphy-next v${next} ${ASSET}`], { stdio: "ignore" });
const sig = fs.readFileSync(path.join(T, `${ASSET}.minisig`));
const pubKey = fs.readFileSync(path.join(T, "k.pub"), "utf8").trim().split("\n").pop()!;

// ── 偽のリリースサーバー ──
type Mode = "normal" | "tamper" | "tamperSigned" | "cutoff" | "noSig";
const server = { mode: "normal" as Mode, hits: [] as string[] };
const tampered = Buffer.from(asset); tampered[40] ^= 1;
function releaseJson(base: string) {
  const served = server.mode === "tamperSigned" ? tampered : asset;
  const assets = [
    { name: ASSET, size: asset.length, digest: `sha256:${sha256(served)}`, browser_download_url: `${base}/dl/${ASSET}` },
    { name: `GRAPHY-Next-${next}-arm64.dmg`, size: 10, digest: `sha256:${"0".repeat(64)}`, browser_download_url: `${base}/dl/x.dmg` },
  ];
  if (server.mode !== "noSig") assets.push({ name: `${ASSET}.minisig`, size: sig.length, digest: `sha256:${sha256(sig)}`, browser_download_url: `${base}/dl/${ASSET}.minisig` });
  return { tag_name: `v${next}`, name: `v${next}`, body: "テスト用の偽リリース", html_url: `${base}/release`, published_at: new Date().toISOString(), assets };
}
const srv: Server = http.createServer((req, res) => {
  const url = req.url ?? "";
  server.hits.push(url);
  const base = `http://127.0.0.1:${FAKE_PORT}`;
  if (url.endsWith("/releases/latest")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(releaseJson(base))); return; }
  if (url === `/dl/${ASSET}.minisig`) { res.writeHead(200); res.end(sig); return; }
  if (url === `/dl/${ASSET}`) {
    const body = server.mode === "tamper" || server.mode === "tamperSigned" ? tampered : asset;
    res.writeHead(200, { "content-length": body.length });
    if (server.mode === "cutoff") { res.write(body.subarray(0, 200_000)); setTimeout(() => res.socket?.destroy(), 100); return; }
    res.end(body);
    return;
  }
  res.writeHead(404); res.end();
});
const assetHits = () => server.hits.filter((u) => u.startsWith("/dl/")).length;

const oldContent = "OLD-APPIMAGE\n";
function freshOldAppImage(): string {
  const p = path.join(T, "app", `GRAPHY-Next-${current}.AppImage`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, oldContent, { mode: 0o755 });
  return p;
}

async function pollState(page: any, phases: string[], ms: number): Promise<any> {
  const end = Date.now() + ms;
  let s: any = null;
  while (Date.now() < end) {
    s = await page.evaluate("window.graphyDesktop.updateState()");
    if (phases.includes(s.phase)) return s;
    await new Promise((r) => setTimeout(r, 200));
  }
  return s;
}

let launchNo = 0;
async function launch(appImage: string): Promise<DesktopDriver> {
  // 起動ごとに専用の userData（前回の保留印や、開発機の実際の設定と混ざらない）
  const userData = path.join(T, `userdata-${++launchNo}`);
  fs.mkdirSync(userData, { recursive: true });
  const d = new DesktopDriver(PORTS, {
    extraElectronArgs: [`--user-data-dir=${userData}`],
    extraEnv: {
      GRAPHY_UPDATE_API_BASE: `http://127.0.0.1:${FAKE_PORT}`,
      GRAPHY_UPDATE_TRUSTED_KEY: pubKey,
      APPIMAGE: appImage,
    },
  });
  await d.start();
  return d;
}

async function main(): Promise<void> {
  if (process.platform !== "linux") { console.log("  [未達] Linux 専用（AppImage の入れ替えを見る）"); process.exitCode = 2; return; }
  await new Promise<void>((r) => srv.listen(FAKE_PORT, "127.0.0.1", r));
  try {
    // ── 失敗系と既定の経路（1 つの起動で続けて）──
    const app1 = freshOldAppImage();
    let d = await launch(app1);
    try {
      const p = d.page;
      console.log("\n[S0] 既定のまま: 更新確認だけ。ボタンを押さない");
      server.mode = "normal"; server.hits = [];
      const info: any = await p.evaluate("window.graphyDesktop.checkForUpdate()");
      console.log(`  checkForUpdate: ${JSON.stringify({ tagName: info?.tagName, auto: info?.auto })}`);
      check(info?.tagName === `v${next}`, "新版の情報が取れた", info?.tagName);
      check(info?.auto?.supported === true && info.auto.assetName === ASSET, "この環境（Linux・AppImage）では自動更新できると分かる", info?.auto);
      check(JSON.stringify(info?.auto).includes("http") === false, "レンダラへ資産の URL を渡していない");
      await new Promise((r) => setTimeout(r, 1500));
      check(assetHits() === 0, "ボタンを押さない限り、資産を 1 回も取りに行かない（勝手に始まらない）", server.hits);
      check((await p.evaluate("window.graphyDesktop.updateState()") as any).phase === "idle", "状態は idle のまま");

      console.log("\n[負例 1] 中身の差し替え（API の digest はそのまま）→ digest 不一致で見送り");
      server.mode = "tamper"; server.hits = [];
      await p.evaluate("window.graphyDesktop.checkForUpdate()");
      const r1: any = await p.evaluate("window.graphyDesktop.updateStart('onQuit')");
      check(r1?.ok === true, "updateStart が受け付けられた");
      let s: any = await pollState(p, ["failed", "ready"], 30_000);
      check(s.phase === "failed" && s.reason === "digest-mismatch", "failed(digest-mismatch)", s);
      check(fs.readFileSync(app1, "utf8") === oldContent, "旧版は無傷");

      console.log("\n[負例 2] 中身と digest をそろって差し替え（GitHub 側の改ざん）→ 署名で拒否");
      server.mode = "tamperSigned"; server.hits = [];
      await p.evaluate("window.graphyDesktop.checkForUpdate()");
      await p.evaluate("window.graphyDesktop.updateStart('now')");
      s = await pollState(p, ["failed", "ready", "applying"], 30_000);
      check(s.phase === "failed" && s.reason === "signature-bad-signature", "failed(signature-bad-signature)", s);
      check(fs.readFileSync(app1, "utf8") === oldContent, "旧版は無傷");
      check((await p.evaluate("window.graphyDesktop.updateState()") as any).phase === "failed", "アプリは終了していない（今すぐでも検証に失敗したら止まる）");

      console.log("\n[負例 3] 途中で接続が切れる → 失敗として見送り");
      server.mode = "cutoff"; server.hits = [];
      await p.evaluate("window.graphyDesktop.checkForUpdate()");
      await p.evaluate("window.graphyDesktop.updateStart('onQuit')");
      s = await pollState(p, ["failed", "ready"], 30_000);
      check(s.phase === "failed" && s.reason === "network", "failed(network)", s);
      const userData: string = await d.app.evaluate(({ app }) => app.getPath("userData"));
      check(!fs.existsSync(path.join(userData, "updates")) || fs.readdirSync(path.join(userData, "updates")).length === 0, "部分ファイルを残していない");
      check(fs.readFileSync(app1, "utf8") === oldContent, "旧版は無傷");

      console.log("\n[負例 4] 署名の無い版 → 自動更新の対象外（通知だけ）。開始も拒否");
      server.mode = "noSig"; server.hits = [];
      const info4: any = await p.evaluate("window.graphyDesktop.checkForUpdate()");
      check(info4?.auto?.supported === false && info4.auto.reason === "signature-missing", "auto.supported=false(signature-missing)", info4?.auto);
      const r4: any = await p.evaluate("window.graphyDesktop.updateStart('now')");
      check(r4?.ok === false && r4.reason === "no-plan", "updateStart は no-plan で拒否", r4);
      check(assetHits() === 0, "資産を取りに行っていない");

      console.log("\n[負例 5] 不正な mode・実行中の二重開始は IPC の戻りで拒否される");
      server.mode = "normal"; server.hits = [];
      await p.evaluate("window.graphyDesktop.checkForUpdate()");
      const r5a: any = await p.evaluate("window.graphyDesktop.updateStart('later')");
      check(r5a?.ok === false && r5a.reason === "bad-mode", "不正な mode は bad-mode", r5a);
      check(assetHits() === 0, "不正な mode では取りに行かない");
      server.mode = "cutoff"; // 取得の途中で止まる版（接続が切れるまでの間は実行中）
      await p.evaluate("window.graphyDesktop.checkForUpdate()");
      const r5b: any = await p.evaluate("window.graphyDesktop.updateStart('onQuit')");
      const r5c: any = await p.evaluate("window.graphyDesktop.updateStart('onQuit')");
      check(r5b?.ok === true && r5c?.ok === false && r5c.reason === "busy", "実行中の 2 回目は busy", [r5b, r5c]);
      await pollState(p, ["failed", "ready"], 30_000);
    } finally {
      await d.stop();
    }

    // ── S1 終了時 ──
    console.log("\n[S1] 終了時: 取得・検証して保留 → 終了で入れ替わる（再起動しない）");
    const app2 = freshOldAppImage();
    fs.rmSync(marker, { force: true });
    server.mode = "normal"; server.hits = [];
    d = await launch(app2);
    try {
      const p = d.page;
      await p.evaluate("window.graphyDesktop.checkForUpdate()");
      await p.evaluate("window.graphyDesktop.updateStart('onQuit')");
      const s: any = await pollState(p, ["failed", "ready"], 30_000);
      check(s.phase === "ready" && s.mode === "onQuit", "ready（終了時に更新）", s);
      check(assetHits() >= 2, "資産と署名を取得した", server.hits);
      check(fs.readFileSync(app2, "utf8") === oldContent, "終了するまでは旧版のまま（勝手に入れ替えない）");
      await d.app.evaluate(({ app }) => { app.quit(); });
      const end = Date.now() + 30_000;
      while (Date.now() < end && fs.readFileSync(app2, "utf8") === oldContent) await new Promise((r) => setTimeout(r, 200));
      check(fs.readFileSync(app2).equals(asset), "終了で AppImage が新しい中身に入れ替わった");
      check((fs.statSync(app2).mode & 0o777) === 0o755, "実行権限 755");
      check(fs.readdirSync(path.dirname(app2)).length === 1, "一時ファイル（.new）が残っていない");
      await new Promise((r) => setTimeout(r, 1500));
      check(!fs.existsSync(marker), "終了時の更新では再起動しない");
    } finally {
      await d.stop();
    }

    // ── S2 今すぐ ──
    console.log("\n[S2] 今すぐ: 取得・検証 → アプリが終了 → 入れ替わり、新しい AppImage が再起動される");
    const app3 = freshOldAppImage();
    fs.rmSync(marker, { force: true });
    server.mode = "normal"; server.hits = [];
    d = await launch(app3);
    try {
      const p = d.page;
      await p.evaluate("window.graphyDesktop.checkForUpdate()");
      await p.evaluate("window.graphyDesktop.updateStart('now')");
      const end = Date.now() + 40_000;
      while (Date.now() < end && !fs.existsSync(marker)) await new Promise((r) => setTimeout(r, 250));
      check(fs.existsSync(marker), "新しい AppImage が起動された（目印のファイルが書かれた）");
      check(fs.existsSync(marker) && /RELAUNCHED=1/.test(fs.readFileSync(marker, "utf8")), "再起動には GRAPHY_RELAUNCHED=1 が付く（前のアプリの backend のポート解放を待たせる）");
      check(fs.readFileSync(app3).equals(asset), "AppImage が新しい中身に入れ替わった");
    } finally {
      await d.stop();
    }
  } finally {
    srv.close();
    fs.rmSync(T, { recursive: true, force: true });
  }
}

main()
  .then(() => process.exit(process.exitCode || (summary() === 0 ? 0 : 1)))
  .catch((e) => { console.error(e); process.exit(2); });
