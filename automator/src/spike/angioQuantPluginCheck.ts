/*
 * アンギオ計測プラグイン（`graphy-next-plugin-angio-quant`）の実機検証スパイク。
 *
 * 実行:  cd automator && npx tsx src/spike/angioQuantPluginCheck.ts
 *
 * 何を確かめるか — **移行の正しさそのもの**:
 *   🔴 **同じ画像・同じ計測線に対して、本体の QCA とプラグインの QCA が同じ数値を出す**。
 *      計算コアは本体からの写し（`tools/syncCore.mjs` で同期）なので、ここがずれたら
 *      「どちらが正しいか」を言えなくなる——移行の前提が崩れる。
 *   2. プラグインが**画面に出している値**をそのまま読む（出力ファイルだけを見る検査では
 *      「画面と数値が食い違う」類いを 1 件も掴めない＝`fw/angio-design.md` §21 の教訓）。
 *   3. 保存（H37 SR）まで通り、保管庫に `[Plugin] ` 付きで実在する。
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）、
 *       fixture xa-angio、**プラグインのビルド**
 *       （`cd ../graphy-next-plugin-angio-quant && npm run build`）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const PLUGIN_ID = "angio-quant";
/** プラグインのリポジトリ（このリポジトリの隣に clone されている前提）。 */
const PLUGIN_REPO = path.resolve(AUTOMATOR_ROOT, "..", "..", "graphy-next-plugin-angio-quant");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "angio-quant-plugin");

interface QcaSnapshot {
  mld: number;
  rvd: number;
  percentDiameterStenosis: number;
  percentAreaStenosis: number;
  lesionLength: number;
  points: number;
  unit: string;
  diameterMethod: string;
}

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

/** ビルド済みのプラグイン（plugin.json ＋ ui.js）を backend の plugins へ置く。 */
function installPlugin(): void {
  const ui = path.join(PLUGIN_REPO, "ui.js");
  if (!fs.existsSync(ui)) {
    throw new Error(`ui.js がありません。先に \`cd ${PLUGIN_REPO} && npm run build\` を実行してください`);
  }
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const name of ["plugin.json", "ui.js"]) {
    fs.copyFileSync(path.join(PLUGIN_REPO, name), path.join(dst, name));
  }
  const version = JSON.parse(fs.readFileSync(path.join(PLUGIN_REPO, "plugin.json"), "utf8")).version as string;
  console.log(`プラグインを配置: ${dst}（版 ${version}）`);
}

/** 「1.47 px」のような表示から数値だけ取り出す。 */
function num(text: string | null): number {
  return Number((text ?? "").replace(/[^0-9.+-]/g, ""));
}

async function selectLengthTool(page: Page): Promise<void> {
  // すでに選択済みだと名前が「✓ 長さ」になる（angioHostApiCheck と同じ注意）。
  const item = page.getByRole("button", { name: /^(✓\s*)?(長さ|Length)$/ });
  await page.keyboard.press("Escape").catch(() => undefined);
  for (let i = 0; i < 3; i++) {
    await page.getByTestId("viewer2d-menu-roi").click();
    try {
      await item.first().waitFor({ state: "visible", timeout: 2000 });
      await item.first().click();
      await page.waitForTimeout(300);
      return;
    } catch {
      await page.keyboard.press("Escape").catch(() => undefined);
    }
  }
  throw new Error("ROI メニューの「長さ」を選べませんでした");
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installPlugin();
  const driver = new DesktopDriver();
  const recorder = createStepRecorder();
  await driver.start();
  let viewerPage: Page | null = null;
  try {
    await resetDb(driver.ports.http);
    console.log(`fixture import: ${JSON.stringify(await importFixtureCategory(driver.ports.http, "xa-angio"))}`);

    const mainPage = driver.page;
    try {
      await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    } catch {
      await mainPage.reload({ waitUntil: "domcontentloaded" });
      await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    }
    await openFirstSeriesInViewer(mainPage, recorder);
    viewerPage = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewerPage.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 15_000 });
    await viewerPage.waitForTimeout(2500);
    viewerPage.on("console", (m) => {
      if (m.type() === "error") console.log(`  [viewer error] ${m.text()}`);
    });

    // 解析区間（近位の健常部 → 遠位の健常部）に見立てた 1 本。**本体とプラグインで同じ線を使う。**
    await selectLengthTool(viewerPage);
    await dragOnCanvasHost(viewerPage, "viewer2d-canvas-host", 120, 60, 0, 10, { fracX: 0.32, fracY: 0.34 });
    await viewerPage.waitForTimeout(800);
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "0-length.png") });

    // --- [1] 本体の QCA ---
    console.log("\n[1] 本体の QCA（校正 / QCA ダイアログ）");
    await viewerPage.getByTestId("xa-analysis-open").click();
    await viewerPage.getByTestId("xa-analysis-dialog").waitFor({ state: "visible", timeout: 10_000 });
    await viewerPage.getByTestId("xa-qca-run").click();
    await viewerPage.waitForFunction(
      () => {
        const d = (window as unknown as { __graphyDebug?: { getQcaState?: () => unknown } }).__graphyDebug;
        return !!d?.getQcaState?.();
      },
      undefined,
      { timeout: 60_000 },
    );
    const host = (await viewerPage.evaluate(() => {
      const d = (window as unknown as { __graphyDebug: { getQcaState: () => QcaSnapshot | null } }).__graphyDebug;
      return d.getQcaState();
    })) as QcaSnapshot | null;
    console.log(JSON.stringify(host, null, 2));
    check(!!host, "本体の QCA が結果を出す", host);
    check((host?.points ?? 0) > 0, "計測点がある", host?.points);
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "1-host-qca.png") });
    await viewerPage.getByTestId("xa-dialog-close").click();
    await viewerPage.waitForTimeout(500);

    // --- [2] プラグインの QCA（同じ計測線） ---
    console.log("\n[2] プラグインの QCA（同じ計測線）");
    await viewerPage.keyboard.press("Escape").catch(() => undefined);
    await viewerPage.getByTestId("viewer2d-menu-plugins").click();
    await viewerPage.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
    await viewerPage.getByTestId("angio-quant-panel").waitFor({ state: "visible", timeout: 20_000 });
    check(true, "プラグインが専用ウィンドウを開く（H30）");
    await viewerPage.getByTestId("angio-quant-run").click();
    await viewerPage.getByTestId("aq-mld").waitFor({ state: "visible", timeout: 60_000 });
    const shown = {
      mld: num(await viewerPage.getByTestId("aq-mld").textContent()),
      rvd: num(await viewerPage.getByTestId("aq-rvd").textContent()),
      pds: num(await viewerPage.getByTestId("aq-pds").textContent()),
      pas: num(await viewerPage.getByTestId("aq-pas").textContent()),
      lesion: num(await viewerPage.getByTestId("aq-lesion").textContent()),
      points: num(await viewerPage.getByTestId("aq-points").textContent()),
      unitText: (await viewerPage.getByTestId("aq-mld").textContent()) ?? "",
    };
    console.log(JSON.stringify(shown, null, 2));
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "2-plugin-qca.png") });

    // --- [3] 一致するか（移行の正しさ） ---
    console.log("\n[3] 本体 と プラグイン の一致");
    // 画面は 2 桁（%DS は 1 桁）に丸めて出しているので、本体の値も同じ丸めで比べる。
    const r2 = (v: number): number => Number(v.toFixed(2));
    const r1 = (v: number): number => Number(v.toFixed(1));
    check(shown.points === host?.points, "🔴 計測点数が一致", { host: host?.points, plugin: shown.points });
    check(shown.mld === r2(host?.mld ?? NaN), "🔴 MLD が一致", { host: r2(host?.mld ?? NaN), plugin: shown.mld });
    check(shown.rvd === r2(host?.rvd ?? NaN), "🔴 RVD が一致", { host: r2(host?.rvd ?? NaN), plugin: shown.rvd });
    check(
      shown.pds === r1(host?.percentDiameterStenosis ?? NaN),
      "🔴 直径狭窄率が一致",
      { host: r1(host?.percentDiameterStenosis ?? NaN), plugin: shown.pds },
    );
    check(
      shown.pas === r1(host?.percentAreaStenosis ?? NaN),
      "🔴 面積狭窄率が一致",
      { host: r1(host?.percentAreaStenosis ?? NaN), plugin: shown.pas },
    );
    check(
      shown.lesion === r2(host?.lesionLength ?? NaN),
      "🔴 病変長が一致",
      { host: r2(host?.lesionLength ?? NaN), plugin: shown.lesion },
    );
    check(
      shown.unitText.includes(host?.unit ?? "?"),
      "単位の表示が一致（未校正なら px のまま）",
      { host: host?.unit, plugin: shown.unitText },
    );
    const methodText = (await viewerPage.getByTestId("angio-quant-panel").textContent()) ?? "";
    check(
      (host?.diameterMethod === "densitometric" && methodText.includes("密度計測")) ||
        (host?.diameterMethod === "half-max" && methodText.includes("半値法")),
      "径の測り方の注記が本体と同じ",
      { host: host?.diameterMethod, plugin: methodText.slice(0, 60) },
    );
    // 未校正なので「px です」と出ているはず（mm を騙らない）。
    if (host?.unit === "px") {
      check(methodText.includes("未校正"), "未校正であることを画面に出す", methodText.slice(0, 200));
    }

    // --- [4] 保存（H37）が通り、保管庫に実在する ---
    console.log("\n[4] プラグインからの SR 保存（H37）");
    const srButton = viewerPage.getByRole("button", { name: "計測値を保存 (SR)" });
    check((await srButton.count()) > 0, "H37 がある本体では保存ボタンが出る");
    if (await srButton.count()) {
      await srButton.first().click();
      await viewerPage.getByTestId("plugin-save-confirm").waitFor({ state: "visible", timeout: 20_000 });
      const dlg = (await viewerPage.getByTestId("plugin-save-confirm").textContent())?.replace(/\s+/g, " ") ?? "";
      check(dlg.includes("Angio Quant"), "ダイアログにプラグイン名が出る", dlg.slice(0, 100));
      await viewerPage.getByTestId("plugin-save-confirm-button").click();
      await viewerPage.waitForTimeout(2500);
      const panelText = (await viewerPage.getByTestId("angio-quant-panel").textContent()) ?? "";
      check(panelText.includes("保存しました"), "保存できたことを画面に出す", panelText.slice(-120));

      const studies = (await (await fetch(`http://localhost:${driver.ports.http}/api/studies?limit=50`)).json()) as Array<{
        studyInstanceUid: string;
      }>;
      let found: { seriesDescription?: string; modality?: string } | undefined;
      for (const st of studies) {
        const series = (await (
          await fetch(`http://localhost:${driver.ports.http}/api/studies/${encodeURIComponent(st.studyInstanceUid)}/series`)
        ).json()) as Array<{ seriesDescription?: string; modality?: string }>;
        found = series.find((x) => (x.seriesDescription ?? "").startsWith("[Plugin] "));
        if (found) break;
      }
      check(!!found, "保管庫に [Plugin] 付きのシリーズが実在する", found);
      check(found?.modality === "SR", "モダリティが SR", found?.modality);
    }
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "3-saved.png") });
  } finally {
    if (viewerPage) {
      try {
        await viewerPage.screenshot({ path: path.join(OUT_DIR, "9-last.png") });
      } catch {
        /* ignore */
      }
    }
    await driver.stop();
  }

  console.log(`\n===== 合格 ${passed} / 不合格 ${failures.length} =====`);
  for (const f of failures) console.log(`  - ${f}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
