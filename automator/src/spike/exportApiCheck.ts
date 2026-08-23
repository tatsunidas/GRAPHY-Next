/*
 * H16（SR の数値計測の拡張）・H22（DICOM SEG 書き出し）・H23（RTDOSE 書き出し）・
 * H25（本体レポートへの解析結果の登録）の実機検証スパイク。
 *
 * 実行:  cd automator && npx tsx src/spike/exportApiCheck.ts
 *
 * <p><b>何を確かめるか</b>（本物の Electron ＋ backend ＋ プラグイン配信経路）:
 *
 *   1. H22: マスクが **DICOM SEG シリーズとして保管庫に入り、読み戻すと前景が一致する**
 *   2. H22: **格子がずれていたら保存しない**（1 枚ずらした要求が拒否される）
 *   3. H22: 前景ゼロのセグメントは保存対象から外れる
 *   4. H23: 線量が **RTDOSE（Modality=RTDOSE）として入り、格納値 × DoseGridScaling で Gy に戻る**
 *   5. H23: **RT Plan が無いことが警告として返る**（黙って準拠していない物を作らない）
 *   6. H23: `NaN` があるのに背景未指定なら**同意を求める前に拒否される**
 *   7. H16: 吸収線量・TIA・有効半減期・体積・質量が **SR に入る**（従来は種別が拒否されていた）
 *   8. H25: `caveats` が空なら**拒否**、あれば登録される
 *
 * <p>保存は**必ず確認ダイアログを挟む**ので、automator がダイアログを操作する
 * （プラグインが黙って保管庫へ書けないことの確認でもある）。
 *
 * <p>真値はファントム GNBP-D（線量評価プラグインの `bench/`）。生成物が無ければ作り方を出して終わる。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const PLUGIN_ID = "exportapi-check";
const PLUGIN_SRC = path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID);
const PHANTOM = path.join(
  os.homedir(), "graphy-workspace", "graphy-next-plugin-dosimetry", "bench", "phantom", "GNBP-D",
);
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "export-api-check");

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
function near(got: number, want: number, tol: number, label: string): void {
  check(Number.isFinite(got) && Math.abs(got - want) <= tol, `${label}（期待 ${want} / 実測 ${got}）`);
}

interface Probe {
  ready: boolean;
  error: string | null;
  grid?: { dims: number[]; spacing: number[]; ipp: number[]; iop: number[]; sliceStep: number[] };
  center?: number[];
  maskVoxels?: number;
  doseGy?: number;
  emptySliceCount?: number;
  targets?: { modality: string; seriesUid: string; studyUid: string }[];
}

interface SaveOutcome {
  ok?: boolean;
  cancelled?: boolean;
  error?: string;
  seriesInstanceUid?: string;
  sopInstanceUid?: string;
  foregroundVoxels?: number[];
  doseGridScaling?: number;
  quantizationErrorGy?: number;
  filledVoxels?: number;
  warnings?: string[];
}

function installPlugin(): void {
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const f of ["plugin.json", "ui.js"]) {
    fs.copyFileSync(path.join(PLUGIN_SRC, f), path.join(dst, f));
  }
  console.log(`プラグインを配置: ${dst}`);
}

/**
 * 保存を起こし、確認ダイアログを承認（または拒否）して結果を受け取る。
 *
 * <p>プラグインの呼び出しは**ダイアログが出ている間ずっと待っている**ので、
 * promise を window に置いてから操作し、最後に await する。
 */
async function saveWithDialog(
  page: Page,
  call: string,
  accept: boolean,
): Promise<SaveOutcome> {
  // ★ **代入式をそのまま evaluate しない。** `window.__x = promise` は式の値が promise なので、
  //   Playwright がそれを await してしまい、「ダイアログを操作するまで返らない evaluate」を
  //   待ち続けて固まる（2026-08-23 に実際に踏んだ。9 分待って timeout した）。
  //   IIFE で包んで**非 thenable を返す**。
  await page.evaluate(`
    (function () {
      window.__saveResult = (${call}).then(
        function (v) { return v; },
        function (e) { return { ok: false, error: String(e) }; }
      );
      return true;
    })()
  `);
  const dialog = page.getByTestId("plugin-save-confirm");
  await dialog.waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId(accept ? "plugin-save-confirm-button" : "plugin-save-cancel").click();
  return (await page.evaluate(`window.__saveResult`)) as SaveOutcome;
}

/** ダイアログが出ない（＝同意を求める前に拒否される）呼び出し。 */
async function saveExpectingRejection(page: Page, call: string): Promise<SaveOutcome> {
  return (await page.evaluate(`
    (${call}).then(
      function (v) { return v; },
      function (e) { return { ok: false, error: String(e) }; }
    )
  `)) as SaveOutcome;
}

async function seriesList(http: number, studyUid: string): Promise<
  { seriesInstanceUid: string; modality: string; seriesDescription: string }[]
> {
  const res = await fetch(`http://127.0.0.1:${http}/api/studies/${studyUid}/series`);
  return (await res.json()) as { seriesInstanceUid: string; modality: string; seriesDescription: string }[];
}

async function tagsOf(http: number, studyUid: string, seriesUid: string, sopUid: string) {
  const res = await fetch(
    `http://127.0.0.1:${http}/api/studies/${studyUid}/series/${seriesUid}/instances/${sopUid}/tags`,
  );
  const rows = (await res.json()) as { tag: string; name: string; value: string }[];
  const byName = new Map<string, string>();
  for (const r of rows) byName.set(r.name, r.value);
  return byName;
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(PHANTOM, "dicom"))) {
    console.error(`ファントムがありません: ${PHANTOM}/dicom`);
    console.error("  cd ~/graphy-workspace/graphy-next-plugin-dosimetry && npm run phantom:dicom");
    process.exit(1);
  }
  const truth = JSON.parse(fs.readFileSync(path.join(PHANTOM, "truth.json"), "utf-8"));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installPlugin();

  const driver = new DesktopDriver();
  await driver.start();
  let viewer: Page | null = null;
  try {
    const http = driver.ports.http;
    console.log(`\n[0] 初期化（backend=${http}）`);
    console.log(`  reset: ${JSON.stringify(await resetDb(http))}`);
    const dirs = fs.readdirSync(path.join(PHANTOM, "dicom")).map((d) => path.join(PHANTOM, "dicom", d));
    const res = await fetch(`http://127.0.0.1:${http}/api/import/paths`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: dirs }),
    });
    console.log(`  import: ${JSON.stringify(await res.json())}`);

    const tp0 = truth.timepoints[0];
    console.log("\n[1] 2D Viewer を開き、CT のタイルを足す");
    const main = driver.page;
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await main.locator('input[type="date"]').nth(0).fill("");
    await main.locator('input[type="date"]').nth(1).fill("");
    await main.getByTestId("search-patientid-input").fill("GNBP-D-1");
    await main.getByTestId("search-submit-button").click();
    await main.waitForTimeout(2500);
    await main.getByTestId(`study-row-${tp0.studyUid}`).click();
    await main.waitForTimeout(1200);
    await main.getByTestId(`series-row-${tp0.spect.dicom}`).click();
    await main.getByTestId("series-viewer-root").waitFor({ state: "visible", timeout: 20_000 });
    await main.waitForTimeout(1500);
    viewer = await driver.waitForNewPage(
      () => main.getByTestId("viewer2d-toolbar-button").click(),
      (url: string) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2000);
    const added = await viewer.evaluate(`
      (function (needle) {
        var all = document.querySelectorAll("div");
        for (var i = 0; i < all.length; i++) {
          var t = all[i].textContent || "";
          if (t.length > 80 || t.indexOf(needle) < 0) continue;
          var b = all[i].querySelector("button");
          var mark = b ? (b.textContent || "").trim() : "";
          if (b && !b.disabled && (mark === "＋" || mark === "+")) { b.click(); return true; }
        }
        return false;
      })(${JSON.stringify("CT CT 4h")})
    `);
    check(added === true, "左ツリーから CT をタイルに追加できる");
    await viewer.waitForTimeout(2500);

    console.log("\n[2] プローブを起動する");
    await viewer.getByTestId("viewer2d-menu-plugins").click();
    const item = viewer.getByTestId(`plugin-item-${PLUGIN_ID}`);
    check((await item.count()) > 0, "プローブが Plug-ins メニューに出る");
    await item.first().click();
    for (let i = 0; i < 240; i++) {
      const done = await viewer.evaluate(`Boolean(window.__exportApiCheck && (window.__exportApiCheck.ready || window.__exportApiCheck.error))`);
      if (done) break;
      await viewer.waitForTimeout(1000);
    }
    const probe = (await viewer.evaluate(`window.__exportApiCheck ?? null`)) as Probe | null;
    fs.writeFileSync(path.join(OUT_DIR, "probe.json"), JSON.stringify(probe, null, 2));
    check(!!probe && probe.ready === true, "プローブが準備できる", probe?.error);
    if (!probe?.ready) throw new Error(`probe が動いていない: ${probe?.error}`);
    console.log(`  マスク: ${probe.maskVoxels} ボクセル / 線量 ${probe.doseGy} Gy`);
    const ctSeries = probe.targets?.find((t) => t.modality === "CT");
    if (!ctSeries) throw new Error("CT のタイルが無い");

    // --- H22 -------------------------------------------------------------
    console.log("\n[3] H22: マスクを DICOM SEG として保存する");
    const beforeSeg = await seriesList(http, ctSeries.studyUid);

    // まず拒否できることを見る（プラグインが黙って書けない）。
    const declined = await saveWithDialog(viewer, "window.__exportApi.saveSeg()", false);
    check(declined.cancelled === true, "★ 確認ダイアログで拒否すると保存されない", declined);
    const afterDecline = await seriesList(http, ctSeries.studyUid);
    check(afterDecline.length === beforeSeg.length, "拒否したらシリーズは増えない",
      { before: beforeSeg.length, after: afterDecline.length });

    const seg = await saveWithDialog(viewer, "window.__exportApi.saveSeg()", true);
    check(seg.ok === true, "★ SEG が保存できる", seg);
    check(
      JSON.stringify(seg.foregroundVoxels) === JSON.stringify([probe.maskVoxels, 0]),
      "★ 前景ボクセル数が返る（前景ゼロのセグメントは 0 と分かる）",
      seg.foregroundVoxels,
    );
    if (seg.seriesInstanceUid) {
      const list = await seriesList(http, ctSeries.studyUid);
      const created = list.find((s) => s.seriesInstanceUid === seg.seriesInstanceUid);
      check(created?.modality === "SEG", "★ 保管庫に Modality=SEG のシリーズが増える", created);
      check((created?.seriesDescription ?? "").startsWith("[Plugin] "),
        "★ プラグイン出力と分かる接頭辞が付く", created?.seriesDescription);

      // 読み戻して前景が一致するか（本体の SEG 読込を通す）。
      const readRes = await fetch(
        `http://127.0.0.1:${http}/api/dicom/seg?study=${ctSeries.studyUid}&series=${seg.seriesInstanceUid}`,
      );
      const readBack = (await readRes.json()) as {
        segments: { label: string; frames: { mask: string }[] }[];
      };
      check(readBack.segments.length === 1,
        "★ 前景ゼロのセグメントは保存されていない（1 個だけ）", readBack.segments.length);
      check(readBack.segments[0]?.label === "probe-box", "セグメント名が保たれる", readBack.segments[0]?.label);
      let readForeground = 0;
      for (const f of readBack.segments[0]?.frames ?? []) {
        const buf = Buffer.from(f.mask, "base64");
        for (const b of buf) if (b !== 0) readForeground++;
      }
      check(readForeground === probe.maskVoxels,
        `★ 読み戻した前景ボクセル数が一致（期待 ${probe.maskVoxels} / 実測 ${readForeground}）`);
      check((readBack.segments[0]?.frames.length ?? 0) === 3,
        "★ 非空スライスだけが入る（3 枚）", readBack.segments[0]?.frames.length);
    }

    console.log("\n[4] H22: 格子がずれた要求は保存しない");
    const shifted = await saveExpectingRejection(viewer, "window.__exportApi.saveSegShifted()");
    check(shifted.ok === false && !shifted.cancelled,
      "★ 1 スライスずらした格子は同意を求める前に拒否される", shifted);
    check((shifted.error ?? "").includes("ずれ"), "拒否の理由が「ずれ」と分かる", shifted.error);

    // --- H23 -------------------------------------------------------------
    console.log("\n[5] H23: 線量を RTDOSE として保存する");
    const badDose = await saveExpectingRejection(viewer, "window.__exportApi.saveDoseNoBackground()");
    check(badDose.ok === false && (badDose.error ?? "").includes("backgroundGy"),
      "★ NaN があるのに背景未指定なら、同意を求める前に拒否される", badDose.error);

    const dose = await saveWithDialog(viewer, "window.__exportApi.saveDose()", true);
    check(dose.ok === true, "★ RTDOSE が保存できる", dose);
    check((dose.warnings ?? []).some((w) => w.includes("ReferencedRTPlanSequence")),
      "★ RT Plan が無いことが警告として返る（黙って準拠しない物を作らない）", dose.warnings);
    check((dose.filledVoxels ?? 0) > 0, "背景で埋めたボクセル数が返る", dose.filledVoxels);
    if (dose.seriesInstanceUid && dose.sopInstanceUid) {
      const list = await seriesList(http, ctSeries.studyUid);
      const created = list.find((s) => s.seriesInstanceUid === dose.seriesInstanceUid);
      check(created?.modality === "RTDOSE", "★ 保管庫に Modality=RTDOSE のシリーズが増える", created);

      const tags = await tagsOf(http, ctSeries.studyUid, dose.seriesInstanceUid, dose.sopInstanceUid);
      check(tags.get("DoseUnits") === "GY", "DoseUnits", tags.get("DoseUnits"));
      check(tags.get("DoseType") === "PHYSICAL", "DoseType", tags.get("DoseType"));
      const frames = Number(tags.get("NumberOfFrames"));
      check(frames === probe.grid?.dims[2], "★ フレーム数が格子のスライス数と一致",
        { got: frames, want: probe.grid?.dims[2] });
      const scaling = Number(tags.get("DoseGridScaling"));
      near(scaling, dose.doseGridScaling ?? 0, Math.abs((dose.doseGridScaling ?? 1) * 1e-6),
        "DoseGridScaling が保存値と一致");
      // 🔴 格納値 × 係数 = 線量。量子化の往復誤差は係数の半分以内。
      const back = 65535 * scaling;
      check(Math.abs(back - (probe.doseGy ?? 0)) <= (dose.quantizationErrorGy ?? 0) + 1e-9,
        `★ 格納値 × DoseGridScaling が線量に戻る（${back.toFixed(6)} / 真値 ${probe.doseGy}）`);
      const gfov = (tags.get("GridFrameOffsetVector") ?? "").split("\\").map(Number);
      check(gfov[0] === 0, "★ GridFrameOffsetVector の先頭が 0（1 枚ずれない）", gfov[0]);
      near(gfov[1] - gfov[0], truth.geometry.ct.spacingMm[2], 1e-3, "フレーム間隔が CT のスライス間隔");
      check(!!tags.get("FrameOfReferenceUID"), "★ 空間基準が元シリーズから引き継がれる",
        tags.get("FrameOfReferenceUID"));
    }

    // --- H16 -------------------------------------------------------------
    console.log("\n[6] H16: 線量系の計測を SR に入れる");
    const sr = await saveWithDialog(viewer, "window.__exportApi.saveSr()", true);
    check(sr.ok === true, "★ 吸収線量・TIA・有効半減期・体積・質量を含む SR が保存できる", sr);
    if (sr.seriesInstanceUid && sr.sopInstanceUid) {
      const tags = await tagsOf(http, ctSeries.studyUid, sr.seriesInstanceUid, sr.sopInstanceUid);
      check(tags.get("Modality") === "SR", "Modality=SR", tags.get("Modality"));
      const dump = await fetch(
        `http://127.0.0.1:${http}/api/studies/${ctSeries.studyUid}/series/${sr.seriesInstanceUid}/instances/${sr.sopInstanceUid}/tags`,
      );
      const rows = (await dump.json()) as { name: string; value: string }[];
      const text = rows.map((r) => `${r.name}=${r.value}`).join("\n");
      check(text.includes("ABSORBED_DOSE"), "★ 吸収線量の概念コードが入る");
      check(text.includes("99GRAPHY"), "★ 確認できない概念は私用スキームで書かれる");
      check(text.includes("2.5"), "★ 計測値がそのまま入る（2.5 Gy）");
    }

    // --- H25 -------------------------------------------------------------
    console.log("\n[7] H25: 解析結果をレポートへ登録する");
    const noCaveat = (await viewer.evaluate(`window.__exportApi.publish([])`)) as { ok: boolean; error?: string };
    check(noCaveat.ok === false, "★ 注意書きが空なら拒否される", noCaveat);
    const published = (await viewer.evaluate(
      `window.__exportApi.publish(["研究用であり診断に用いない"])`,
    )) as { ok: boolean; error?: string };
    check(published.ok === true, "★ 注意書きがあれば登録される", published);

    await viewer.screenshot({ path: path.join(OUT_DIR, "final.png") });
  } finally {
    await driver.stop().catch(() => undefined);
  }

  console.log("");
  console.log(`合格 ${passed} / 失敗 ${failures.length}`);
  for (const f of failures) console.log(` - ${f}`);
  console.log(`出力: ${OUT_DIR}`);
  if (failures.length > 0) process.exit(1);
}

await main();
