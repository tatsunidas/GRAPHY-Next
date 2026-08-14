/*
 * RDSR（被ばく線量レポート, A9）の実機検証 — `fw/angio-design.md` §14.2。
 *
 * 実行:  cd automator && npx tsx src/spike/xaDoseCheck.ts
 *
 * ⚠️ **実 RDSR が手元に無い**（設計 §20-5）。`automator/scripts/make-rdsr.py` で
 *    TID 10001/10003 の入れ子を実物どおりに組んだ**合成 RDSR** を作って検証する。
 *    パーサは CodeMeaning で突き合わせる設計なので、コード値が実機と違っても意味は保たれるが、
 *    **実データでの確認は別途必要**（この検証は「構造を読めること」までを保証する）。
 *
 * 確かめること:
 *   1. RDSR を取り込める（画像でない SOP として弾かれない）
 *   2. GET /api/studies/{uid}/dose が積算線量を返す
 *   3. 照射イベントを 3 件とも読める（種別・UID・DAP・角度）
 *   4. 照射イベント配下の値が積算に**二重計上されていない**
 *   5. 画面（機能メニュー → 被ばく線量レポート）にサマリとイベント表が出る
 *   6. 「線量管理システムではない」旨が画面に出ている
 *   7. RDSR が無い検査では「レポートなし」と出る（404 にしない）
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "xa-dose");
const XA_DIR = path.join(AUTOMATOR_ROOT, "fixtures", "xa-angio");
const SAMPLE = path.join(XA_DIR, "0002.DCM");
const RDSR = path.join(OUT_DIR, "rdsr.dcm");
const MAKE_RDSR = path.join(AUTOMATOR_ROOT, "scripts", "make-rdsr.py");

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

interface DoseItem {
  code: string | null;
  meaning: string | null;
  numericValue: number | null;
  unit: string | null;
  textValue: string | null;
}
interface StudyDose {
  reports: {
    manufacturer: string | null;
    contentDateTime: string | null;
    accumulated: DoseItem[];
    events: { index: number; eventType: string | null; eventUid: string | null; items: DoseItem[] }[];
  }[];
  summary: {
    doseAreaProductTotal: number | null;
    doseRpTotal: number | null;
    fluoroTimeTotal: number | null;
    irradiationEventCount: number;
  };
}

async function fetchDose(httpPort: number, studyUid: string): Promise<StudyDose> {
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/studies/${encodeURIComponent(studyUid)}/dose`);
  if (!res.ok) throw new Error(`dose 取得に失敗: ${res.status}`);
  return (await res.json()) as StudyDose;
}

async function firstStudyUid(httpPort: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/studies`);
  const studies = (await res.json()) as { studyInstanceUid: string }[];
  if (!studies.length) throw new Error("スタディがありません");
  return studies[0].studyInstanceUid;
}

async function dismissStartupDialogs(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const dialog = page.locator('[role="dialog"]');
    if ((await dialog.count()) === 0) return;
    const close = dialog.first().getByRole("button", { name: /閉じる|Close/ });
    if ((await close.count()) > 0) await close.first().click().catch(() => {});
    else await page.mouse.click(5, 5).catch(() => {});
    await page.waitForTimeout(400);
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(SAMPLE)) throw new Error(`XA サンプルがありません: ${SAMPLE}`);
  // 合成 RDSR を（無ければ）作る。参照 XA から患者/スタディを引き継ぐ。
  if (!fs.existsSync(RDSR)) {
    execFileSync("python3", [MAKE_RDSR, RDSR, SAMPLE], { stdio: "inherit" });
  }

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const page = driver.page;
    await resetDb(driver.ports.http);

    // ── 条件 1: 取込 ────────────────────────────────────────────────
    const imp = await importPaths(driver.ports.http, [SAMPLE, RDSR]);
    check(imp.imported === 2, "[1] XA と RDSR を取り込める", imp);
    const studyUid = await firstStudyUid(driver.ports.http);

    // ── 条件 2/3/4: API ────────────────────────────────────────────
    const dose = await fetchDose(driver.ports.http, studyUid);
    console.log(`  サマリ: ${JSON.stringify(dose.summary)}`);
    check(dose.reports.length === 1, "[2a] RDSR を 1 件検出した", dose.reports.length);
    check(dose.summary.doseAreaProductTotal === 12.5, "[2b] 積算 DAP を読めた", dose.summary.doseAreaProductTotal);
    check(dose.summary.doseRpTotal === 340, "[2c] 積算 Dose(RP) を読めた", dose.summary.doseRpTotal);
    check(dose.summary.fluoroTimeTotal === 180, "[2d] 透視時間を読めた", dose.summary.fluoroTimeTotal);
    check(dose.summary.irradiationEventCount === 3, "[3a] 照射イベントを 3 件読めた", dose.summary.irradiationEventCount);

    const ev = dose.reports[0]?.events ?? [];
    check(ev[0]?.eventType === "Fluoroscopy", "[3b] イベント種別を読めた", ev[0]?.eventType);
    check(!!ev[0]?.eventUid, "[3c] Irradiation Event UID を読めた", ev[0]?.eventUid);
    const dap0 = ev[0]?.items.find((i) => i.meaning === "Dose Area Product");
    check(dap0?.numericValue === 3.5 && dap0?.unit === "Gy.m2", "[3d] イベントの DAP と単位を読めた", dap0);
    const angle0 = ev[0]?.items.find((i) => i.meaning === "Positioner Primary Angle");
    check(angle0?.numericValue === -30, "[3e] 角度など付随情報も拾えている", angle0?.numericValue);

    // ★ 積算に混ざっていないこと（イベント配下の DAP 3.5+9+6.25=18.75 が足されていない）。
    const acc = dose.reports[0]?.accumulated ?? [];
    check(acc.length === 3, "[4a] 積算は 3 項目だけ（イベント配下を含まない）", acc.length);
    check(
      dose.summary.doseAreaProductTotal === 12.5,
      "[4b] 積算 DAP にイベントの DAP が二重計上されていない",
      { total: dose.summary.doseAreaProductTotal, eventsSum: 18.75 },
    );

    // ── 条件 5/6: 画面 ─────────────────────────────────────────────
    await waitForMainScreenReady(page, 60_000);
    await dismissStartupDialogs(page);
    page.once("dialog", (d) => void d.accept());
    const dateInputs = page.locator('input[type="date"]');
    await dateInputs.nth(0).fill("");
    await dateInputs.nth(1).fill("");
    await page.getByTestId("search-submit-button").click();
    await page.locator('[data-testid^="study-row-"]').first().click();
    await page.waitForTimeout(500);

    // MenuBar はメニューを開かないと項目が描画されない。
    await page.getByTestId("mainscreen-menu-function").click();
    await page.waitForTimeout(400);
    await page.getByTestId("menu-item-dose").click();
    await page.waitForTimeout(2_000);
    const text = (await page.locator("body").textContent()) ?? "";
    check(/被ばく線量レポート|Radiation Dose Report/.test(text), "[5a] 線量レポート画面が開く");
    check(text.includes("12.5"), "[5b] サマリに積算 DAP が出る");
    check(/Fluoroscopy/.test(text), "[5c] 照射イベントの種別が表に出る");
    check(
      /線量管理システムの代替ではありません|not a substitute for a dose management system/.test(text),
      "[6] 「線量管理システムではない」旨が出ている",
    );
    await page.screenshot({ path: path.join(OUT_DIR, "1-dose-report.png") }).catch(() => {});

    // ── 条件 7: RDSR が無い検査 ────────────────────────────────────
    await page.getByRole("button", { name: /^閉じる$|^Close$/ }).last().click().catch(() => {});
    await page.waitForTimeout(500);
    await resetDb(driver.ports.http);
    await importPaths(driver.ports.http, [SAMPLE]);
    const studyUid2 = await firstStudyUid(driver.ports.http);
    const dose2 = await fetchDose(driver.ports.http, studyUid2);
    check(dose2.reports.length === 0, "[7a] RDSR が無い検査では空で返る（404 にしない）", dose2.reports.length);
    check(dose2.summary.doseAreaProductTotal === null, "[7b] 取れない項目は 0 ではなく null", dose2.summary);
  } finally {
    await driver.stop();
  }

  console.log(`\n===== RDSR（A9）受け入れ条件 =====`);
  console.log(`合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) {
    console.log("失敗した項目:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
  console.log(`スクリーンショット: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
