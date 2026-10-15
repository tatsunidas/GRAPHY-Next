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
const state = (): { gdrive?: Record<string, { driveFolderId: string }> } => {
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

async function launch(relay: Relay | null): Promise<Running> {
  fs.mkdirSync(PROFILE, { recursive: true });
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GRAPHY_BACKEND_PORT: String(PORT),
    XDG_CONFIG_HOME: PROFILE,
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

async function enableIfNeeded(main: Page, which: string): Promise<boolean> {
  await openDrivePanel(main);
  if ((await desk(main)).folder) return true;
  say(`🔴【操作 2/2】ブラウザでフォルダ選択（Picker）が開きます。${which} を選んで確定してください（10 分以内）。`);
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

  if (MODE === "restore") return restoreMode(dc);

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

