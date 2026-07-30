/*
 * Lesion Evanesco（RECIST 1.1 プラグイン）の**病変選択規則**の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/recistEligibilityCheck.ts
 *
 * <p><b>何を確かめるか</b>: 規則そのものはプラグイン側の vitest（`test/eligibility.test.ts`）で
 * 固定してあるので、ここで見るのは**配線**である。単体テストでは絶対に捕まらない失敗:
 *
 *   1. スライス厚が実機で本当に取れる（取れないと規則が「厚さ不明」で毎回スキップされる。
 *      静かに規則が消えるので、通っているように見えてしまう）
 *   2. 警告が**画面に出る**（`le-eligibility` の箱と、タイムポイント行の ⚠）
 *   3. 警告が出ても**判定は止まらない**（SLD が出続ける）
 *
 * <p><b>合否の立て方</b>: 「何 canvas px 引けば 10mm 未満になるか」を当てにいくと、外れたときに
 * 静かに空振りする（警告が出ないのが正しいのか、配線が切れているのか区別できない）。そこで
 * **本体が測った長径と警告の有無の整合**を見る: 長径 < 10mm ⇔ too-small-target が出る。
 * これはスケールの読みに依存せず、かつ規則の意味そのものである。
 *
 * <p>前提: backend jar と、プラグイン側で `npm run build` 済みの ui.js、`npm run phantom` 済み。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const PLUGIN_REPO = path.join(os.homedir(), "graphy-workspace", "graphy-next-plugin-lesion-evanesco");
const PLUGIN_ID = "lesion-evanesco";
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "recist-eligibility-check");
const PATIENT = "RECIST-PR";
/**
 * **ベースラインの回だけを取り込む。** 最小サイズ規則はベースラインにしか効かないので、
 * 開いている回がベースラインでなければ規則は live の計測に当たらない
 * （どのスタディが開くかは検索結果の順序に依存する＝当てにしてはいけない）。
 */
const BASELINE_FILE = "TP0_20260105.dcm";
/** 最小サイズ規則の閾値（スライス厚 ≤5mm のとき）。ファントムは厚 1mm。 */
const MIN_MEASURABLE_MM = 10;

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

function installPlugin(): void {
  const uiJs = path.join(PLUGIN_REPO, "ui.js");
  if (!fs.existsSync(uiJs)) {
    throw new Error(`${uiJs} がありません。先に (cd ${PLUGIN_REPO} && npm run build) を実行してください。`);
  }
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(PLUGIN_REPO, "plugin.json"), path.join(dst, "plugin.json"));
  fs.copyFileSync(uiJs, path.join(dst, "ui.js"));
  console.log(`プラグインを配置: ${dst}`);
}

async function importPhantom(httpPort: number): Promise<void> {
  const file = path.join(PLUGIN_REPO, "phantom", PATIENT, BASELINE_FILE);
  if (!fs.existsSync(file)) {
    throw new Error(`${file} がありません。(cd ${PLUGIN_REPO} && npm run phantom) を実行してください。`);
  }
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/import/paths`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths: [file] }),
  });
  if (!res.ok) throw new Error(`import failed: ${res.status}`);
  console.log(`  import: ${JSON.stringify(await res.json())}`);
}

/**
 * タイムポイント名の照合用。**⚠ 印はラベルのセルの中にある**ので、素の等値比較だと
 * 警告が出ている行が一致しない（この検証で実際に 3 項目を誤って落とした）。
 */
function labelIs(row: { label: string }, name: string): boolean {
  return row.label.replace("⚠", "").trim() === name;
}

/** プラグインの状態（規則の警告を含む）を DOM から読む。**関数参照ではなく文字列で評価させる**。 */
async function readPanel(viewer: Page): Promise<{
  rows: { label: string; date: string; sld: string; response: string; source: string; warned: boolean }[];
  /** 規則違反の箱（無ければ null）。 */
  eligibility: { kinds: string[]; messages: string[] } | null;
  /** 病変表のサイズ列（mm。本体が測った値）。 */
  lesionSizes: string[];
}> {
  return viewer.evaluate(`
    (function () {
      var rows = [];
      var tbody = document.querySelector('[data-testid="le-timeline"] tbody');
      if (tbody) {
        var trs = tbody.querySelectorAll("tr");
        for (var i = 0; i < trs.length; i++) {
          var tds = trs[i].querySelectorAll("td");
          var c = [];
          for (var j = 0; j < tds.length; j++) c.push((tds[j].textContent || "").trim());
          var id = (trs[i].getAttribute("data-testid") || "").replace("le-tp-", "");
          rows.push({
            label: c[0] || "",
            date: c[1] || "",
            sld: c[2] || "",
            response: c[5] || "",
            source: c[6] || "",
            warned: !!document.querySelector('[data-testid="le-tp-warn-' + id + '"]'),
          });
        }
      }
      var box = document.querySelector('[data-testid="le-eligibility"]');
      var eligibility = null;
      if (box) {
        var kinds = [];
        var messages = [];
        var kids = box.querySelectorAll("[data-testid]");
        for (var k = 0; k < kids.length; k++) {
          var t = kids[k].getAttribute("data-testid") || "";
          if (t.indexOf("le-eligibility-") === 0) {
            kinds.push(t.replace("le-eligibility-", ""));
            messages.push(kids[k].textContent || "");
          }
        }
        eligibility = { kinds: kinds, messages: messages };
      }
      var sizes = [];
      var lesionRows = document.querySelectorAll('[data-testid^="le-lesion-"]');
      for (var m = 0; m < lesionRows.length; m++) {
        var tds2 = lesionRows[m].querySelectorAll("td");
        if (tds2.length >= 7) sizes.push((tds2[6].textContent || "").trim());
      }
      return { rows: rows, eligibility: eligibility, lesionSizes: sizes };
    })()
  `) as never;
}

/**
 * プラグインの端末ローカル状態（評価記録・サムネイル）を消す。
 *
 * <p>**`resetDb` は backend の DB しか消さない。** プラグインの記録は localStorage にあるので
 * 前回の実行が残り、開いていない回が「記録」として混ざる（実際にこれで 1 回分の検証が
 * 無駄になった: 規則の警告が live の計測ではなく、古い記録の回に対して出ていた）。
 */
async function clearPluginStorage(viewer: Page): Promise<number> {
  return (await viewer.evaluate(`
    (function () {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf("lesion-evanesco.") === 0) keys.push(k);
      }
      for (var j = 0; j < keys.length; j++) localStorage.removeItem(keys[j]);
      return keys.length;
    })()
  `)) as number;
}

async function openPanel(viewer: Page): Promise<void> {
  await viewer.getByTestId("viewer2d-menu-plugins").click();
  await viewer.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
  await viewer.getByTestId("lesion-evanesco-panel").waitFor({ state: "visible", timeout: 15_000 });
}

async function openViewerForPatient(driver: DesktopDriver): Promise<Page> {
  const mainPage = driver.page;
  mainPage.on("console", (m) => {
    if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`);
  });
  try {
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
  } catch {
    await mainPage.reload({ waitUntil: "domcontentloaded" });
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  }
  await openFirstSeriesInViewer(mainPage, createStepRecorder());
  const viewer = await driver.waitForNewPage(
    () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
    (url) => url.includes("2dviewer"),
  );
  await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
  await viewer.waitForTimeout(2500);
  return viewer;
}

/** 長径・短径ツールで 1 本引く。 */
async function drawBidirectional(
  viewer: Page,
  longPx: number,
  shortPx: number,
  at: { fracX: number; fracY: number },
): Promise<void> {
  await viewer.getByTestId("viewer2d-menu-roi").click();
  await viewer.getByRole("button", { name: /長径・短径|Long\/short axis/ }).first().click();
  await viewer.waitForTimeout(300);
  await dragOnCanvasHost(viewer, "viewer2d-canvas-host", longPx, 0, 0, shortPx, at);
  await viewer.waitForTimeout(900);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installPlugin();

  const driver = new DesktopDriver();
  await driver.start();
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(driver.ports.http))}`);
    await importPhantom(driver.ports.http);
    const viewer = await openViewerForPatient(driver);
    console.log(`  プラグインの端末ローカル状態を消去: ${await clearPluginStorage(viewer)} キー`);

    console.log("\n[1] 小さい病変（10mm 未満を狙う）を測って、規則の警告が出るか");
    // ファントムは 1 画素 = 1.0mm。Fit 表示のスケールは画面サイズ依存なので当てにしない
    // （下で本体の実測値と突き合わせる）。
    // 前回の実測で 12 canvas px ≒ 13.0mm だった（1 画素 = 1.0mm のファントム）。
    // 10mm 未満にするため 6px にする。当てが外れた場合は下で**未検証として落とす**。
    await drawBidirectional(viewer, 6, 4, { fracX: 0.28, fracY: 0.5 });
    await openPanel(viewer);
    let panel = await readPanel(viewer);
    console.log(JSON.stringify(panel, null, 2));
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-small-lesion.png") });

    check(
      panel.rows.length === 1 && labelIs(panel.rows[0], "Baseline"),
      "タイムポイントが 1 件（ベースライン）だけ＝規則が live の計測に当たっている",
      panel.rows,
    );
    check(
      panel.rows.every((r) => r.source === "画面"),
      "行の出所が「画面」（古い記録が混ざっていない）",
      panel.rows.map((r) => r.source),
    );

    const size = Number(panel.lesionSizes[0]);
    check(Number.isFinite(size), "病変表に本体の実測サイズが出る", panel.lesionSizes);
    const kinds = panel.eligibility?.kinds ?? [];

    // **スライス厚が取れていること。** ここが `slice-thickness-unknown` になっていると、
    // 規則は毎回スキップされ「警告が出ない＝合格」に見えてしまう（静かな失敗）。
    check(
      !kinds.includes("slice-thickness-unknown"),
      "スライス厚が実機で取れている（規則がスキップされていない）",
      panel.eligibility,
    );

    if (Number.isFinite(size) && size < MIN_MEASURABLE_MM) {
      check(
        kinds.includes("too-small-target"),
        `長径 ${size}mm（< ${MIN_MEASURABLE_MM}mm）に対して too-small-target が出る`,
        panel.eligibility,
      );
      check(
        (panel.eligibility?.messages ?? []).some((m) => m.includes(`${size.toFixed(1)}mm`)),
        "警告文に本体の実測値がそのまま載る（プラグインが別の値を持っていない）",
        panel.eligibility?.messages,
      );
      check(
        panel.rows.some((r) => labelIs(r, "Baseline") && r.warned),
        "Baseline 行に ⚠ が付く（どの回の話か分かる）",
        panel.rows,
      );
      const baseline = panel.rows.find((r) => labelIs(r, "Baseline"));
      check(
        !!baseline && /^\d+\.\d$/.test(baseline.sld),
        "警告が出ても判定は止まらない（SLD が出続ける）",
        baseline?.sld,
      );
      check(
        !(panel.eligibility?.messages ?? []).some((m) => m.includes("#0")),
        "未紐付けの病変を `#0` と書かない",
        panel.eligibility?.messages,
      );
    } else {
      // 引いた長さが 10mm 以上だった場合。規則としては「警告が出ないのが正しい」ので、
      // ここを合格にすると空振りが隠れる。**未検証として落とす**。
      failures.push(`小さい病変を引けなかった（長径 ${size}mm）ため too-small-target を検証できない`);
      console.log(`  [FAIL] 小さい病変を引けなかった（長径 ${size}mm）。canvas スケールを見直す`);
    }

    console.log("\n[2] 十分大きい病変を足す — 大きい方には警告が付かないか");
    await drawBidirectional(viewer, 70, 24, { fracX: 0.55, fracY: 0.35 });
    panel = await readPanel(viewer);
    console.log(JSON.stringify(panel, null, 2));
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-with-large-lesion.png") });

    const sizes = panel.lesionSizes.map(Number).filter(Number.isFinite);
    const large = sizes.filter((v) => v >= MIN_MEASURABLE_MM);
    const small = sizes.filter((v) => v < MIN_MEASURABLE_MM);
    console.log(`  実測サイズ: ${JSON.stringify(sizes)}`);
    check(large.length >= 1, "10mm 以上の病変が測れている", sizes);
    const tooSmallCount = (panel.eligibility?.kinds ?? []).filter((k) => k === "too-small-target").length;
    check(
      tooSmallCount === small.length,
      `too-small-target の件数が 10mm 未満の病変数と一致する（規則の空振り/取りこぼしが無い）`,
      { tooSmallCount, small, large },
    );

    await viewer.close().catch(() => {});
  } finally {
    await driver.stop();
  }

  console.log("\n=== 結果 ===");
  if (failures.length === 0) {
    console.log(`${passed} 項目すべて OK。スクリーンショット: ${OUT_DIR}`);
  } else {
    console.log(`FAIL ${failures.length} 件:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

await main();
