/*
 * 胸部X線レポートの下書きプラグイン（tatsunidas/graphy-next-plugin-cxr-report）の実機検証。
 * 設計: fw/remote-compute-design.md §3.2・§22。
 *
 * 実行:  cd automator && GRAPHY_CXR_PYBIN=<torch・torchvision・transformers==4.46.3・jupyter_server・ipykernel の入った venv の bin> \
 *          GRAPHY_AUTOMATOR_HTTP_PORT=18890 GRAPHY_AUTOMATOR_SCP_PORT=18891 GRAPHY_AUTOMATOR_VITE_PORT=18893 \
 *          npx tsx src/spike/computeCxrReportCheck.ts [ok|bad-version|missing-deps]
 *   ok           : 版が揃った環境で、事前チェックを通り、本物の DX 1 枚から所見と印象が出る（正例）
 *   bad-version  : transformers が別の版の環境では、事前チェックが理由と導入コマンドを出して止まり、本処理は出ない（負例）
 *   missing-deps : torch などが無い環境で、事前チェックが不足を出す → 入れた（.pth で完全な venv の site-packages を見せる）あと
 *                  本体を再起動せずに［再確認］で通り、実行できる。GRAPHY_CXR_FULLBIN に完全な venv の bin を指定する
 *   起動前に frontend/node_modules/.vite を消すこと。Linux 専用。重みは Hugging Face のキャッシュに既にあること
 *   （初回の取得は検証しない）。
 */
import fs from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { approvedSha, consentWindow, createChecker, openAnalysisPlugin } from "./computeSpikeShared.js";

const MODE = process.argv[2] ?? "ok";
const PLUGIN_ID = "vis-cxr-report";
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", `compute-cxr-report-check-${MODE}`);
const AUDIT = path.join(DESKTOP_RUN_DATA_DIR, "compute-audit.jsonl");
const { check, summary } = createChecker();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const state = (viewer: Page): Promise<any> => viewer.evaluate(() => (window as unknown as { __cxrReportState?: unknown }).__cxrReportState ?? null);

/** 公式プラグインの作業コピーを検証用の置き場へ入れる（engines.graphy は開発版でも読めるよう、写すときだけ外す）。 */
function installPlugin(): void {
  const src = process.env.GRAPHY_CXR_PLUGIN_DIR ?? path.join(AUTOMATOR_ROOT, "..", "..", "graphy-next-plugin-cxr-report");
  if (!fs.existsSync(path.join(src, "ui.js"))) throw new Error(`プラグインの作業コピーがありません: ${src}`);
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(src, "plugin.json"), "utf8"));
  manifest.engines = { ...manifest.engines, graphy: ">=0.0.0" };
  fs.writeFileSync(path.join(dst, "plugin.json"), JSON.stringify(manifest, null, 2));
  fs.copyFileSync(path.join(src, "ui.js"), path.join(dst, "ui.js"));
}

async function main(): Promise<void> {
  const bin = process.env.GRAPHY_CXR_PYBIN;
  if (!bin || !fs.existsSync(path.join(bin, "python"))) throw new Error("GRAPHY_CXR_PYBIN に venv の bin を指定してください");
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installPlugin();
  fs.rmSync(AUDIT, { force: true });

  const driver = new DesktopDriver();
  try {
    await driver.start();
    const page = driver.page;
    page.on("console", (m) => {
      if (m.type() === "error" && !/404|Failed to load resource/.test(m.text())) console.log(`  [renderer error] ${m.text().slice(0, 200)}`);
    });
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "cxr-dx");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 }).catch(async (e) => {
      await page.screenshot({ path: path.join(OUT_DIR, "fail-start.png") });
      throw e;
    });
    await driver.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
    });

    const base = `http://localhost:${driver.ports.http}`;
    const study = ((await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[])[0];
    const series = (await (await fetch(`${base}/api/studies/${study.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string; modality: string }[];
    const dx = series.find((s) => s.modality === "DX");
    check(!!dx, "実物の DX が取り込まれている（操作が効いている前提）", series);
    if (!dx) throw new Error("DX がありません");

    console.log("\n[1] 2D ビューアで DX を開き、プラグインを起動");
    await dismissStartupDialogs(page);
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await page.getByRole("button", { name: "All", exact: true }).click();
    await page.getByTestId("search-submit-button").click();
    await page.waitForTimeout(2_000);
    await page.screenshot({ path: path.join(OUT_DIR, "search.png") });
    await page.locator(`[data-testid="study-row-${study.studyInstanceUid}"]`).click();
    await page.locator(`[data-testid="series-row-${dx.seriesInstanceUid}"]`).click();
    const viewer = await driver.waitForNewPage(
      () => page.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(3_000);
    await openAnalysisPlugin(viewer, PLUGIN_ID);
    await viewer.getByTestId("cxr-run").waitFor({ state: "visible", timeout: 10_000 });
    const disclaimer = (await viewer.getByTestId("cxr-disclaimer").textContent()) ?? "";
    check(/診断.*使わない/.test(disclaimer), "免責が実行前から出ている", disclaimer);

    // 画像を送らない事前チェック（コードだけのジョブ）の同意を済ませる
    const approveProbe = async (): Promise<void> => {
      const pw = await consentWindow(driver, 120_000);
      const pcode = (await pw.locator("#code").textContent()) ?? "";
      check(pcode.includes("stage('probe'") && !pcode.includes("load_image('inputs/0.npz')"), "事前チェックの同意画面: コードは環境の確認だけ（画像を読まない）");
      await pw.getByTestId("consent-ack").check();
      await pw.getByTestId("consent-send").click();
    };

    console.log("\n[2] 実行: 事前チェック（同意 1 回目・画像なし）");
    await viewer.getByTestId("cxr-run").click();
    await approveProbe();
    if (MODE !== "ok") {
      await viewer.getByTestId("cxr-env").waitFor({ state: "visible", timeout: 120_000 });
      const box = (await viewer.getByTestId("cxr-env").textContent()) ?? "";
      const cmd = await viewer.getByTestId("cxr-env-command").inputValue();
      await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-env-panel.png") });
      const st0 = await state(viewer);
      check(st0.phase === "idle" && !(await viewer.getByTestId("cxr-result").isVisible()), "不足のとき本処理は出ない（結果の欄も出ない）", st0.phase);
      check(st0.env?.python?.startsWith(bin.replace(/\/bin$/, "")), "使われる Python が検査した venv のもの", st0.env?.python);
      if (MODE === "bad-version") {
        check(/transformers.*4\.57/.test(box) && /4\.46\.3/.test(box), "入っている版と必要な版が枠に出る", box.slice(0, 300));
        check(new RegExp(`-m pip install transformers==4\\.46\\.3$`).test(cmd), "導入コマンドは transformers==4.46.3 だけ", cmd);
        console.log(`  導入コマンド: ${cmd}`);
      } else {
        check(/torch.*入っていません/.test(box) && /transformers.*入っていません/.test(box), "入っていないものが枠に出る", box.slice(0, 300));
        check(/-m pip install torch torchvision transformers==4\.46\.3/.test(cmd), "導入コマンドに不足が揃っている", cmd);
        console.log(`  導入コマンド: ${cmd}`);
        const full = process.env.GRAPHY_CXR_FULLBIN;
        if (!full) throw new Error("missing-deps には GRAPHY_CXR_FULLBIN が要る");
        const sites = (dir: string) => fs.readdirSync(path.join(dir, "..", "lib")).filter((d) => d.startsWith("python")).map((d) => path.join(dir, "..", "lib", d, "site-packages"));
        fs.writeFileSync(path.join(sites(bin)[0], "zz-installed.pth"), sites(full)[0] + "\n");
        console.log("\n[2b] 導入したことにして（本体は再起動しない）［再確認］");
        await viewer.getByTestId("cxr-env-recheck").click();
        await approveProbe();
        await viewer.waitForFunction(
          () => /環境は整いました/.test(document.querySelector('[data-testid="cxr-status"]')?.textContent ?? ""),
          null,
          { timeout: 120_000 },
        );
        check(!(await viewer.getByTestId("cxr-env").isVisible()), "再確認で枠が消える（本体の再起動なし）");
        await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-env-fixed.png") });
        await viewer.getByTestId("cxr-run").click();
      }
    }
    if (MODE === "bad-version") {
      const events0 = fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      check(events0.filter((e: { event: string }) => e.event === "egress-requested").length === 1, "監査: 送信の要求は事前チェックの 1 件だけ（画像は出ていない）");
      if (summary() > 0) process.exitCode = 1;
      return;
    }

    console.log("\n[2c] 本処理（同意 2 回目・画像あり）");
    if (MODE === "ok") await viewer.getByTestId("cxr-run").waitFor({ state: "visible" });
    const win = await consentWindow(driver, 120_000);
    const note = (await win.getByTestId("consent-note").textContent()) ?? "";
    const code = (await win.locator("#code").textContent()) ?? "";
    check(/焼き込み|burned into/.test(note), "同意画面に『焼き込みは塗らない』の注意が出る", note);
    check(code.includes("84dfcba8125c9b9296bfc1ee317749788b6b59b4") && code.includes("trust_remote_code=True"), "同意画面のコードに固定 revision が見える");
    const sha = await approvedSha(win);
    await win.screenshot({ path: path.join(OUT_DIR, "consent.png") });
    await win.getByTestId("consent-ack").check();
    await win.getByTestId("consent-send").click();

    await viewer.waitForFunction(
      () => ["done", "failed"].includes((window as unknown as { __cxrReportState?: { phase: string } }).__cxrReportState?.phase ?? ""),
      null,
      { timeout: 900_000 },
    );
    const st = await state(viewer);
    fs.writeFileSync(path.join(OUT_DIR, "state.json"), JSON.stringify(st, null, 2));
    await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-result.png") });

    console.log("\n[3] 結果");
    {
      check(st.phase === "done", "最後まで走る", { phase: st.phase, error: st.error, status: st.status });
      const rep = st.report ?? {};
      check(typeof rep.findings === "string" && rep.findings.length > 20 && typeof rep.impression === "string" && rep.impression.length > 10, "所見と印象の文が返る", rep);
      check(rep.revision === "84dfcba8125c9b9296bfc1ee317749788b6b59b4" && rep.transformers === "4.46.3" && rep.rows === 1024 && rep.cols === 1024, "固定 revision・版・1024×1024 の実画素で走った", rep);
      const shown = await viewer.getByTestId("cxr-findings").inputValue();
      check(shown === rep.findings, "画面の所見が返った文と一致する", shown.slice(0, 80));
      check(((await viewer.getByTestId("cxr-disclaimer").textContent()) ?? "").includes("診断"), "結果が出た後も免責が残る");

      console.log("\n[4] Grad-CAM");
      check(!rep.camError && rep.cam?.shape?.length === 2 && rep.cam.sentences.length >= 3, "Grad-CAM が返る（文ごとの特徴マップ）", { error: rep.camError, shape: rep.cam?.shape });
      check(rep.cam?.gap < 0.01, "再計算した確率が生成時の確率と一致している（差 0.01 未満）", rep.cam?.gap);
      check(rep.cam?.sentences.every((x: { strength: number }) => x.strength >= 0 && x.strength <= 1) && rep.cam.sentences.some((x: { strength: number }) => x.strength === 1), "強さは 0〜1 で、最大の文が 1", rep.cam?.sentences.map((x: { strength: number }) => x.strength));
      const best = rep.cam.sentences.findIndex((x: { strength: number }) => x.strength === 1);
      await viewer.getByTestId(`cxr-cam-sentence-${best}`).click();
      await viewer.waitForTimeout(1_000);
      const st2 = await state(viewer);
      check(st2.cam?.shown === best && !st2.cam?.error, "文を押すと本体が重ねを受け付ける", st2.cam);
      await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-cam-on.png") });
      await viewer.getByTestId("cxr-cam-clear").click();
      await viewer.waitForTimeout(500);
      check((await state(viewer)).cam?.shown === null, "「消す」で重ねが外れる");
      await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-cam-off.png") });
    }
    const events = fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const req = events.find((e: { event: string }) => e.event === "egress-requested");
    check(req?.endpointKind === "local", "監査: endpointKind=local", req);
    check(sha.length === 64, "同意画面に SHA-256 が出ている", sha);
  } finally {
    await driver.stop();
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
