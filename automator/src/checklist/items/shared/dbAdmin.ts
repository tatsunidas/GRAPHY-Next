import type { Page } from "@playwright/test";
import type { ChecklistItem, RunContext, StepRecorder } from "../../types.js";
import { resetDb } from "../../../backend/dbReset.js";
import { waitForMainScreenReady } from "./helpers.js";

/** fixtures/ct-basic の PatientID（fixture固定値、`04-import-export.item-01` と共通の前提）。 */
const CT_BASIC_PATIENT_ID = "HCC_001";

/**
 * DB管理ダイアログを開き、ct-basicのPatientIDで検索→患者行→先頭のスタディ行を展開する。
 * 03-db-admin の item-01〜04（ドリルダウン削除/患者編集/統合/分割）で共通の前提手順。
 */
async function openDbAdminAndExpandStudy(
  page: Page,
  recorder: StepRecorder,
  patientId = CT_BASIC_PATIENT_ID,
): Promise<void> {
  await waitForMainScreenReady(page);
  recorder.step("MainScreen の初期マウントを確認");

  await page.getByTestId("mainscreen-menu-system").click();
  await page.getByTestId("menu-item-dbadmin").click();
  await page.getByTestId("dbadmin-dialog").waitFor({ state: "visible", timeout: 10_000 });
  recorder.step("DB管理ダイアログを開く");

  await page.getByTestId("dbadmin-search-input").fill(patientId);
  await page.getByTestId("dbadmin-search-button").click();
  recorder.step(`患者ID ${patientId} で検索`);

  const patientExpand = page.getByTestId(`dbadmin-patient-expand-${patientId}`);
  await patientExpand.waitFor({ state: "visible", timeout: 10_000 });
  await patientExpand.click();
  recorder.step("患者行を展開");

  const studyExpand = page.locator('[data-testid^="dbadmin-study-expand-"]').first();
  await studyExpand.waitFor({ state: "visible", timeout: 10_000 });
  await studyExpand.click();
  // toggleStudy は非同期でシリーズを取得する。クリック直後は未反映のため、行の出現を待つ。
  await page.locator('[data-testid^="dbadmin-series-checkbox-"]').first().waitFor({ state: "visible", timeout: 10_000 });
  recorder.step("先頭のスタディ行を展開");
}

/** 展開中のスタディ配下にあるシリーズ行数（チェックボックス数で数える）。 */
function seriesRowCount(page: Page): Promise<number> {
  return page.locator('[data-testid^="dbadmin-series-checkbox-"]').count();
}

/**
 * 削除/統合/分割後は reload(q) が非同期で患者一覧まで畳む。畳まれる前に再展開をクリックすると
 * 「展開済みの行を閉じる」誤操作になるため、study-expand-* が実際に消える（＝畳まれた）のを
 * 待ってから再展開する。
 */
async function reexpandStudyAfterMutation(page: Page, recorder: StepRecorder): Promise<void> {
  await page.locator('[data-testid^="dbadmin-study-expand-"]').first().waitFor({ state: "hidden", timeout: 10_000 });
  await page.getByTestId(`dbadmin-patient-expand-${CT_BASIC_PATIENT_ID}`).click();
  const studyExpand = page.locator('[data-testid^="dbadmin-study-expand-"]').first();
  await studyExpand.waitFor({ state: "visible", timeout: 10_000 });
  await studyExpand.click();
  // toggleStudy は非同期でシリーズを取得する。クリック直後は未反映のため、行の出現を待つ。
  await page.locator('[data-testid^="dbadmin-series-checkbox-"]').first().waitFor({ state: "visible", timeout: 10_000 });
  recorder.step("患者一覧まで畳まれたのを確認してから再展開");
}

export const dbAdminItems: ChecklistItem[] = [
  {
    id: "03-db-admin.item-01",
    title: "Patient→Study→Seriesドリルダウン木でシリーズ削除ができる",
    category: "03-db-admin",
    modes: ["desktop", "web"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx: RunContext) {
      const { driver, recorder } = ctx;
      const page = driver.page;
      await openDbAdminAndExpandStudy(page, recorder);

      const before = await seriesRowCount(page);
      recorder.step("削除前のシリーズ行数を確認", { before });

      page.once("dialog", (d) => void d.accept());
      const deleteBtn = page.locator('[data-testid^="dbadmin-series-delete-"]').first();
      await deleteBtn.click();
      recorder.step("先頭シリーズの削除ボタンをクリック（確認ダイアログを自動許可）");

      await reexpandStudyAfterMutation(page, recorder);
      const after = await seriesRowCount(page);
      recorder.step("削除後、再展開してシリーズ行数を確認", { after });

      if (after !== before - 1) {
        return { status: "fail" as const, error: `削除後のシリーズ行数が期待値と一致しません: before=${before}, after=${after}` };
      }
      return { status: "pass" as const, notes: `シリーズ削除でbefore=${before}→after=${after}` };
    },
  },
  {
    id: "03-db-admin.item-02",
    title: "スタディ指定で患者情報を編集（PatientID変更で別患者へ移動）できる",
    category: "03-db-admin",
    modes: ["desktop", "web"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx: RunContext) {
      const { driver, recorder } = ctx;
      const page = driver.page;
      const movedId = "HCC_001_MOVED";
      await openDbAdminAndExpandStudy(page, recorder);

      const editBtn = page.locator('[data-testid^="dbadmin-study-edit-"]').first();
      await editBtn.click();
      const form = page.getByTestId("dbadmin-study-edit-form");
      await form.waitFor({ state: "visible", timeout: 10_000 });
      await page.getByTestId("dbadmin-study-edit-newid").fill(movedId);
      await page.getByTestId("dbadmin-form-save").click();
      await form.waitFor({ state: "hidden", timeout: 10_000 });
      recorder.step(`PatientID を ${movedId} へ変更して保存`);

      await page.getByTestId("dbadmin-search-input").fill(movedId);
      await page.getByTestId("dbadmin-search-button").click();
      const movedRow = page.getByTestId(`dbadmin-patient-expand-${movedId}`);
      const movedVisible = await movedRow.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false);
      recorder.step("移動先PatientIDで検索し、患者行の出現を確認", { movedVisible });

      // 後続項目のため元のPatientIDへ戻す（このitemの中で完結させる）。
      if (movedVisible) {
        await movedRow.click();
        const studyExpand = page.locator('[data-testid^="dbadmin-study-expand-"]').first();
        await studyExpand.waitFor({ state: "visible", timeout: 10_000 });
        await studyExpand.click();
        const editBtn2 = page.locator('[data-testid^="dbadmin-study-edit-"]').first();
        await editBtn2.click();
        await form.waitFor({ state: "visible", timeout: 10_000 });
        await page.getByTestId("dbadmin-study-edit-newid").fill(CT_BASIC_PATIENT_ID);
        await page.getByTestId("dbadmin-form-save").click();
        await form.waitFor({ state: "hidden", timeout: 10_000 });
        recorder.step(`元のPatientID ${CT_BASIC_PATIENT_ID} へ戻す（後続項目のためのクリーンアップ）`);
      }

      if (!movedVisible) {
        return { status: "fail" as const, error: `移動先PatientID ${movedId} の患者行が現れませんでした` };
      }
      return { status: "pass" as const, notes: `PatientID変更による患者移動を確認、元IDへ復元済み` };
    },
  },
  {
    id: "03-db-admin.item-03",
    title: "シリーズ統合（N→1、InstanceNumber再採番）ができる",
    category: "03-db-admin",
    modes: ["desktop", "web"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx: RunContext) {
      const { driver, recorder } = ctx;
      const page = driver.page;
      await openDbAdminAndExpandStudy(page, recorder);

      const before = await seriesRowCount(page);
      recorder.step("統合前のシリーズ行数を確認", { before });
      if (before < 2) {
        return { status: "fail" as const, error: `統合には2シリーズ以上が必要です（実際: ${before}）` };
      }

      const checkboxes = page.locator('[data-testid^="dbadmin-series-checkbox-"]');
      await checkboxes.nth(0).check();
      await checkboxes.nth(1).check();
      recorder.step("先頭2シリーズを選択");

      const mergeOpen = page.locator('[data-testid^="dbadmin-merge-open-"]').first();
      await mergeOpen.click();
      const form = page.getByTestId("dbadmin-merge-form");
      await form.waitFor({ state: "visible", timeout: 10_000 });
      await page.getByTestId("dbadmin-merge-run").click();
      await form.waitFor({ state: "hidden", timeout: 10_000 });
      recorder.step("統合ダイアログでシリーズ統合を実行");

      await reexpandStudyAfterMutation(page, recorder);
      const after = await seriesRowCount(page);
      recorder.step("統合後、再展開してシリーズ行数を確認", { after });

      if (after !== before - 1) {
        return { status: "fail" as const, error: `統合後のシリーズ行数が期待値と一致しません: before=${before}, after=${after}` };
      }
      return { status: "pass" as const, notes: `シリーズ統合でbefore=${before}→after=${after}` };
    },
  },
  {
    id: "03-db-admin.item-04",
    title: "シリーズ分割（1→N、手動群分け）ができる",
    category: "03-db-admin",
    modes: ["desktop", "web"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx: RunContext) {
      const { driver, recorder } = ctx;
      const page = driver.page;
      await openDbAdminAndExpandStudy(page, recorder);

      const before = await seriesRowCount(page);
      recorder.step("分割前のシリーズ行数を確認", { before });

      const splitBtn = page.locator('[data-testid^="dbadmin-series-split-"]').first();
      const hasSplittable = await splitBtn.count();
      if (hasSplittable < 1) {
        return { status: "fail" as const, error: "分割可能（2枚以上）なシリーズが見つかりません" };
      }
      await splitBtn.click();
      const form = page.getByTestId("dbadmin-split-form");
      await form.waitFor({ state: "visible", timeout: 10_000 });
      recorder.step("分割ダイアログを開く（既定 groupCount=2）");

      // 先頭インスタンスだけを群1へ割当て、残りは元シリーズに残す（最小構成の手動群分け）。
      const firstAssign = page.locator('[data-testid^="dbadmin-split-assign-"]').first();
      await firstAssign.selectOption("1");
      recorder.step("先頭インスタンスを群1へ割当て");

      await page.getByTestId("dbadmin-split-run").click();
      await form.waitFor({ state: "hidden", timeout: 10_000 });
      recorder.step("分割を実行");

      await reexpandStudyAfterMutation(page, recorder);
      const after = await seriesRowCount(page);
      recorder.step("分割後、再展開してシリーズ行数を確認", { after });

      if (after !== before + 1) {
        return { status: "fail" as const, error: `分割後のシリーズ行数が期待値と一致しません: before=${before}, after=${after}` };
      }
      return { status: "pass" as const, notes: `シリーズ分割でbefore=${before}→after=${after}` };
    },
  },
  {
    id: "03-db-admin.item-06",
    title: "DBを初期化して空の状態にできる（automator用reset）",
    category: "03-db-admin",
    modes: ["desktop", "web"],
    requiresHuman: false,
    async run(ctx) {
      const { driver, recorder } = ctx;
      const page = driver.page;
      await waitForMainScreenReady(page);
      recorder.step("MainScreen の初期マウントを確認");

      const before = await resetDb(driver.ports.http);
      recorder.step("POST /api/automator/reset", { before });

      await page.reload();
      await waitForMainScreenReady(page);
      recorder.step("MainScreen をリロードし、再マウントを確認");

      // SearchPanel は既定条件(今日)でデバウンス自動検索する。結果反映を待つ。
      await page.waitForTimeout(1000);
      const rows = page.locator('[data-testid^="study-row-"]');
      const count = await rows.count();
      recorder.step("study-row-* の件数を確認", { count });

      if (count !== 0) {
        return { status: "fail" as const, error: `reset後もスタディが${count}件残っています` };
      }
      return { status: "pass" as const, notes: `reset結果: ${JSON.stringify(before)}` };
    },
  },
];
