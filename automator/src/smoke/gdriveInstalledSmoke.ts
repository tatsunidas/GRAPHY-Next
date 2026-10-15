/*
 * Google Drive バックアップの配布物スモーク（実 Drive・実 Electron）。設計: fw/gdrive-p0.md、手順書: fw/verify-db-gdrive.md
 *
 * 実行:  cd automator && npx tsx src/smoke/gdriveInstalledSmoke.ts --mode full --profile <作業用の置き場> --out <出力>
 *          [--app ../desktop/dist/linux-unpacked/graphy-next-desktop] [--port 18191] [--samples ~/graphy-demo-samples]
 *          [--token-file <{"refresh_token":…}>] [--scenario full|short]
 *        続けて別の PC を模した復元:  --mode restore --profile <別の置き場> --out <同じ出力>
 *
 * 🔴 **人の操作が要る（この 2 つだけ）**: ① Google のログイン許可（ブラウザ） ② フォルダ選択 Picker（ブラウザ）。
 *    復元（--mode restore）では ① と、バックアップの GRAPHY-DB-… フォルダを選ぶ ② 。
 * 🔴 実プロファイルを使わない: --profile は XDG_CONFIG_HOME（Linux）に向ける。Drive に置かれるのは --samples の画像で、
 *    選んだフォルダの直下に GRAPHY-DB-… が 1 つできる（検証後は利用者がゴミ箱へ）。
 *
 * 確かめること（--mode full）:
 *   1. 配布物が起動し、設定画面に Drive パネルが出る（スクリーンショット）
 *   2. ログイン → 保存先を選んで有効化 → 取り込み済みの DICOM が Drive に **件数・md5 一致**で載る
 *   3. 追加の取り込みが増分で載る（既存を二重に作らない）
 *   4. **ネット断**（backend→Google の経路を中継で切る）→ 状態がオフライン → 復帰で残件が空
 *   5. ローカルで削除 → Drive ではゴミ箱へ（完全削除でない）
 *   6. **強制終了**（SIGKILL）直後の起動で、重複なく収束する
 *   7. 正常終了で、索引スナップショットが Drive に置かれ、ロックが解放される
 * --scenario cache（モード A: Drive が正本）:
 *   C1 取り込み → C2 ログイン・「Drive が正本」で有効化 → C3 初回の同期 → C4 上限を小さくして再起動 → 追い出し（Drive は減らない）
 *   → C5 追い出された画像を開くと Drive から取り寄せる／切替・解除は断られる → C6 ネット断で 503・手元のものは開ける
 *   → C7 手元に無い検査を削除 → Drive のゴミ箱 → C8 すべてローカルに保存（完了後は追い出されない）→ C9 手元を正本へ切替 → C10 正常終了
 *   続けて --mode restore --scenario cache（別の PC を模す。索引だけ復元 → 開くと取り寄せる）
 * --mode restore:
 *   8. 別のプロファイル（＝別の PC）でログインし、Drive から空フォルダへ復元 → 全ファイルの md5 一致・索引が一致（検査 UID の一覧）
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const MODE = arg("mode", "full");
const SCENARIO = arg("scenario", "full");
const APP = path.resolve(arg("app", path.join(AUTOMATOR_ROOT, "..", "desktop", "dist", "linux-unpacked", "graphy-next-desktop")));
const PROFILE = path.resolve(arg("profile", ""));
const OUT = path.resolve(arg("out", path.join(AUTOMATOR_ROOT, ".results", "gdrive-smoke")));
const PORT = Number(arg("port", MODE === "restore" ? "18192" : "18191"));
const SAMPLES = path.resolve(arg("samples", path.join(os.homedir(), "graphy-demo-samples")));
const TOKEN_FILE = arg("token-file", "");
const CLIENT_FILE = path.resolve(AUTOMATOR_ROOT, "..", "desktop", "gdrive-oauth-client.json");

if (!process.argv.includes("--profile")) throw new Error("--profile が要ります（実プロファイルは使いません）");
if (process.platform !== "linux") throw new Error("このスクリプトは Linux 用です（Windows・macOS は Actions の実 OS ランナーで別途）");

type Status = "合格" | "失敗" | "未達";
const results: { name: string; status: Status; note: string }[] = [];
const rec = (name: string, status: Status, note = ""): void => {
  results.push({ name, status, note });
  console.log(`[${status}] ${name}${note ? " — " + note : ""}`);
};
const check = (cond: boolean, name: string, note = ""): boolean => {
  rec(name, cond ? "合格" : "失敗", note);
  return cond;
};
const say = (m: string): void => console.log(`\n>>> ${new Date().toLocaleTimeString()} ${m}\n`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until<T>(label: string, fn: () => Promise<T | null | undefined | false>, ms: number, every = 1000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch {
      // 次の周期で取り直す
    }
    await sleep(every);
  }
  console.log(`  (待ち切れず: ${label})`);
  return null;
}

// ── backend→Google の中継（ネット断の注入） ─────────────────────────────
class Relay {
  cut = false;
  private sockets = new Set<Socket>();
  private server: http.Server;
  port = 0;
  constructor() {
    this.server = http.createServer((req, res) => {
      if (this.cut) {
        req.socket.destroy();
        return;
      }
      const isToken = (req.url ?? "").startsWith("/oauth-token");
      const target = isToken ? new URL("https://oauth2.googleapis.com/token") : new URL(req.url ?? "/", "https://www.googleapis.com");
      const headers = { ...req.headers, host: target.host } as Record<string, string | string[] | undefined>;
      for (const h of ["connection", "upgrade", "http2-settings"]) delete headers[h];
      const out = https.request(target, { method: req.method, headers: headers as http.OutgoingHttpHeaders }, (pr) => {
        const h = { ...pr.headers } as http.OutgoingHttpHeaders;
        if (typeof h.location === "string") h.location = h.location.replace("https://www.googleapis.com", `http://127.0.0.1:${this.port}`);
        res.writeHead(pr.statusCode ?? 502, h);
        pr.pipe(res);
      });
      out.on("error", () => req.socket.destroy());
      req.pipe(out);
    });
    this.server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
  }
  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
  }
  setCut(v: boolean): void {
    this.cut = v;
    if (v) for (const s of this.sockets) s.destroy();
  }
  stop(): void {
    this.server.close();
    for (const s of this.sockets) s.destroy();
  }
}

// ── Drive を独立に見る（アプリとは別の経路。同じクライアント・同じ利用者） ─────────
class DriveCheck {
  private token = "";
  private expires = 0;
  private client = JSON.parse(fs.readFileSync(CLIENT_FILE, "utf8")).installed as { client_id: string; client_secret: string };
  async access(): Promise<string> {
    if (this.token && Date.now() < this.expires) return this.token;
    const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.client.client_id,
        client_secret: this.client.client_secret,
        grant_type: "refresh_token",
        refresh_token: saved.refresh_token,
      }),
    });
    if (!r.ok) throw new Error(`token ${r.status}`);
    const j = await r.json();
    this.token = j.access_token;
    this.expires = Date.now() + 50 * 60_000;
    return this.token;
  }
  async list(parent: string, includeTrashed = false): Promise<{ id: string; name: string; md5Checksum?: string; trashed: boolean; mimeType: string }[]> {
    const out: { id: string; name: string; md5Checksum?: string; trashed: boolean; mimeType: string }[] = [];
    let page = "";
    do {
      const q = encodeURIComponent(`'${parent}' in parents${includeTrashed ? "" : " and trashed=false"}`);
      const u = `https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=${encodeURIComponent("nextPageToken,files(id,name,md5Checksum,trashed,mimeType)")}${page ? `&pageToken=${page}` : ""}`;
      const r = await fetch(u, { headers: { Authorization: `Bearer ${await this.access()}` } });
      if (!r.ok) throw new Error(`list ${r.status}`);
      const j = await r.json();
      out.push(...j.files);
      page = j.nextPageToken ?? "";
    } while (page);
    return out;
  }
  async child(parent: string, name: string): Promise<string | null> {
    const l = (await this.list(parent)).find((f) => f.name === name && f.mimeType === "application/vnd.google-apps.folder");
    return l?.id ?? null;
  }
}

// ── ローカル（DB フォルダ）側 ──────────────────────────────────────
function md5File(p: string): string {
  return crypto.createHash("md5").update(fs.readFileSync(p)).digest("hex");
}
function localFiles(dicomRoot: string): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!e.name.startsWith(".") && e.name.endsWith(".dcm")) m.set(path.relative(dicomRoot, p).split(path.sep).join("~"), md5File(p));
    }
  };
  walk(dicomRoot);
  return m;
}

const dataDir = (): string => path.join(PROFILE, "GRAPHY-Next");
const dbFolder = (): string => path.join(dataDir(), "data");
const state = (): { current?: string; recent?: string[]; gdrive?: Record<string, { driveFolderId: string; mode?: string; cacheLimitBytes?: number }> } => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), "db-folders.json"), "utf8"));
  } catch {
    return {};
  }
};

// ── アプリの起動・操作 ──────────────────────────────────────────
interface Running {
  app: ElectronApplication;
  main: Page;
  pid: number;
}

async function launch(relay: Relay | null, extraEnv: Record<string, string> = {}): Promise<Running> {
  fs.mkdirSync(PROFILE, { recursive: true });
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GRAPHY_BACKEND_PORT: String(PORT),
    XDG_CONFIG_HOME: PROFILE,
    ...extraEnv,
    ...(relay
      ? {
          GRAPHY_GDRIVE_API_BASE: `http://127.0.0.1:${relay.port}`,
          GRAPHY_GDRIVE_TOKEN_URL: `http://127.0.0.1:${relay.port}/oauth-token`,
          // 周期は短くしない（製品の既定のまま）。強制終了後の再開は reconcile が担う
        }
      : {}),
  };
  delete env.GRAPHY_DEV;
  delete env.GRAPHY_BACKEND_EXTERNAL;
  const app = await electron.launch({ executablePath: APP, args: ["--no-sandbox"], env, timeout: 120_000 });
  const main = await until("メイン画面", async () => app.windows().find((w) => /renderer[\\/]index\.html/.test(w.url()) && !w.url().includes("2dviewer")) ?? null, 120_000, 250);
  if (!main) throw new Error("メイン画面が開かない");
  await main.waitForLoadState("domcontentloaded");
  await dismissStartupDialogs(main).catch(() => undefined);
  await waitForMainScreenReady(main, 120_000);
  return { app, main, pid: app.process().pid! };
}

async function openDrivePanel(main: Page): Promise<void> {
  if (await main.getByTestId("gdrive-panel").isVisible().catch(() => false)) return;
  await main.keyboard.press("Control+,");
  await main.getByTestId("settings-cat-data").click();
  await main.getByTestId("gdrive-panel").waitFor({ state: "visible", timeout: 15_000 });
  await main.getByTestId("gdrive-panel").scrollIntoViewIfNeeded();
}

const desk = (main: Page) => main.evaluate(() => (window as unknown as { graphyDesktop: { gdriveStatus: () => Promise<{ signedIn: boolean; folder: unknown; email: string | null }> } }).graphyDesktop.gdriveStatus());
const sync = async (): Promise<{ state: string; reason: string | null; pending: number; blocked: number; synced: number; lastSnapshotAt: number | null } | null> =>
  fetch(`http://127.0.0.1:${PORT}/api/gdrive/status`).then((r) => (r.ok ? r.json() : null), () => null);

async function shot(main: Page, name: string): Promise<void> {
  await main.screenshot({ path: path.join(OUT, name) }).catch(() => undefined);
}

async function signInIfNeeded(main: Page): Promise<boolean> {
  await openDrivePanel(main);
  if ((await desk(main)).signedIn) return true;
  say("🔴【操作 1/2】ブラウザが開きます。Google の許可画面で、バックアップ先のアカウントを選んで「続行」してください（10 分以内）。");
  await main.getByTestId("gdrive-signin").first().click();
  return !!(await until("ログイン", async () => (await desk(main)).signedIn, 600_000, 1500));
}

async function enableIfNeeded(main: Page, which: string, mode: "backup" | "cache" = "backup"): Promise<boolean> {
  await openDrivePanel(main);
  if ((await desk(main)).folder) return true;
  say(`🔴【操作 2/2】ブラウザでフォルダ選択（Picker）が開きます。${which} を選んで確定してください（10 分以内）。`);
  if (mode === "cache") await main.getByTestId("gdrive-mode-cache").check();
  await main.getByTestId("gdrive-enable").click();
  return !!(await until("有効化", async () => (await desk(main)).folder, 600_000, 1500));
}

/** 状態が CONNECTED・残 0 になり、かつ Drive の件数がローカルに追いつくまで待つ（取り込み直後は台帳に載る前に「残 0」に見えるため）。 */
async function converge(label: string, ms = 900_000): Promise<boolean> {
  const s = await until(label, async () => {
    const x = await sync();
    if (!(x && x.state === "CONNECTED" && x.pending === 0)) return null;
    const c = await counts(CONVERGE_DC);
    return c && c.remote === c.local ? x : null;
  }, ms, 3000);
  return !!s;
}

let CONVERGE_DC: DriveCheck;
async function counts(dc: DriveCheck): Promise<{ local: number; remote: number } | null> {
  const folderId = Object.values(state().gdrive ?? {})[0]?.driveFolderId;
  if (!folderId) return null;
  const dicomId = await dc.child(folderId, "dicom").catch(() => null);
  const remote = dicomId ? (await dc.list(dicomId)).length : 0;
  return { local: localFiles(path.join(dbFolder(), "dicom")).size, remote };
}

/** Drive の dicom/ とローカルを突き合わせる（件数・md5・名前の重複なし）。 */
async function compare(dc: DriveCheck, label: string, quiet = false): Promise<{ ok: boolean; local: number; remote: number }> {
  const st = state();
  const folderId = Object.values(st.gdrive ?? {})[0]?.driveFolderId;
  if (!folderId) {
    rec(`${label}: 保存先フォルダが記録されている`, "失敗");
    return { ok: false, local: 0, remote: 0 };
  }
  const dicomId = await dc.child(folderId, "dicom");
  const remote = dicomId ? await dc.list(dicomId) : [];
  const local = localFiles(path.join(dbFolder(), "dicom"));
  const names = remote.map((f) => f.name);
  const dup = names.length - new Set(names).size;
  let bad = 0;
  for (const f of remote) if (local.get(f.name) !== f.md5Checksum) bad++;
  const ok = remote.length === local.size && dup === 0 && bad === 0;
  if (!quiet) check(ok, `${label}: Drive の件数・md5 がローカルと一致`, `ローカル ${local.size} / Drive ${remote.length} / 重複 ${dup} / 不一致 ${bad}`);
  return { ok, local: local.size, remote: remote.length };
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(APP)) throw new Error(`アプリがありません: ${APP}`);
  if (!TOKEN_FILE || !fs.existsSync(TOKEN_FILE)) throw new Error("--token-file が要ります（Drive を独立に確かめる用。{\"refresh_token\":…}）");
  const dc = new DriveCheck();
  CONVERGE_DC = dc;
  const relay = new Relay();
  await relay.start();

  if (MODE === "restore") return SCENARIO === "cache" ? restoreCacheMode(dc) : restoreMode(dc);
  if (SCENARIO === "cache") return cacheScenario(dc, relay);

  const pick = SCENARIO === "short" ? "共有ドライブ内のフォルダ（書き込める所）" : "マイドライブのフォルダ（どれでも可）";
  const hcc = path.join(SAMPLES, "HCC_001");
  const batchB = [path.join(SAMPLES, "US_LEE_IR6.dcm"), path.join(SAMPLES, "MG_CC_L_LEE_IR87a.dcm")];
  const batchC = [path.join(SAMPLES, "MG_CC_R_LEE_IR87a.dcm"), path.join(SAMPLES, "MG_MLO_L_LEE_IR87a.dcm")];
  const batchD = [path.join(SAMPLES, "MG_MLO_R_LEE_IR87a.dcm")];
  for (const p of [hcc, ...batchB, ...batchC, ...batchD]) if (!fs.existsSync(p)) throw new Error(`試料がありません: ${p}`);

  // ── 1〜2: 起動・ログイン・有効化・初回の同期 ──
  let run = await launch(relay);
  check(true, "[1] 配布物が起動し、メイン画面が出る");
  await openDrivePanel(run.main);
  await shot(run.main, "1-panel-initial.png");
  const imp = await importPaths(PORT, [hcc]);
  check(imp.imported > 0, "[2] 試料（HCC_001）を取り込めた", JSON.stringify({ imported: imp.imported, failed: imp.failed }));
  if (!(await signInIfNeeded(run.main))) return void rec("[2] ログイン", "未達", "10 分以内にログインされなかった");
  rec("[2] ログイン", "合格", "main の状態が signedIn");
  if (!(await enableIfNeeded(run.main, pick))) return void rec("[2] 有効化", "未達", "10 分以内に保存先が選ばれなかった");
  rec("[2] 有効化", "合格", "保存先が記録された");
  check(await converge("初回の同期"), "[2] 初回の同期が完了（CONNECTED・残 0）");
  await shot(run.main, "2-synced.png");
  await compare(dc, "[2]");

  // ── 3: 増分 ──
  await importPaths(PORT, batchB);
  check(await converge("増分"), "[3] 追加の取り込みが増分で載る");
  const a3 = await compare(dc, "[3]");
  void a3;

  // ── 4: ネット断 ──
  say("ネット断の試験: backend→Google の経路を切ります（アプリ自体と画面は生きています）");
  relay.setCut(true);
  await importPaths(PORT, batchC);
  const off = await until("オフライン", async () => {
    const x = await sync();
    return x && x.state === "OFFLINE" && x.pending > 0 ? x : null;
  }, 180_000, 2000);
  check(!!off, "[4] 切断中は状態が「オフライン」で、未送信が残る", JSON.stringify(off));
  await sleep(4500);
  await shot(run.main, "4-offline.png");
  const during = await compare(dc, "[4] 切断中", true).catch(() => ({ ok: false, local: 0, remote: 0 }));
  check(during.remote < during.local, "[4] 切断中は Drive 側が追いついていない（試験が効いている）", `${during.remote} < ${during.local}`);
  relay.setCut(false);
  say("経路を戻しました。自動で再開するのを待ちます（周期は最大 30 秒＋バックオフ）");
  check(await converge("復帰", 600_000), "[4] 復帰後に残件が空になる");
  await compare(dc, "[4] 復帰後");

  // ── 5: 削除 → ゴミ箱 ──
  const studies = (await fetch(`http://127.0.0.1:${PORT}/api/studies`).then((r) => r.json())) as { studyInstanceUid: string; patientName?: string; modality?: string }[];
  const target = studies.find((s) => s.modality === "US") ?? studies[studies.length - 1];
  const beforeIds = new Set((await dc.list((await dc.child(Object.values(state().gdrive ?? {})[0].driveFolderId, "dicom"))!)).map((f) => f.id));
  const del = await fetch(`http://127.0.0.1:${PORT}/api/studies/${encodeURIComponent(target.studyInstanceUid)}`, { method: "DELETE" });
  check(del.ok, "[5] ローカルでスタディを削除した", `HTTP ${del.status}`);
  await fetch(`http://127.0.0.1:${PORT}/api/gdrive/sync`, { method: "POST" });
  check(await converge("削除の反映"), "[5] 削除が同期された（残 0）");
  const dicomId = (await dc.child(Object.values(state().gdrive ?? {})[0].driveFolderId, "dicom"))!;
  // 一覧への反映が遅れることがあるので、少し待って見る
  let trashed: { id: string }[] = [];
  await until("ゴミ箱", async () => {
    trashed = (await dc.list(dicomId, true)).filter((f) => f.trashed && beforeIds.has(f.id));
    return trashed.length > 0;
  }, 90_000, 5000);
  check(trashed.length > 0, "[5] Drive では完全削除でなくゴミ箱にある", `ゴミ箱 ${trashed.length} 件`);
  await compare(dc, "[5]");

  // ── 6: 強制終了 ──
  await importPaths(PORT, batchD);
  await sleep(1500);
  say("強制終了の試験: アプリを SIGKILL します（同期の途中のはず）");
  process.kill(run.pid, "SIGKILL");
  await sleep(3000);
  killStrayBackend();
  run = await launch(relay);
  check(await converge("強制終了後の収束", 600_000), "[6] 強制終了のあと、再起動で残件が空になる");
  const a6 = await compare(dc, "[6]");
  void a6;

  // ── 7: 正常終了 ──
  const before = await sync();
  const folderId = Object.values(state().gdrive ?? {})[0].driveFolderId;
  const listSnaps = async () => {
    const snapId = await dc.child(folderId, "index-snapshots");
    return snapId ? (await dc.list(snapId)).filter((f) => f.name.endsWith(".zip")).map((f) => f.name) : [];
  };
  const listLocks = async () => (await dc.list(folderId)).filter((f) => f.name.startsWith("lock-"));
  const snapsBefore = await listSnaps();
  const locksBefore = await listLocks();
  check(locksBefore.length > 0, "[7] 終了前: 自分のロックが Drive にある（解放の検査が空振りでない）", `${locksBefore.length} 件`);
  say("正常終了の試験: アプリを閉じます（終了時の索引スナップショットとロック解放）");
  await run.app.close().catch(() => undefined);
  // backend の終了処理（スナップショットの送信・ロック解放）が済むまで待つ。途中で次の起動や強制終了をしない
  const gone = await until("backend の終了", async () => (await fetch(`http://127.0.0.1:${PORT}/api/gdrive/status`).then(() => false, () => true)) || null, 180_000, 2000);
  check(!!gone, "[7] 閉じたあと backend が終了した");
  const snaps = await listSnaps();
  check(snaps.some((n) => !snapsBefore.includes(n)), "[7] 終了時に新しい索引スナップショットが Drive に置かれた", `${snapsBefore.length} → ${snaps.length} 世代（直前の最終 ${before?.lastSnapshotAt ?? "なし"}）`);
  const locks = await listLocks();
  check(locks.length === 0, "[7] 正常終了でロックが解放されている", `生きているロック ${locks.length}`);

  // 復元の期待値（--mode restore で突き合わせる）
  run = await launch(relay);
  const st = (await fetch(`http://127.0.0.1:${PORT}/api/studies`).then((r) => r.json())) as { studyInstanceUid: string }[];
  fs.writeFileSync(path.join(OUT, "expected.json"), JSON.stringify({ studies: st.map((s) => s.studyInstanceUid).sort(), folderId, files: [...localFiles(path.join(dbFolder(), "dicom"))] }, null, 2));
  await run.app.close().catch(() => undefined);
  relay.stop();
}

function killStrayBackend(): void {
  // 強制終了した Electron が残した backend（java）。自分の PORT で待ち受けているものだけ止める。
  try {
    const out = execFileSync("ss", ["-ltnp"], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      if (line.includes(`:${PORT} `)) {
        const m = /pid=(\d+)/.exec(line);
        if (m) process.kill(Number(m[1]), "SIGKILL");
      }
    }
  } catch {
    // 無ければ何もしない
  }
}

async function restoreMode(dc: DriveCheck): Promise<void> {
  const exp = JSON.parse(fs.readFileSync(path.join(OUT, "expected.json"), "utf8")) as { studies: string[]; folderId: string; files: [string, string][] };
  const dest = path.join(PROFILE, "restored-db");
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  let run = await launch(null);
  if (!(await signInIfNeeded(run.main))) return void rec("[8] ログイン（別の PC を模す）", "未達");
  rec("[8] ログイン（別の PC を模す）", "合格");
  // ネイティブの「フォルダを選ぶ」ダイアログは操作できないので、結果だけ差し替える（復元先は上で作った空フォルダ）
  await run.app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [d] })) as typeof dialog.showOpenDialog;
  }, dest);
  say("🔴【操作】ブラウザで Picker が開きます。**バックアップの GRAPHY-DB-… フォルダ**を選んで確定してください（10 分以内）。");
  await openDrivePanel(run.main);
  await run.main.getByTestId("gdrive-restore-button").click();
  const done = await until("復元", async () => {
    const p = await fetch(`http://127.0.0.1:${PORT}/api/gdrive/restore`).then((r) => r.json(), () => null);
    return p && (p.phase === "DONE" || p.phase === "FAILED") ? p : null;
  }, 600_000, 2000);
  await shot(run.main, "8-restored.png");
  check(!!done && done.phase === "DONE", "[8] 復元が完了する", JSON.stringify(done));
  const local = localFiles(path.join(dest, "dicom"));
  const want = new Map(exp.files);
  let bad = 0;
  for (const [k, v] of want) if (local.get(k) !== v) bad++;
  check(local.size === want.size && bad === 0, "[8] 復元した全ファイルの件数・md5 が元と一致", `元 ${want.size} / 復元 ${local.size} / 不一致 ${bad}`);
  check(fs.existsSync(path.join(dest, "graphy-index.mv.db")), "[8] 索引（graphy-index.mv.db）が復元されている");
  await run.app.close().catch(() => undefined);
  await sleep(3000);
  killStrayBackend();

  // 復元した DB を開き、検査の一覧が元と一致するか（索引の一致）
  fs.writeFileSync(path.join(dataDir(), "db-folders.json"), JSON.stringify({ current: dest, recent: [dest] }));
  run = await launch(null);
  const st = (await fetch(`http://127.0.0.1:${PORT}/api/studies`).then((r) => r.json())) as { studyInstanceUid: string }[];
  const got = st.map((s) => s.studyInstanceUid).sort();
  check(JSON.stringify(got) === JSON.stringify(exp.studies), "[8] 復元した DB を開くと、検査の一覧（UID）が元と一致する", `元 ${exp.studies.length} / 復元 ${got.length}`);
  await shot(run.main, "8-opened.png");
  await run.app.close().catch(() => undefined);
}

// ── モード A（Drive が正本）─────────────────────────────────────────────
const MB = 1024 * 1024;
/** 試験用の小さな上限。画面から選べる下限は 1 GB なので、アプリを閉じている間に設定ファイルへ書く（試料が約 60MB のため）。 */
const TEST_LIMIT_BYTES = 20 * MB;
const FAST_ENV = { GRAPHY_GDRIVE_RECENT_ACCESS_MINUTES: "0" }; // 直近に読んだものの保護を外す（待たずに追い出しを見るため）

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const syncAny = async (): Promise<any> => fetch(`http://127.0.0.1:${PORT}/api/gdrive/status`).then((r) => (r.ok ? r.json() : null), () => null);
const sopOf = (name: string): string => name.replace(/\.dcm$/, "").split("~").pop()!;

async function driveDicom(dc: DriveCheck, includeTrashed = false): Promise<{ name: string; md5?: string; trashed: boolean }[]> {
  const folderId = Object.values(state().gdrive ?? {})[0].driveFolderId;
  const dicomId = await dc.child(folderId, "dicom");
  return dicomId ? (await dc.list(dicomId, includeTrashed)).filter((f) => f.name.endsWith(".dcm")).map((f) => ({ name: f.name, md5: f.md5Checksum, trashed: f.trashed })) : [];
}

async function getInstance(sop: string): Promise<{ status: number; md5: string; message: string }> {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/instances/${encodeURIComponent(sop)}/file`);
  const buf = Buffer.from(await r.arrayBuffer());
  let message = "";
  if (!r.ok) {
    try {
      message = JSON.parse(buf.toString("utf8")).message ?? "";
    } catch {
      message = buf.toString("utf8").slice(0, 100);
    }
  }
  return { status: r.status, md5: r.ok ? crypto.createHash("md5").update(buf).digest("hex") : "", message };
}

async function closeAndWait(run: Running): Promise<void> {
  await run.app.close().catch(() => undefined);
  await until("backend の終了", async () => (await fetch(`http://127.0.0.1:${PORT}/api/gdrive/status`).then(() => false, () => true)) || null, 180_000, 2000);
}

async function cacheScenario(dc: DriveCheck, relay: Relay): Promise<void> {
  const hcc = path.join(SAMPLES, "HCC_001");
  const others = ["US_LEE_IR6.dcm", "MG_CC_L_LEE_IR87a.dcm", "MG_CC_R_LEE_IR87a.dcm", "MG_MLO_L_LEE_IR87a.dcm", "MG_MLO_R_LEE_IR87a.dcm"].map((f) => path.join(SAMPLES, f));
  for (const p of [hcc, ...others]) if (!fs.existsSync(p)) throw new Error(`試料がありません: ${p}`);
  const dicomRoot = path.join(dbFolder(), "dicom");
  const pick = "マイドライブのフォルダ（どれでも可）";

  // ── C1〜C3: 取り込み → ログイン → Drive が正本で有効化 → 初回の同期 ──
  let run = await launch(relay, FAST_ENV);
  check(true, "[C1] 配布物が起動し、メイン画面が出る");
  await openDrivePanel(run.main);
  const imp = await importPaths(PORT, [hcc, ...others]);
  check(imp.imported > 0, "[C1] 試料を取り込めた", JSON.stringify({ imported: imp.imported, failed: imp.failed }));
  const expected = localFiles(dicomRoot); // 名前 → md5（これが Drive に載るべき全件）
  const totalBytes = [...expected.keys()].reduce((n, k) => n + fs.statSync(path.join(dicomRoot, k.split("~").join(path.sep))).size, 0);
  console.log(`  取り込んだ ${expected.size} 件・${(totalBytes / MB).toFixed(1)} MB（試験用の上限 ${TEST_LIMIT_BYTES / MB} MB）`);
  check(totalBytes > TEST_LIMIT_BYTES * 1.5, "[C1] 試料の大きさが試験用の上限を十分に超える（追い出しが起きる前提）", `${(totalBytes / MB).toFixed(1)} MB`);
  if (!(await signInIfNeeded(run.main))) return void rec("[C2] ログイン", "未達", "10 分以内にログインされなかった");
  rec("[C2] ログイン", "合格", "main の状態が signedIn");
  if (!(await enableIfNeeded(run.main, pick, "cache"))) return void rec("[C2] 有効化", "未達", "10 分以内に保存先が選ばれなかった");
  rec("[C2] 有効化", "合格", "保存先が記録された");
  const mode0 = (await desk(run.main)) as unknown as { folder: { mode: string; cacheLimitBytes: number } };
  check(mode0.folder.mode === "cache" && mode0.folder.cacheLimitBytes === 15 * 1024 ** 3, "[C2] 「Drive が正本」で有効化され、上限は既定の 15 GB", JSON.stringify(mode0.folder));
  await shot(run.main, "c2-enabled-cache.png");
  CONVERGE_DC = dc;
  check(await converge("初回の同期"), "[C3] 初回の同期が完了（CONNECTED・残 0・Drive が全件）");
  const d3 = await driveDicom(dc);
  const bad3 = d3.filter((f) => expected.get(f.name) !== f.md5).length;
  check(d3.length === expected.size && bad3 === 0, "[C3] Drive に全件が md5 つきで載った", `Drive ${d3.length} / ローカル ${expected.size} / 不一致 ${bad3}`);

  // ── C4: 上限を小さくして再起動 → 追い出し（Drive は減らない） ──
  await closeAndWait(run);
  const st = state();
  const key = Object.keys(st.gdrive ?? {})[0];
  st.gdrive![key].cacheLimitBytes = TEST_LIMIT_BYTES;
  fs.writeFileSync(path.join(dataDir(), "db-folders.json"), JSON.stringify(st));
  run = await launch(relay, FAST_ENV);
  const ev = await until("追い出し", async () => {
    const x = await syncAny();
    return x && x.mode === "cache" && x.evictedCount > 0 && x.cacheBytes <= TEST_LIMIT_BYTES ? x : null;
  }, 240_000, 3000);
  check(!!ev, "[C4] 上限を超えた分が手元から消え、使用量が上限以下になる", ev ? `手元 ${(ev.cacheBytes / MB).toFixed(1)} MB / 上限 ${TEST_LIMIT_BYTES / MB} MB・Drive にだけ ${ev.evictedCount} 件` : "");
  await sleep(4000);
  await openDrivePanel(run.main);
  await shot(run.main, "c4-evicted.png");
  const local4 = localFiles(dicomRoot);
  const badLocal = [...local4].filter(([k, v]) => expected.get(k) !== v).length;
  check(local4.size < expected.size && badLocal === 0, "[C4] 手元に残ったものは壊れておらず、件数は全件より少ない", `手元 ${local4.size} / 全件 ${expected.size} / 不一致 ${badLocal}`);
  const d4 = await driveDicom(dc, true);
  check(d4.filter((f) => !f.trashed).length === expected.size && d4.filter((f) => f.trashed).length === 0, "[C4] 追い出しで Drive は減らず、ゴミ箱にも入らない", `Drive ${d4.filter((f) => !f.trashed).length} 件・ゴミ箱 ${d4.filter((f) => f.trashed).length} 件`);
  await sleep(2000);

  // ── C5: 追い出された画像を開くと Drive から取り寄せる／切替・解除は断られる ──
  let evicted = [...expected.keys()].filter((k) => !localFiles(dicomRoot).has(k));
  const target = evicted[0];
  const got = await getInstance(sopOf(target));
  check(got.status === 200 && got.md5 === expected.get(target), "[C5] 追い出された画像を開くと Drive から取り寄せられ、内容が元と一致する", `HTTP ${got.status} md5 ${got.md5 === expected.get(target) ? "一致" : "不一致"}`);
  const after5 = await until("取り寄せ後の同期", async () => {
    const x = await syncAny();
    return x && x.state === "CONNECTED" && x.pending === 0 ? x : null;
  }, 120_000, 3000);
  const d5 = await driveDicom(dc, true);
  check(!!after5 && d5.filter((f) => !f.trashed).length === expected.size && d5.filter((f) => f.trashed).length === 0, "[C5] 取り寄せたあと Drive へ送り直されず（件数不変・重複なし・ゴミ箱なし）", `Drive ${d5.filter((f) => !f.trashed).length} 件`);
  run.main.on("dialog", (d) => void d.accept());
  await openDrivePanel(run.main);
  await run.main.getByTestId("gdrive-switch-mode").click();
  await sleep(1500);
  const modeAfterTry = ((await desk(run.main)) as unknown as { folder: { mode: string } }).folder.mode;
  const panelText = await run.main.getByTestId("gdrive-panel").innerText();
  // 画面の言語（アプリの OS ロケール）に依らないよう、理由コード（画面の文言に併記される）で判定する
  check(modeAfterTry === "cache" && panelText.includes("not-all-local"), "[C5] 手元に無い画像があるうちは「手元を正本にする」が断られ、理由（not-all-local）が出る", `mode=${modeAfterTry}`);
  await run.main.locator('[data-testid="gdrive-enabled"] button').last().click(); // 並びの最後が「連携を解除」
  await sleep(1500);
  const folderStill = ((await desk(run.main)) as unknown as { folder: unknown }).folder;
  check(!!folderStill, "[C5] 手元に無い画像があるうちは連携の解除も断られる（設定が残る）");
  await shot(run.main, "c5-refused.png");

  // ── C6: ネット断 ──
  evicted = [...expected.keys()].filter((k) => !localFiles(dicomRoot).has(k));
  const onDisk = [...localFiles(dicomRoot).keys()];
  relay.setCut(true);
  await sleep(2000);
  if (evicted.length > 0 && onDisk.length > 0) {
    const off = await getInstance(sopOf(evicted[evicted.length - 1]));
    check(off.status === 503 && off.message === "offline", "[C6] ネットが切れていて手元に無い画像は、404 でなく 503＋理由 offline", `HTTP ${off.status} ${off.message}`);
    const here = await getInstance(sopOf(onDisk[0]));
    check(here.status === 200 && here.md5 === expected.get(onDisk[0]), "[C6] ネットが切れていても、手元にある画像は開ける", `HTTP ${here.status}`);
  } else {
    rec("[C6] ネット断の試験", "失敗", `前提が崩れた（手元に無い ${evicted.length} 件・手元にある ${onDisk.length} 件）`);
  }
  relay.setCut(false);
  const back = await until("復帰後の取り寄せ", async () => {
    const r = await getInstance(sopOf(evicted[evicted.length - 1]));
    return r.status === 200 ? r : null;
  }, 120_000, 3000);
  check(!!back && back.md5 === expected.get(evicted[evicted.length - 1]), "[C6] 復帰後は取り寄せられる（内容一致）");

  // ── C7: 手元に無い検査を削除 → Drive のゴミ箱 ──
  const studies = (await fetch(`http://127.0.0.1:${PORT}/api/studies`).then((r) => r.json())) as { studyInstanceUid: string; modality?: string }[];
  const localNow = localFiles(dicomRoot);
  const absentStudy = studies.find((s) => {
    const names = [...expected.keys()].filter((k) => k.startsWith(`${s.studyInstanceUid}~`));
    return names.length > 0 && names.every((k) => !localNow.has(k));
  });
  const victim = absentStudy ?? studies.find((s) => s.modality === "US") ?? studies[studies.length - 1];
  const victimNames = [...expected.keys()].filter((k) => k.startsWith(`${victim.studyInstanceUid}~`));
  check(!!absentStudy, "[C7] 削除する検査は、手元に 1 つも無い（Drive にだけある）もの", `${victimNames.length} 件`);
  const del = await fetch(`http://127.0.0.1:${PORT}/api/studies/${encodeURIComponent(victim.studyInstanceUid)}`, { method: "DELETE" });
  check(del.ok, "[C7] 削除の操作が通る", `HTTP ${del.status}`);
  await fetch(`http://127.0.0.1:${PORT}/api/gdrive/sync`, { method: "POST" });
  const trashed = await until("ゴミ箱", async () => {
    const l = await driveDicom(dc, true);
    const mine = l.filter((f) => victimNames.includes(f.name));
    return mine.length > 0 && mine.every((f) => f.trashed) && !l.some((f) => !f.trashed && victimNames.includes(f.name)) ? l : null;
  }, 240_000, 4000);
  check(!!trashed, "[C7] 手元に無かった検査の削除が、Drive ではゴミ箱への移動になる（完全削除でない）", `${victimNames.length} 件`);
  for (const n of victimNames) expected.delete(n);
  const d7 = await driveDicom(dc);
  check(d7.length === expected.size, "[C7] 残りの検査は Drive に残っている", `Drive ${d7.length} / 期待 ${expected.size}`);

  // ── C8: すべてローカルに保存（完了後は追い出されない） ──
  await openDrivePanel(run.main);
  await run.main.getByTestId("gdrive-localize").click();
  const loc = await until("全件保存", async () => {
    const p = await fetch(`http://127.0.0.1:${PORT}/api/gdrive/localize`).then((r) => r.json(), () => null);
    return p && (p.phase === "DONE" || p.phase === "FAILED") ? p : null;
  }, 600_000, 2000);
  check(!!loc && loc.phase === "DONE", "[C8] すべてローカルに保存が完了する", JSON.stringify(loc));
  await shot(run.main, "c8-localized.png");
  const local8 = localFiles(dicomRoot);
  const bad8 = [...expected].filter(([k, v]) => local8.get(k) !== v).length;
  check(local8.size === expected.size && bad8 === 0, "[C8] 全件が手元にあり、md5 が一致する", `手元 ${local8.size} / 期待 ${expected.size} / 不一致 ${bad8}`);
  await sleep(70_000); // 同期の周期を 2 回以上またぐ（上限 20MB を超えていても追い出されない）
  const local8b = localFiles(dicomRoot);
  const x8 = await syncAny();
  check(local8b.size === expected.size && x8 && x8.evictedCount === 0, "[C8] 完了後は、上限を超えていても追い出されない（周期を 2 回以上またいだあと）", `手元 ${local8b.size} / 追い出し済み ${x8?.evictedCount}`);

  // ── C9: 手元を正本へ切替 ──
  await openDrivePanel(run.main);
  await run.main.getByTestId("gdrive-switch-mode").click();
  const sw = await until("切替", async () => (((await desk(run.main)) as unknown as { folder: { mode: string } }).folder.mode === "backup" ? true : null), 30_000, 1000);
  check(!!sw, "[C9] 全件が手元にあれば「手元を正本にする」が通り、保存方式がバックアップになる");
  await sleep(2000);
  await shot(run.main, "c9-switched.png");
  const badge = await run.main.getByTestId("gdrive-mode-badge").getAttribute("data-mode");
  check(badge === "backup", "[C9] 画面の札もバックアップになる", String(badge));

  // ── C10: 正常終了 → 復元の期待値 ──
  const studiesNow = (await fetch(`http://127.0.0.1:${PORT}/api/studies`).then((r) => r.json())) as { studyInstanceUid: string }[];
  const folderId = Object.values(state().gdrive ?? {})[0].driveFolderId;
  fs.writeFileSync(path.join(OUT, "expected.json"), JSON.stringify({ studies: studiesNow.map((s) => s.studyInstanceUid).sort(), folderId, files: [...expected] }, null, 2));
  const snapDir = await dc.child(folderId, "index-snapshots");
  const snapsBefore = snapDir ? (await dc.list(snapDir)).filter((f) => f.name.endsWith(".zip")).map((f) => f.name) : [];
  await closeAndWait(run);
  const snapsAfter = snapDir ? (await dc.list(snapDir)).filter((f) => f.name.endsWith(".zip")).map((f) => f.name) : [];
  check(snapsAfter.some((n) => !snapsBefore.includes(n)), "[C10] 正常終了で、削除を反映した索引スナップショットが Drive に置かれた", `${snapsBefore.length} → ${snapsAfter.length} 世代`);
  const locks = (await dc.list(folderId)).filter((f) => f.name.startsWith("lock-"));
  check(locks.length === 0, "[C10] ロックが解放されている", `${locks.length} 件`);
  relay.stop();
}

/** 別の PC を模す: 索引だけを復元し、DICOM は開くときに取り寄せる。 */
async function restoreCacheMode(dc: DriveCheck): Promise<void> {
  const exp = JSON.parse(fs.readFileSync(path.join(OUT, "expected.json"), "utf8")) as { studies: string[]; folderId: string; files: [string, string][] };
  const want = new Map(exp.files);
  const dest = path.join(PROFILE, "restored-db");
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  let run = await launch(null, FAST_ENV);
  if (!(await signInIfNeeded(run.main))) return void rec("[R1] ログイン（別の PC を模す）", "未達");
  rec("[R1] ログイン（別の PC を模す）", "合格");
  await run.app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [d] })) as typeof dialog.showOpenDialog;
  }, dest);
  say("🔴【操作】ブラウザで Picker が開きます。**バックアップの GRAPHY-DB-… フォルダ**（先ほどの通し試験のもの）を選んで確定してください（10 分以内）。");
  await openDrivePanel(run.main);
  await run.main.getByTestId("gdrive-restore-mode-cache").check();
  await run.main.getByTestId("gdrive-restore-button").click();
  const done = await until("復元", async () => {
    const p = await fetch(`http://127.0.0.1:${PORT}/api/gdrive/restore`).then((r) => r.json(), () => null);
    return p && (p.phase === "DONE" || p.phase === "FAILED") ? p : null;
  }, 600_000, 2000);
  check(!!done && done.phase === "DONE" && done.total === 0 && done.snapshotRestored === true, "[R2] 索引だけの復元が完了する（DICOM は 0 件・スナップショットは復元）", JSON.stringify(done));
  await sleep(1500);
  await shot(run.main, "r2-restored.png");
  check(localFiles(path.join(dest, "dicom")).size === 0, "[R2] 復元した DB の手元に DICOM は 1 つも無い");
  check(fs.existsSync(path.join(dest, "graphy-index.mv.db")), "[R2] 索引（graphy-index.mv.db）が復元されている");
  const link = Object.entries(state().gdrive ?? {}).find(([k]) => path.resolve(k) === path.resolve(dest))?.[1];
  check(!!link && link.driveFolderId === exp.folderId && link.mode === "cache", "[R2] 復元先が同じ Drive フォルダに「Drive が正本」で紐付いた", JSON.stringify(link ?? null));
  await closeAndWait(run);

  // 復元した DB を開く（紐付けは残したまま、使う DB だけを切り替える）
  const s2 = state();
  s2.current = dest;
  s2.recent = [dest];
  fs.writeFileSync(path.join(dataDir(), "db-folders.json"), JSON.stringify(s2));
  run = await launch(null, FAST_ENV);
  const studies = (await fetch(`http://127.0.0.1:${PORT}/api/studies`).then((r) => r.json())) as { studyInstanceUid: string }[];
  const got = studies.map((s) => s.studyInstanceUid).sort();
  check(JSON.stringify(got) === JSON.stringify(exp.studies), "[R3] 復元した DB を開くと、検査の一覧（UID）が元と一致する", `元 ${exp.studies.length} / 復元 ${got.length}`);
  const ready = await until("同期の状態", async () => {
    const x = await syncAny();
    return x && x.mode === "cache" && x.evictedCount === want.size ? x : null;
  }, 240_000, 3000);
  check(!!ready, "[R3] 手元に無い画像が、すべて「Drive にだけある」として扱われる", ready ? `追い出し済み ${ready.evictedCount} / 期待 ${want.size}` : JSON.stringify(await syncAny()));
  const names = [...want.keys()];
  const one = names[Math.floor(names.length / 2)];
  const r3 = await getInstance(sopOf(one));
  check(r3.status === 200 && r3.md5 === want.get(one), "[R3] 復元した DB で画像を開くと、Drive から取り寄せられ内容が元と一致する", `HTTP ${r3.status}`);
  const dAfter = await driveDicom(dc, true);
  check(dAfter.filter((f) => !f.trashed).length === want.size && dAfter.filter((f) => f.trashed && want.has(f.name)).length === 0, "[R3] 復元・取り寄せで Drive の中身は変わらない（件数不変・ゴミ箱なし）", `Drive ${dAfter.filter((f) => !f.trashed).length} 件`);
  await openDrivePanel(run.main);
  await shot(run.main, "r3-opened.png");
  await run.app.close().catch(() => undefined);
}

main()
  .catch((e) => {
    console.error(e);
    rec("実行", "失敗", String(e).slice(0, 300));
  })
  .finally(() => {
    const c = (s: Status): number => results.filter((x) => x.status === s).length;
    console.log(`\n合格 ${c("合格")} / 失敗 ${c("失敗")} / 未達 ${c("未達")}`);
    fs.writeFileSync(path.join(OUT, `result-${MODE}-${SCENARIO}.json`), JSON.stringify(results, null, 2));
    process.exit(c("失敗") ? 1 : 0);
  });

