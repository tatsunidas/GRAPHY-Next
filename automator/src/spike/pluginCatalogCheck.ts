/*
 * 設定＞プラグイン＞見つける（公式索引の一覧と、一覧からの導入）の実機検証。設計: fw/plugin-manager-design.md §8。
 *
 * 実行:  cd automator && npx tsx src/spike/pluginCatalogCheck.ts
 * 前提:  backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）、frontend・desktop・automator の npm ci。
 *        ネットワークが要る（A は本物の索引 raw.githubusercontent.com と本物の Release を使う）。
 *
 * 何を確かめるか（本物の Electron ＋ 本物の backend）:
 *   A. 本物の索引: 3 件が出る。公式・未導入の印。art を一覧から導入すると、同意画面なしで入り、台帳が verified・github。
 *      一覧が「導入済み」に変わる。索引のキャッシュが書かれる。
 *   B. 索引に届かない状態＋改ざんしたキャッシュ（索引 URL は https のみなので、偽サーバーの代わりにキャッシュを使う）:
 *      「前回の一覧」の表示が出る。負例: 鍵 ID が違う行・プラグイン ID が違う行は、導入を押しても同意画面に進まず、
 *      理由が出て、台帳に何も入らない。
 *
 * 結果は 合格 / 失敗 / 未達 に分けて数える。Windows・macOS 実機は確かめない（未達として数える）。
 */
import fs from "node:fs";
import path from "node:path";

import { DesktopDriver, } from "../driver/desktopDriver.js";
import { DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "plugin-catalog-check");
const PORTS = { http: 19390, scp: 19391, vite: 19393 };
const PLUGINS_DIR = path.join(DESKTOP_RUN_DATA_DIR, "plugins");
const UNREACHABLE_INDEX = "https://127.0.0.1:9/index.json";
const OFFICIAL = "98EA7C6BA2D50118";

const { check, summary } = createChecker();
const pending: string[] = [];
function pend(label: string, why: string): void {
  console.log(`  [未達] ${label} — ${why}`);
  pending.push(label);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const base = `http://localhost:${PORTS.http}`;

interface Ledger { id: string; version: string; trust: string; source: { type: string; ref: string } | null }
async function ledger(): Promise<Ledger[]> {
  const r = await fetch(`${base}/api/plugin-manager/installed`);
  if (!r.ok) throw new Error(`installed → HTTP ${r.status}`);
  return (await r.json()) as Ledger[];
}

async function installCapture(driver: DesktopDriver): Promise<void> {
  await driver.app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __dlg: unknown[] };
    g.__dlg = [];
    dialog.showMessageBoxSync = ((...args: unknown[]) => {
      g.__dlg.push(args[args.length - 1]);
      return 0; // 「許可する」
    }) as typeof dialog.showMessageBoxSync;
  });
}

async function ensureOptIn(driver: DesktopDriver): Promise<void> {
  const st = (await (await fetch(`${base}/api/plugin-manager/status`)).json()) as { installEnabled: boolean };
  if (st.installEnabled) return;
  const ok = await driver.page.evaluate(() =>
    (window as unknown as { graphyDesktop: { pluginInstallOptIn: (b: boolean) => Promise<{ ok: boolean }> } })
      .graphyDesktop.pluginInstallOptIn(true).then((r) => r.ok));
  if (!ok) throw new Error("opt-in failed");
}

async function openCatalog(driver: DesktopDriver): Promise<void> {
  const page = driver.page;
  await page.getByTestId("mainscreen-menu-system").click();
  await page.getByTestId("menu-item-settings").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("settings-cat-plugins").click();
  await page.getByTestId("pluginmgr-tab-catalog").click();
}

async function withDriver<T>(env: Record<string, string>, body: (d: DesktopDriver) => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  const driver = new DesktopDriver(PORTS);
  try {
    await driver.start();
    return await body(driver);
  } finally {
    await driver.stop().catch(() => {});
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

function cleanPlugins(): void {
  for (const f of ["catalog-cache.json", "installed.json", "bundled.json"]) {
    const p = path.join(PLUGINS_DIR, f);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  for (const d of ["art", "gemini-findings", "vis-monai", "hello-graphy"]) {
    const p = path.join(PLUGINS_DIR, d);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  cleanPlugins();

  // ---------------- A. 本物の索引 ----------------
  console.log("\n[A] 本物の索引と本物の Release");
  await withDriver({}, async (driver) => {
    await installCapture(driver);
    await driver.page.reload({ waitUntil: "domcontentloaded" });
    await ensureOptIn(driver);
    await openCatalog(driver);
    const page = driver.page;
    await page.getByTestId("pluginmgr-catalog-row-art").waitFor({ state: "visible", timeout: 30_000 });
    const ids = await page.locator('[data-testid^="pluginmgr-catalog-row-"]').evaluateAll(
      (els) => els.map((e) => (e.getAttribute("data-testid") ?? "").replace("pluginmgr-catalog-row-", "")));
    check(ids.length === 3 && ["art", "gemini-findings", "vis-monai"].every((i) => ids.includes(i)), "索引の 3 件が出る", ids);
    const artRow = page.getByTestId("pluginmgr-catalog-row-art");
    const artText = (await artRow.textContent()) ?? "";
    check(/公式|Official/.test(artText), "art は公式の印", artText.slice(0, 120));
    check(artText.includes(OFFICIAL.slice(0, 8)), "鍵 ID の頭が出る");
    check(!(await page.getByTestId("pluginmgr-catalog-stale").count()), "取得できているので「前回の一覧」の表示は出ない");
    check(fs.existsSync(path.join(PLUGINS_DIR, "catalog-cache.json")), "索引のキャッシュが書かれた");
    await page.screenshot({ path: path.join(OUT_DIR, "A1-catalog.png") });

    check((await ledger()).length === 0, "導入前の台帳は空（検査の前提）");
    await artRow.locator("button").click();
    await page.waitForFunction(
      () => /導入済み v|Installed v/.test(document.querySelector('[data-testid="pluginmgr-catalog-row-art"]')?.textContent ?? ""),
      undefined, { timeout: 120_000 });
    const l = await ledger();
    const art = l.find((p) => p.id === "art");
    check(l.length === 1 && !!art, "台帳に art だけが入った", l.map((p) => p.id));
    check(art?.trust === "verified", "🔴 信頼は verified（公式鍵の署名が実際に通った）", art);
    check(art?.source?.type === "github" && art.source.ref === "tatsunidas/graphy-next-plugin-art", "取得元は github の art リポジトリ", art?.source);
    check(!(await page.getByTestId("plugin-consent-dialog").count()), "公式鍵なので同意画面は出ない");
    await page.screenshot({ path: path.join(OUT_DIR, "A2-installed.png") });
  });

  // ---------------- B. 届かない索引＋改ざんキャッシュ ----------------
  console.log("\n[B] 索引に届かない状態と、食い違う行");
  // A で入れた art を消してから始める（台帳が空のときの負例にする）
  fs.rmSync(path.join(PLUGINS_DIR, "installed.json"), { force: true });
  fs.rmSync(path.join(PLUGINS_DIR, "art"), { recursive: true, force: true });
  fs.writeFileSync(path.join(PLUGINS_DIR, "catalog-cache.json"), JSON.stringify({
    plugins: [
      { id: "gemini-findings", name: "鍵違い", repo: "tatsunidas/graphy-next-plugin-gemini-findings", signerKeyId: "1111111111111111" },
      { id: "not-art", name: "ID違い", repo: "tatsunidas/graphy-next-plugin-art" },
    ],
  }));
  await withDriver({ GRAPHY_PLUGINS_INDEX_URL: UNREACHABLE_INDEX }, async (driver) => {
    await installCapture(driver);
    await driver.page.reload({ waitUntil: "domcontentloaded" });
    await ensureOptIn(driver);
    await openCatalog(driver);
    const page = driver.page;
    await page.getByTestId("pluginmgr-catalog-row-not-art").waitFor({ state: "visible", timeout: 60_000 });
    check(await page.getByTestId("pluginmgr-catalog-stale").isVisible(), "届かないので「前回の一覧」の表示が出る");
    await page.screenshot({ path: path.join(OUT_DIR, "B1-stale.png") });

    for (const [id, why] of [["gemini-findings", "鍵 ID が違う"], ["not-art", "プラグイン ID が違う"]] as const) {
      await page.getByTestId(`pluginmgr-catalog-row-${id}`).locator("button").click();
      await sleep(200);
      // 結果（エラー表示）が出るまで待つ。導入ボタンが元に戻る＝処理が終わった
      await page.waitForFunction(
        (i) => !/確認中|Checking/.test(document.querySelector(`[data-testid="pluginmgr-catalog-row-${i}"]`)?.textContent ?? ""),
        id, { timeout: 120_000 });
      const body = (await page.getByTestId("settings-dialog").textContent()) ?? "";
      check(/導入しません|was not installed/.test(body), `🔴 ${why}行は拒否の理由が出る`, body.slice(0, 200));
      check(!(await page.getByTestId("plugin-consent-dialog").count()), `🔴 ${why}行は同意画面に進まない`);
      check((await ledger()).length === 0, `🔴 ${why}行で台帳に何も入らない`, (await ledger()).map((p) => p.id));
      await page.screenshot({ path: path.join(OUT_DIR, `B2-${id}.png`) });
    }
  });

  // ---------------- C. 対照: 同意画面の検出が効いていること ----------------
  // B の負例は「同意画面が出ない」ことを見ている。出るべき場面で出ると示してはじめて意味がある。
  // 公開の Release はすべて公式鍵で署名済みなので、本体が信頼する鍵を別の鍵に差し替えて、
  // 公式の署名が「初めての配布者（first-use）」になる状況を作る（食い違いは無い行なので一覧のチェックは通る）。
  console.log("\n[C] 対照: 食い違いの無い行は同意画面まで進む");
  cleanPlugins();
  fs.writeFileSync(path.join(PLUGINS_DIR, "catalog-cache.json"), JSON.stringify({
    plugins: [{ id: "hello-graphy", name: "対照", repo: "tatsunidas/graphy-next-plugin-hello" }],
  }));
  const otherKey = Buffer.concat([Buffer.from("Ed"), Buffer.alloc(8, 1), Buffer.alloc(32, 2)]).toString("base64");
  await withDriver({ GRAPHY_PLUGINS_INDEX_URL: UNREACHABLE_INDEX, GRAPHY_PLUGINS_TRUSTED_KEYS: otherKey }, async (driver) => {
    await installCapture(driver);
    await driver.page.reload({ waitUntil: "domcontentloaded" });
    await ensureOptIn(driver);
    await openCatalog(driver);
    const page = driver.page;
    await page.getByTestId("pluginmgr-catalog-row-hello-graphy").locator("button").click();
    await page.getByTestId("plugin-consent-dialog").waitFor({ state: "visible", timeout: 120_000 });
    check(true, "対照: 食い違いの無い行は同意画面が出る（B の「出ない」は検出が効いた上での結果）");
    await page.screenshot({ path: path.join(OUT_DIR, "C1-consent-control.png") });
    await page.getByTestId("plugin-consent-cancel").click();
    await page.getByTestId("plugin-consent-dialog").waitFor({ state: "detached", timeout: 5_000 });
    check((await ledger()).length === 0, "対照: 取り消したので台帳は空のまま");
  });
  cleanPlugins();

  pend("Windows・macOS 実機", "Linux 機のみで実行した");
  pend("索引の食い違い（公式鍵を名乗るのに署名が通らない）の実機", "本物の Release に該当データが無い。単体テストで確認");
  const failed = summary();
  console.log(`未達 ${pending.length} 件: ${pending.join(" / ")}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
