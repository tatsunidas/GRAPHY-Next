/*
 * 脳萎縮定量プラグイン（`graphy-next-plugin-brain-atrophy`、id `vis-brain-atrophy`）の本体上での実機検証。
 *
 * 実行:  cd automator && BA_DB=<基準DB.npz> BA_DICOM=<T1のDICOMフォルダ> BA_AGE=72 BA_SEX=M BA_FIELD=3 \
 *          GRAPHY_AUTOMATOR_HTTP_PORT=18950 GRAPHY_AUTOMATOR_SCP_PORT=18951 GRAPHY_AUTOMATOR_VITE_PORT=18953 \
 *          PATH=<解析の Python の bin>:$PATH timeout 3000 npx tsx src/spike/brainAtrophyLocalCheck.ts [full|missing-deps]
 *   起動前に frontend/node_modules/.vite を消すこと。Linux 専用。
 *   前提: backend jar（HEAD から再ビルド）、PATH 先頭の Python に jupyter_server・ipykernel（full は gn_brain_atrophy ほか依存）。
 *
 *   full          : 2D ビューアの解析メニューから起動 → 事前チェック → 実行 → 結果（QC・指標・レポート）まで通す。
 *   missing-deps  : gn_brain_atrophy の無い Python で、事前チェックが不足を見つけ、使われる Python を名指しした導入案内を出す（負例）。
 *
 * 結果の数値の突き合わせ（CLI の直接実行との比較）は、BA_EXPECT（metrics.json）が与えられたときだけ行う。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { selectFirstStudy } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { consentWindow, createChecker, openAnalysisPlugin } from "./computeSpikeShared.js";

const { check, summary } = createChecker();
const MODE = process.argv[2] === "missing-deps" ? "missing-deps" : "full";
const PLUGIN_ID = "vis-brain-atrophy";
const PLUGIN_REPO = path.resolve(AUTOMATOR_ROOT, "..", "..", "graphy-next-plugin-brain-atrophy");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", `brain-atrophy-${MODE}`);
const AUDIT = path.join(DESKTOP_RUN_DATA_DIR, "compute-audit.jsonl");

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} を設定してください`);
  return v;
};

/** 同意の窓が開くたびに承認して、プラグインの状態が終わり（done 等）になるまで回す。承認した窓の数を返す */
async function approveUntil(driver: DesktopDriver, viewer: Page, done: (s: Record<string, unknown>) => boolean, timeoutMs: number): Promise<{ n: number; shots: string[] }> {
  const t0 = Date.now();
  let n = 0;
  const shots: string[] = [];
  while (Date.now() - t0 < timeoutMs) {
    const st = (await viewer.evaluate(() => (window as unknown as { __brainAtrophyState?: Record<string, unknown> }).__brainAtrophyState ?? {})) as Record<string, unknown>;
    if (done(st)) return { n, shots };
    const win = driver.app.windows().find((w) => w.url().endsWith("computeConsent.html"));
    if (win) {
      await win.waitForFunction(() => (document.getElementById("code")?.textContent ?? "").length > 0);
      n++;
      const shot = path.join(OUT_DIR, `consent-${n}.png`);
      await win.screenshot({ path: shot });
      shots.push(shot);
      const ack = win.getByTestId("consent-ack");
      if ((await ack.count()) > 0) await ack.check();
      await win.getByTestId("consent-send").click();
      await viewer.waitForTimeout(500);
    } else {
      await viewer.waitForTimeout(500);
    }
  }
  throw new Error("時間内に終わりませんでした");
}

async function main(): Promise<void> {
  const db = need("BA_DB");
  const dicomDir = need("BA_DICOM");
  const age = need("BA_AGE");
  const sex = need("BA_SEX");
  const field = need("BA_FIELD");
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(PLUGIN_REPO, n), path.join(dst, n));
  fs.rmSync(AUDIT, { force: true });

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const main = driver.page;
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [dicomDir]);
    console.log(`import: ${JSON.stringify(imp)}`);
    await main.reload({ waitUntil: "domcontentloaded" });
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await driver.app.evaluate(({ dialog }, p) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as unknown as typeof dialog.showOpenDialog;
    }, db);

    const rec = createStepRecorder();
    await selectFirstStudy(main, rec);
    const seriesRow = main.locator('[data-testid^="series-row-"]').first();
    await seriesRow.waitFor({ state: "visible", timeout: 15_000 });
    await seriesRow.click();
    const viewer = await driver.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click(), (u) => u.includes("2dviewer"));
    viewer.on("console", (m) => {
      if (m.type() === "error") console.log(`  [viewer error] ${m.text()}`);
    });
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(2500);

    console.log("\n[A] メニューから起動する");
    await openAnalysisPlugin(viewer, PLUGIN_ID);
    await viewer.getByTestId("ba-disclaimer").waitFor({ state: "visible", timeout: 20_000 });
    check(true, "解析メニューにプラグインが出て、窓が開く（免責の帯が見える）");
    check(((await viewer.getByTestId("ba-disclaimer").textContent()) ?? "").includes("診断機器ではありません"), "免責の文言が画面にある");
    await viewer.screenshot({ path: path.join(OUT_DIR, "a-opened.png") });

    console.log("\n[B] 入力の検査（空のまま実行）");
    await viewer.getByTestId("ba-run").click();
    await viewer.waitForTimeout(500);
    const invalid = (await viewer.getByTestId("ba-status").textContent()) ?? "";
    check(/年齢/.test(invalid) && /基準 DB/.test(invalid), "未入力では計算機へ行かず、不足を画面に出す", invalid);
    check(!fs.existsSync(AUDIT) || fs.readFileSync(AUDIT, "utf8").trim() === "", "🔴 その間、監査に送信が無い");

    console.log("\n[C] 入力して実行");
    await viewer.getByTestId("ba-age").fill(age);
    await viewer.getByTestId("ba-sex").selectOption(sex);
    await viewer.getByTestId("ba-field").selectOption(field);
    await viewer.getByTestId("ba-db-pick").click();
    await viewer.waitForFunction(() => !!(window as unknown as { __brainAtrophyState: { db?: string } }).__brainAtrophyState.db, null, { timeout: 10_000 });
    check(((await viewer.getByTestId("ba-db-path").textContent()) ?? "") === db, "基準 DB の選択が画面に反映される");
    await viewer.getByTestId("ba-run").click();

    if (MODE === "missing-deps") {
      const r = await approveUntil(driver, viewer, (s) => !!s.env, 240_000);
      await viewer.getByTestId("ba-env").waitFor({ state: "visible", timeout: 10_000 });
      const st = (await viewer.evaluate(() => (window as unknown as { __brainAtrophyState: Record<string, unknown> }).__brainAtrophyState)) as { env: { problem: string; python: string } };
      check(r.n === 1, "事前チェックの同意は 1 回だけ（画像を送る同意には進まない）", r.n);
      check(/^missing-packages: .*gn_brain_atrophy/.test(st.env.problem), "🔴 事前チェックが gn_brain_atrophy の不足を見つける", st.env.problem);
      const py = (await viewer.getByTestId("ba-env-python").textContent()) ?? "";
      check(py.includes(st.env.python) && st.env.python.includes("/bin/python"), "使われる Python（sys.executable）を名指しする", py);
      const cmd = (await viewer.getByTestId("ba-env-command").inputValue().catch(() => "")) ?? "";
      const note = (await viewer.getByTestId("ba-env-note").first().textContent().catch(() => "")) ?? "";
      check(cmd.includes(st.env.python) || note.includes(st.env.python), "導入の案内が、その Python を名指しした pip の形になっている", { cmd, note });
      check(((await viewer.getByTestId("ba-status").textContent()) ?? "").includes("足りないもの"), "状態の文が不足を伝える");
      const events = fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { event: string; bytes?: number });
      const up = events.filter((e) => e.event === "compute-uploaded");
      check(up.length === 1 && up.every((e) => e.bytes === 0), "🔴 画像は 1 バイトも送られていない（アップロードは事前チェックの 1 回だけで 0 バイト）", up);
      await viewer.screenshot({ path: path.join(OUT_DIR, "env-advice.png") });
      return;
    }

    const t0 = Date.now();
    const r = await approveUntil(driver, viewer, (s) => ["done", "qc_failed", "failed"].includes(String(s.phase)), 1_500_000);
    console.log(`  実行 ${(Date.now() - t0) / 1000} 秒・同意の窓 ${r.n} 回`);
    const st = (await viewer.evaluate(() => (window as unknown as { __brainAtrophyState: Record<string, unknown> }).__brainAtrophyState)) as {
      phase: string; error?: string; stderr?: string; result?: { status: string; covariates: Record<string, unknown> }; metrics?: Record<string, number>;
    };
    fs.writeFileSync(path.join(OUT_DIR, "state.json"), JSON.stringify(st, null, 2));
    check(r.n === 2, "同意は 2 回（環境の事前チェック・画像の送信）", r.n);
    check(st.phase === "done", "最後まで走り、QC を通って数値が出る", { phase: st.phase, error: st.error, stderr: st.stderr?.slice(-400) });
    if (st.phase !== "done") return;

    console.log("\n[D] 画面に出ている値");
    await viewer.getByTestId("ba-metrics").waitFor({ state: "visible", timeout: 10_000 });
    const shown = (await viewer.getByTestId("ba-metrics").textContent()) ?? "";
    const used = (await viewer.getByTestId("ba-used").textContent()) ?? "";
    console.log(`  ${shown}\n  ${used}`);
    const m = st.metrics!;
    check(shown.includes((m.frac_z_gt2 * 100).toFixed(2)) && shown.includes(String(Math.round(m.gm_ml))), "画面の指標が結果ファイルの値と一致する", { shown, m });
    check(used.includes(`${Number(age)} 歳`) && used.includes(`${field} T`), "『解析に使った値』に入力が再掲される", used);
    const frame = viewer.getByTestId("ba-report");
    await frame.scrollIntoViewIfNeeded();
    const srcLen = await frame.evaluate((e) => (e as HTMLIFrameElement).srcdoc.length);
    check(srcLen > 50_000, "レポート HTML が iframe に入っている（自己完結の大きさ）", srcLen);
    await viewer.screenshot({ path: path.join(OUT_DIR, "d-result.png"), fullPage: false });

    console.log("\n[E] 監査");
    const events = fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { event: string; endpointKind?: string; host?: string; outcome?: string });
    const reqs = events.filter((e) => e.event === "egress-requested");
    check(reqs.length === 2 && reqs.every((e) => e.endpointKind === "local" && /^127\.0\.0\.1/.test(e.host ?? "")), "監査: 送信要求 2 件とも local・127.0.0.1", reqs);
    check(events.filter((e) => e.event === "compute-finished").every((e) => e.outcome === "ok"), "監査: 終了はすべて ok");
    const auditText = fs.readFileSync(AUDIT, "utf8");
    check(!auditText.includes("SPIKE-IXI-0001"), "🔴 監査に患者 ID が無い");

    const expectPath = process.env.BA_EXPECT;
    if (expectPath) {
      console.log("\n[F] CLI の直接実行との突き合わせ");
      const exp = JSON.parse(fs.readFileSync(expectPath, "utf8")) as Record<string, number>;
      const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-9);
      console.log(`  アプリ: ${JSON.stringify(m)}\n  直接  : ${JSON.stringify(exp)}`);
      check(Math.abs(m.frac_z_gt2 - exp.frac_z_gt2) < 0.01, "Z>2 割合が直接実行と 1 ポイント以内", { app: m.frac_z_gt2, direct: exp.frac_z_gt2 });
      check(rel(m.gm_ml, exp.gm_ml) < 0.02, "GM 体積が直接実行と 2% 以内", { app: m.gm_ml, direct: exp.gm_ml });
      check(Math.abs(m.mean_z - exp.mean_z) < 0.05, "Z 平均が直接実行と 0.05 以内", { app: m.mean_z, direct: exp.mean_z });
    }
  } finally {
    await driver.stop();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    if (summary() > 0) process.exitCode = 1;
  });
