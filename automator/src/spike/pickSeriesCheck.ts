/*
 * シリーズ選択の窓（host.db.pickSeries・段 4）の実機検証。
 *
 * 実行:  cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package   （backend jar）
 *        cd automator && GRAPHY_JUPYTER_PYTHON=C:\\...\\anaconda3\\python.exe npx tsx src/spike/pickSeriesCheck.ts
 *
 * 本物の Electron ＋ backend jar ＋ jupyter_server（プラグイン compute-runbatch-check の pick 経路）。
 * スクリーンショットは .results/pick-series-check:
 *   [1] 窓が開く（患者名が出ている）→ 絞り込み → 展開 → 制限外は選べない → チェック → 決定。
 *       プラグインが受け取るのは選んだ順の UID だけで、患者名は含まれない
 *   [2] Esc・［取り消す］は空配列
 *   [3] スタディのチェックで、選べるシリーズ（CT）が全部選ばれる
 *   [4] 選んだものをそのまま runBatch へ → 同意の窓の行数が選んだ数と一致（同意を取り消せば何も走らない）
 * 未達（ここでは確かめない）: 2D ビューアから呼んだときの窓（Host は配置済み）、web モード、macOS/Linux。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { Page } from "playwright";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { consentWindow, createChecker } from "./computeSpikeShared.js";

const { check, summary } = createChecker();

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "pick-series-check");
const PLUGIN_ID = "compute-runbatch-check";
const ENDPOINT_ID = "automator-pick";
const AUDIT = path.join(DESKTOP_RUN_DATA_DIR, "compute-audit.jsonl");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

async function startJupyter(python: string, port: number, token: string, root: string): Promise<ChildProcess> {
  const proc = spawn(python, [
    "-m", "jupyter_server",
    "--ServerApp.ip=127.0.0.1", `--ServerApp.port=${port}`, "--ServerApp.port_retries=0",
    "--ServerApp.open_browser=False", `--IdentityProvider.token=${token}`, `--ServerApp.root_dir=${root}`,
  ], { stdio: ["ignore", "ignore", "ignore"] });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Authorization: `token ${token}` } })).ok) return proc;
    } catch {
      /* まだ */
    }
    await sleep(300);
  }
  proc.kill();
  throw new Error("jupyter_server did not start");
}

async function waitFor<T>(what: string, f: () => Promise<T | null | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await f();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`待っても起きなかった: ${what}`);
}

async function main(): Promise<void> {
  const python = process.env.GRAPHY_JUPYTER_PYTHON;
  if (!python || !fs.existsSync(python)) throw new Error("GRAPHY_JUPYTER_PYTHON を設定してください");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID, n), path.join(dst, n));
  fs.rmSync(AUDIT, { force: true });

  const jPort = await freePort();
  const jToken = crypto.randomBytes(16).toString("hex");
  const jRoot = fs.mkdtempSync(path.join(OUT_DIR, "jroot-"));
  let jupyter = await startJupyter(python, jPort, jToken, jRoot);
  const jBase = `http://127.0.0.1:${jPort}/`;
  const counterDir = fs.mkdtempSync(path.join(OUT_DIR, "counters-"));
  const cnt = (name: string) => path.join(counterDir, name).replace(/\\/g, "/");

  const driver = new DesktopDriver();
  let endpointsFile: string | null = null;
  let endpointsBackup: string | null = null;
  const consentPages: Page[] = [];
  try {
    await driver.start();
    driver.app.on("window", (p) => consentPages.push(p));
    const page = driver.page;
    page.on("console", (m) => {
      if (m.type() === "error" && !/404|Failed to load resource|network error/.test(m.text())) console.log(`  [renderer error] ${m.text().slice(0, 200)}`);
    });
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");
    await page.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    const later = page.getByRole("button", { name: /^(後で|Later)$/ });
    if (await later.isVisible().catch(() => false)) await later.click();
    const cwd = await driver.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return process.cwd();
    });
    endpointsFile = path.join(cwd, "compute-endpoints.json");
    endpointsBackup = fs.existsSync(endpointsFile) ? fs.readFileSync(endpointsFile, "utf8") : null;
    const reg = await page.evaluate(
      async ({ id, url, token }) => {
        const d = (window as unknown as { graphyDesktop: any }).graphyDesktop; // eslint-disable-line @typescript-eslint/no-explicit-any
        const a = await d.computeEndpointsSet({ endpoints: [{ id, label: "Local Jupyter", url }] });
        const b = await d.secretSet(`compute.endpoint.${id}.token`, token);
        return { a, b };
      },
      { id: ENDPOINT_ID, url: jBase, token: jToken },
    );
    if (!reg.a.ok || !reg.b.ok) throw new Error("接続先を登録できません: " + JSON.stringify(reg));

    const base = `http://localhost:${driver.ports.http}`;
    const jobs = async (): Promise<Row[]> => (await (await fetch(`${base}/api/compute/jobs`)).json()) as Row[];
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; patientName: string | null }[];
    const study = studies[0];
    const series = (await (await fetch(`${base}/api/studies/${study.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string; modality: string }[];
    const ct = series.find((s) => s.modality === "CT") ?? series[0];
    const known = new Set<string>((await jobs()).map((j) => j.id));
    const newRows = async (): Promise<Row[]> => (await jobs()).filter((j) => !known.has(j.id));
    const events = (): Row[] => fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));

    const scriptOf = (counterFile: string, sleepSec: number, failAt: number | null) => [
      "import os, json, hashlib, time",
      `p = r'${counterFile}'`,
      "n = int(open(p).read()) if os.path.exists(p) else 0",
      "open(p, 'w').write(str(n + 1))",
      "raw = open('inputs/0.npz', 'rb').read()",
      "os.makedirs('outputs', exist_ok=True)",
      "json.dump({'sha256': hashlib.sha256(raw).hexdigest(), 'n': n}, open('outputs/summary.json', 'w'))",
      `time.sleep(${sleepSec})`,
      ...(failAt == null ? [] : [`if n == ${failAt}:`, "    raise ValueError('third fails')"]),
    ].join("\n");
    const itemsOf = (keys: string[]) => keys.map((key) => ({ key, studyUid: study.studyInstanceUid, seriesUid: ct.seriesInstanceUid }));

    const launch = async (input: Record<string, unknown>) => {
      await page.evaluate((i) => {
        (window as unknown as Record<string, unknown>).__batchInput = i;
        (window as unknown as Record<string, unknown>).__batch = undefined;
      }, input);
      await page.getByTestId("mainscreen-menu-plugins").click();
      await page.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
    };
    const batchState = (): Promise<Row | undefined> => page.evaluate(() => (window as unknown as { __batch?: Row }).__batch);
    const openWindow = (): Promise<Page> =>
      driver.waitForNewPage(async () => {
        await page.getByTestId("mainscreen-menu-system").click();
        await page.getByTestId("menu-item-compute-jobs").click();
      }, (url) => url.includes("#computejobs"));
    const consentRows = async (win: Page) =>
      win.locator("#data-body tr").evaluateAll((trs) => trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent ?? "").trim())));

    // 取り込んだ検査・シリーズ（REST）。窓の表示と突き合わせる
    const allSeries = series;
    const ctSeries = allSeries.filter((s) => s.modality === "CT");
    const nonCt = allSeries.filter((s) => s.modality !== "CT");
    console.log(`  （前提）シリーズ ${allSeries.length} 件（CT ${ctSeries.length}・CT 以外 ${nonCt.length}）`);
    if (ctSeries.length < 2) throw new Error("検証には CT のシリーズが 2 つ以上要ります（ct-basic を確認）");
    const studyUid = study.studyInstanceUid;
    const pickInput = (extra: Record<string, unknown>) => ({ endpointId: ENDPOINT_ID, script: scriptOf(cnt("p.txt"), 0, null), ...extra });
    const dialog = page.getByTestId("pickseries-dialog");

    // ── [1] 窓が開き、絞り込み・展開・チェック・決定 ──
    console.log("\n[1] 窓から選ぶ");
    await launch(pickInput({ pick: { title: "CT を選ぶ（検証）", modalities: ["CT"] } }));
    await dialog.waitFor({ state: "visible", timeout: 20_000 });
    check(((await page.getByTestId("pickseries-title").textContent()) ?? "") === "CT を選ぶ（検証）", "本体の窓が開き、プラグインのタイトルが出る");
    await page.getByTestId(`pickseries-study-${studyUid}`).waitFor({ state: "visible", timeout: 20_000 });
    const listText = (await page.getByTestId("pickseries-list").textContent()) ?? "";
    check(!!study.patientName && listText.includes(study.patientName), "（前提）窓には患者名が出ている（プラグインには渡らないことを、このあと確かめる）", study.patientName);
    check((await page.getByTestId("pickseries-modality-CT").getAttribute("aria-pressed")) === "true", "制限した種類（CT）が絞り込みの初期値になる");
    // 絞り込みが効くこと（先に 0 件になる条件を入れて、戻すと一覧が戻る）
    await page.getByTestId("pickseries-filter-name").fill("ZZZZ-NO-SUCH-PATIENT");
    await page.getByTestId("pickseries-empty").waitFor({ state: "visible", timeout: 20_000 });
    check(true, "患者名で絞ると該当なし（絞り込みが効く）");
    await page.getByTestId("pickseries-filter-name").fill("");
    await page.getByTestId(`pickseries-study-${studyUid}`).waitFor({ state: "visible", timeout: 20_000 });
    check(true, "絞り込みを外すと一覧が戻る");
    await page.getByTestId(`pickseries-expand-${studyUid}`).click();
    await page.getByTestId(`pickseries-series-${ctSeries[0].seriesInstanceUid}`).waitFor({ state: "visible", timeout: 20_000 });
    check((await page.locator("[data-testid^=pickseries-series-check-]").count()) === allSeries.length, "展開するとスタディのシリーズが全部並ぶ", allSeries.length);
    if (nonCt.length > 0) {
      check(await page.getByTestId(`pickseries-series-check-${nonCt[0].seriesInstanceUid}`).isDisabled(), "🔴 制限外（CT 以外）のシリーズは選べない（チェックが無効）", nonCt[0].modality);
    } else {
      console.log("  [skip] CT 以外のシリーズが無い（負例は確かめられない）");
    }
    await page.getByTestId("pickseries-ok").isDisabled().then((d) => check(d, "（前提）何も選ばないうちは［決定］が押せない"));
    const a = ctSeries[1].seriesInstanceUid;
    const b = ctSeries[0].seriesInstanceUid;
    await page.getByTestId(`pickseries-series-check-${a}`).check();
    await page.getByTestId(`pickseries-series-check-${b}`).check();
    check(((await page.getByTestId("pickseries-count").textContent()) ?? "").includes("2"), "選択数が 2 と出る");
    await dialog.screenshot({ path: path.join(OUT_DIR, "ui-01-pick.png") });
    await page.getByTestId("pickseries-ok").click();
    await waitFor("プラグインが結果を受け取る", async () => !!(await batchState())?.outcome, 20_000);
    const st1 = (await batchState()) as Row;
    check(JSON.stringify(st1.picked) === JSON.stringify([{ studyUid, seriesUid: a }, { studyUid, seriesUid: b }]), "プラグインが受け取ったのは、選んだ順の UID（studyUid・seriesUid）", st1.picked);
    check((st1.picked as Row[]).every((p) => Object.keys(p).sort().join(",") === "seriesUid,studyUid"), "🔴 返り値のキーは studyUid・seriesUid だけ");
    check(!!study.patientName && !JSON.stringify(st1.picked).includes(study.patientName as string), "🔴 返り値に患者名が含まれない（窓には出ていた）");
    check((await dialog.count()) === 0, "決定すると窓は閉じる");

    // ── [2] 取り消し ──
    console.log("\n[2] 取り消し");
    await launch(pickInput({ pick: { modalities: ["CT"] } }));
    await dialog.waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId(`pickseries-study-${studyUid}`).waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId(`pickseries-expand-${studyUid}`).click();
    await page.getByTestId(`pickseries-series-check-${ctSeries[0].seriesInstanceUid}`).check();
    await page.keyboard.press("Escape");
    await waitFor("取り消しの結果", async () => !!(await batchState())?.outcome, 20_000);
    check(JSON.stringify(((await batchState()) as Row).picked) === "[]", "🔴 Esc で取り消すと空配列（選んでいても返さない）");
    await launch(pickInput({ pick: {} }));
    await dialog.waitFor({ state: "visible", timeout: 20_000 });
    check(((await page.getByTestId("pickseries-title").textContent()) ?? "").length > 0, "タイトルを渡さなくても既定のタイトルが出る");
    await page.getByTestId("pickseries-cancel").click();
    await waitFor("取り消しの結果（ボタン）", async () => !!(await batchState())?.outcome, 20_000);
    check(JSON.stringify(((await batchState()) as Row).picked) === "[]", "［取り消す］でも空配列");

    // ── [3] スタディのチェックで選べるシリーズを全部 ──
    console.log("\n[3] スタディのチェック");
    await launch(pickInput({ pick: { title: "スタディ", modalities: ["CT"] } }));
    await dialog.waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId(`pickseries-study-check-${studyUid}`).waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId(`pickseries-study-check-${studyUid}`).click();
    await waitFor("選択数が CT の数になる", async () => ((await page.getByTestId("pickseries-count").textContent()) ?? "").includes(String(ctSeries.length)), 20_000);
    check(true, `スタディのチェックで選べる CT のシリーズ ${ctSeries.length} 件が全部選ばれる（CT 以外は入らない）`);
    await page.getByTestId("pickseries-ok").click();
    await waitFor("結果", async () => !!(await batchState())?.outcome, 20_000);
    const st3 = (await batchState()) as Row;
    check([...(st3.picked as Row[]).map((p) => p.seriesUid)].sort().join(",") === ctSeries.map((s) => s.seriesInstanceUid).sort().join(","), "返ったのは CT のシリーズ全部（CT 以外は含まない）", (st3.picked as Row[]).length);

    // ── [4] 選んだものをそのまま runBatch へ ──
    console.log("\n[4] 選んだシリーズをそのまま一括へ");
    await launch(pickInput({ pick: { title: "一括へ", modalities: ["CT"] }, thenBatch: true }));
    await dialog.waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId(`pickseries-study-check-${studyUid}`).waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId(`pickseries-study-check-${studyUid}`).click();
    await waitFor("選択数", async () => ((await page.getByTestId("pickseries-count").textContent()) ?? "").includes(String(ctSeries.length)), 20_000);
    await page.getByTestId("pickseries-ok").click();
    const consent = await consentWindow(driver);
    const rows = await consentRows(consent);
    // 送れない組（焼き込み・格子など）は外れて「送らない組」の節に理由つきで出る（黙って減らさない）
    const refusedCount = await consent.locator("#refused-list li").count();
    check(rows.length + refusedCount === ctSeries.length && rows.length >= 1, "同意の窓が開き、送る行＋送らない組が選んだシリーズの数と一致する", { rows: rows.length, refused: refusedCount, picked: ctSeries.length });
    check(rows.map((r) => r[0]).every((k) => /^s\d+$/.test(k)), "組名は s1.. の形（患者名を入れていない）", rows.map((r) => r[0]));
    await consent.screenshot({ path: path.join(OUT_DIR, "ui-02-consent-from-pick.png") });
    await consent.getByTestId("consent-cancel").click();
    await waitFor("一括の結果（取り消し）", async () => !!(await batchState())?.outcome, 30_000);
    check((await batchState())?.outcome?.cancelled === true, "同意を取り消すと何も走らない（選択の窓は同意の代わりにならない）", (await batchState())?.outcome);
  } finally {
    await driver.stop().catch(() => undefined);
    jupyter.kill();
    if (endpointsFile) {
      if (endpointsBackup !== null) fs.writeFileSync(endpointsFile, endpointsBackup);
      else fs.rmSync(endpointsFile, { force: true });
    }
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
