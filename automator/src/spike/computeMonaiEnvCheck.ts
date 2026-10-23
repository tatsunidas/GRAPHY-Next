/*
 * MONAI Bundle プラグイン（tatsunidas/graphy-next-plugin-monai）の依存の事前チェックの実機検証（この PC の計算機）。
 *
 * 実行:  cd automator && GRAPHY_MONAI_PYBIN=<jupyter_server・ipykernel・numpy だけの venv の bin> \
 *          GRAPHY_MONAI_FULLBIN=<torch・monai・pytorch-ignite・nibabel の入った venv の bin> \
 *          GRAPHY_AUTOMATOR_HTTP_PORT=18890 GRAPHY_AUTOMATOR_SCP_PORT=18891 GRAPHY_AUTOMATOR_VITE_PORT=18893 \
 *          npx tsx src/spike/computeMonaiEnvCheck.ts
 *   torch などが無い環境で、事前チェックが不足を出す → 入れた（.pth で別の venv の site-packages を見せる）あと、
 *   本体を再起動せず［再確認］で通り、本処理の同意画面まで進む。本処理（推論）は走らせない（Colab の検証が別にある）。
 *   起動前に frontend/node_modules/.vite を消すこと。Linux 専用。
 */
import fs from "node:fs";
import path from "node:path";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { installOfficialPlugin, openViewer, state } from "./computeMonaiShared.js";
import { consentWindow, createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-monai-env-check");
const AUDIT = path.join(DESKTOP_RUN_DATA_DIR, "compute-audit.jsonl");
const { check, summary } = createChecker();

const sites = (bin: string): string[] => {
  const lib = path.join(bin, "..", "lib");
  return fs.readdirSync(lib).filter((d) => d.startsWith("python")).map((d) => path.join(lib, d, "site-packages"));
};

async function main(): Promise<void> {
  const bin = process.env.GRAPHY_MONAI_PYBIN;
  const full = process.env.GRAPHY_MONAI_FULLBIN;
  if (!bin || !fs.existsSync(path.join(bin, "python"))) throw new Error("GRAPHY_MONAI_PYBIN に venv の bin を指定してください");
  if (!full || !fs.existsSync(path.join(full, "python"))) throw new Error("GRAPHY_MONAI_FULLBIN に venv の bin を指定してください");
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installOfficialPlugin();
  fs.rmSync(AUDIT, { force: true });

  const driver = new DesktopDriver();
  // 🔴 既定の計算機を書き換えるので、終わったら元のファイルへ戻す（残すと、あとで走る別の検証が Colab でなくこの PC へ送られる）
  let endpointsFile: string | null = null;
  let endpointsBackup: string | null = null;
  try {
    await driver.start();
    const page = driver.page;
    const cwd = await driver.app.evaluate(() => process.cwd());
    endpointsFile = path.join(cwd, "compute-endpoints.json");
    endpointsBackup = fs.existsSync(endpointsFile) ? fs.readFileSync(endpointsFile, "utf8") : null;
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 }).catch(async (e) => {
      await page.screenshot({ path: path.join(OUT_DIR, "fail-start.png") });
      throw e;
    });
    await driver.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
    });
    // MONAI の runJob は endpointId を指定しない（既定の計算機）。この検証では既定を「この PC」にする
    const set = await page.evaluate(() => (window as unknown as { graphyDesktop: { computeDefaultSet: (id: string) => Promise<{ ok: boolean }> } }).graphyDesktop.computeDefaultSet("local"));
    check(set.ok === true, "既定の計算機を「この PC」にした", set);

    const base = `http://localhost:${driver.ports.http}`;
    const study = ((await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[])[0];
    const series = (await (await fetch(`${base}/api/studies/${study.studyInstanceUid}/series`)).json()) as {
      seriesInstanceUid: string; modality: string; numberOfInstances: number; seriesDescription?: string;
    }[];
    const cts = series.filter((s) => s.modality === "CT");
    const ct = cts.find((s) => /LIVER/i.test(s.seriesDescription ?? "")) ?? cts.sort((a, b) => b.numberOfInstances - a.numberOfInstances)[0];
    check(!!ct, "実物の CT が取り込まれている（操作が効いている前提）", series);

    console.log("\n[1] 2D ビューアでプラグインを起動 → 実行（事前チェックの同意 1 回目・画像なし）");
    await dismissStartupDialogs(page);
    await page.getByRole("button", { name: "All", exact: true }).click();
    const viewer = await openViewer(driver, page, study.studyInstanceUid, ct.seriesInstanceUid);
    await viewer.getByTestId("monai-bundle").selectOption("spleen_ct_segmentation");
    const approveProbe = async (): Promise<void> => {
      const pw = await consentWindow(driver, 120_000);
      const code = (await pw.locator("#code").textContent()) ?? "";
      check(code.includes("outputs/env.json") && !code.includes("monai.bundle"), "事前チェックの同意画面: コードは環境の確認だけ（推論・画像の読み込みをしない）");
      await pw.getByTestId("consent-ack").check();
      await pw.getByTestId("consent-send").click();
    };
    await viewer.getByTestId("monai-run").click();
    await approveProbe();
    await viewer.getByTestId("monai-env").waitFor({ state: "visible", timeout: 120_000 });
    const box = (await viewer.getByTestId("monai-env").textContent()) ?? "";
    const cmd = await viewer.getByTestId("monai-env-command").inputValue();
    await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-env-panel.png") });
    const st0 = await state(viewer);
    check(st0.phase === "idle" && !st0.summary, "不足のとき本処理は出ない（結果も無い）", st0.phase);
    check(String(st0.env?.python).startsWith(bin.replace(/\/bin$/, "")), "使われる Python が検査した venv のもの", st0.env?.python);
    check(/torch.*入っていません/.test(box) && /monai.*入っていません/.test(box) && /pytorch-ignite.*入っていません/.test(box) && /nibabel.*入っていません/.test(box) && /numpy.*✓/.test(box), "入っていないものだけが ✗、numpy は ✓", box.slice(0, 400));
    check(/-m pip install torch monai pytorch-ignite nibabel$/.test(cmd), "導入コマンドに不足が揃っている（numpy は入っているので含まない）", cmd);
    console.log(`  導入コマンド: ${cmd}`);

    console.log("\n[2] 導入したことにして（本体は再起動しない）［再確認］");
    fs.writeFileSync(path.join(sites(bin)[0], "zz-installed.pth"), [...sites(full), ...(process.env.GRAPHY_MONAI_EXTRA_SITES ?? "").split(path.delimiter).filter(Boolean)].join("\n") + "\n");
    await viewer.getByTestId("monai-env-recheck").click();
    await approveProbe();
    await viewer.waitForFunction(
      () => /環境は整いました/.test(document.querySelector('[data-testid="monai-status"]')?.textContent ?? ""),
      null,
      { timeout: 120_000 },
    );
    check(!(await viewer.getByTestId("monai-env").isVisible()), "再確認で枠が消える（本体の再起動なし）");
    const st1 = await state(viewer);
    check(st1.env?.problem == null && st1.env?.colab === false, "事前チェックの結果: problem なし・Colab ではない", st1.env);
    await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-env-fixed.png") });

    console.log("\n[3] 実行 → 本処理の同意画面（画像あり）まで進む。ここで取り消す");
    await viewer.getByTestId("monai-run").click();
    const win = await consentWindow(driver, 120_000);
    const code = (await win.locator("#code").textContent()) ?? "";
    check(code.includes("monai.bundle") || code.includes("ConfigParser"), "本処理の同意画面: 推論のコードが見える（事前チェックを通って本処理に進んだ）");
    await win.screenshot({ path: path.join(OUT_DIR, "consent-main.png") });
    await win.getByTestId("consent-cancel").click();
    await viewer.waitForFunction(() => (window as unknown as { __monaiState?: { phase: string } }).__monaiState?.phase === "idle", null, { timeout: 60_000 });

    const events = fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const req = events.filter((e: { event: string; endpointKind?: string }) => e.event === "egress-requested");
    check(req.length === 3 && req.every((e: { endpointKind?: string }) => e.endpointKind === "local"), "監査: 要求は 3 件（事前チェック 2・本処理 1）で、すべて local", req.map((e: { endpointKind?: string }) => e.endpointKind));
  } finally {
    await driver.stop();
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
