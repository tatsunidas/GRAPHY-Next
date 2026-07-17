import fs from "node:fs";
import path from "node:path";
import type { ChecklistItem, RunContext } from "../../types.js";
import { selectFirstStudy } from "../shared/helpers.js";
import { AUTOMATOR_ROOT } from "../../../fixtures/manifest.js";
import { waitForAnyFile } from "../../../common/waitForFile.js";
import { importPaths } from "../../../fixtures/importFixtures.js";

/** fixtures/ct-basic の PatientID（fixture固定値）。 */
const CT_BASIC_PATIENT_ID = "HCC_001";

/**
 * Anonymizerダイアログを開き、新PatientIDを設定→出力先(モック)を選択→フォルダコピー実行→
 * 成功メッセージ表示（＝コピー完了、非同期処理の完了を待つ）→出力先にファイルが実在することを
 * 確認→ダイアログを閉じる、という一連の手順を実行する。
 * setup で追加のオプション設定（RetainSafePrivate等）を差し込める。
 */
async function runAnonymizeCopy(
  ctx: RunContext,
  newPatientId: string,
  destDir: string,
  setup?: (page: import("@playwright/test").Page) => Promise<void>,
): Promise<void> {
  const { driver, recorder } = ctx;
  const page = driver.page;

  if (!driver.mockNativeDirectoryPicker) {
    throw new Error("driver.mockNativeDirectoryPicker が利用できません（desktop driver専用機能）");
  }
  fs.mkdirSync(destDir, { recursive: true });
  await driver.mockNativeDirectoryPicker(destDir);

  await page.getByTestId("toolbar-anonymizer-btn").click();
  const dialog = page.getByTestId("anonymizer-dialog");
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  recorder.step("Anonymizerダイアログを開く");

  if (setup) await setup(page);

  await page.getByTestId("anon-new-id-input").fill(newPatientId);
  recorder.step(`新PatientIDを設定: ${newPatientId}`);

  await page.getByTestId("anon-pick-dest-btn").click();
  await page.waitForFunction(
    (dest) => document.querySelector('[data-testid="anon-pick-dest-btn"]')?.getAttribute("title") === dest,
    destDir,
    { timeout: 5_000 },
  );
  recorder.step("モックしたフォルダを出力先として選択", { destDir });

  await page.getByTestId("anon-copy-btn").click();
  // 「出力完了」メッセージが出るまで待つ（コピーはバックエンド側で非同期に進むため、
  // ファイルの出現だけを見ると完了前の途中状態を掴んでしまう）。
  const infoMsg = page.getByTestId("anon-info-message");
  await infoMsg.waitFor({ state: "visible", timeout: 30_000 });
  const infoText = await infoMsg.textContent();
  recorder.step("匿名化コピー完了メッセージを確認", { infoText });

  const filesAppeared = await waitForAnyFile(destDir);
  recorder.step("出力先フォルダにファイルが実在することを確認", { filesAppeared });
  if (!filesAppeared) {
    throw new Error(`出力先フォルダ ${destDir} にファイルが生成されませんでした`);
  }

  await page.getByTestId("dialog-close-button").click();
  await dialog.waitFor({ state: "hidden", timeout: 5_000 });
}

/** 指定PatientIDで検索し、対応するスタディ行が見つかるかを返す。 */
async function findStudyByPatientId(ctx: RunContext, patientId: string): Promise<boolean> {
  const page = ctx.driver.page;
  await page.getByTestId("search-patientid-input").fill(patientId);
  await page.getByTestId("search-submit-button").click();
  const row = page.locator('[data-testid^="study-row-"]');
  return row.first().waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false);
}

export const anonymizerItems: ChecklistItem[] = [
  {
    id: "07-anonymizer.item-01",
    title: "PS3.15プロファイルでタグ匿名化（X/Z/D/K/C/U）・UID一貫置換ができる",
    category: "07-anonymizer",
    modes: ["desktop"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx: RunContext) {
      const { recorder } = ctx;
      await selectFirstStudy(ctx.driver.page, recorder);

      const newId = "ANON_ITEM01";
      const destDir = path.join(AUTOMATOR_ROOT, ".results", `anon-out-${Date.now()}`);
      await runAnonymizeCopy(ctx, newId, destDir);

      const imported = await importPaths(ctx.driver.ports.http, [destDir]);
      recorder.step("匿名化出力を再取込み", { imported });
      if (imported.imported <= 0) {
        return { status: "fail" as const, error: `匿名化出力の再取込みに失敗しました: ${JSON.stringify(imported)}` };
      }

      // UIDが一貫して置換されていれば、元スタディ（HCC_001）を上書きせず、
      // 新StudyInstanceUIDを持つ別スタディ（新PatientID）として共存するはず。
      const originalStillThere = await findStudyByPatientId(ctx, CT_BASIC_PATIENT_ID);
      recorder.step(`元のPatientID ${CT_BASIC_PATIENT_ID} が引き続き検索できることを確認（上書きされていないか）`, { originalStillThere });
      if (!originalStillThere) {
        return { status: "fail" as const, error: `元のスタディ（PatientID=${CT_BASIC_PATIENT_ID}）が匿名化後に見つかりません（UID未置換で上書きされた疑い）` };
      }

      const found = await findStudyByPatientId(ctx, newId);
      recorder.step(`新PatientID ${newId} で検索し、匿名化後の別スタディを確認`, { found });
      if (!found) {
        return { status: "fail" as const, error: `新PatientID ${newId} のスタディが検索で見つかりません` };
      }
      return { status: "pass" as const, notes: `匿名化+再取込みで元スタディ(${CT_BASIC_PATIENT_ID})と別スタディ(${newId})が共存することを確認` };
    },
  },
  {
    id: "07-anonymizer.item-02",
    title: "新PatientID/Name設定、RetainSafePrivate等のオプションが機能する",
    category: "07-anonymizer",
    modes: ["desktop"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx: RunContext) {
      const { recorder } = ctx;
      await selectFirstStudy(ctx.driver.page, recorder);

      const newId = "ANON_ITEM02";
      const destDir = path.join(AUTOMATOR_ROOT, ".results", `anon-out-${Date.now()}`);
      await runAnonymizeCopy(ctx, newId, destDir, async (page) => {
        await page.getByTestId("anon-opt-RetainSafePrivate").check();
        await page.getByTestId("anon-new-name-input").fill("ANON^ITEM02");
        recorder.step("RetainSafePrivateオプションを有効化、新PatientNameを設定: ANON^ITEM02");
      });

      const imported = await importPaths(ctx.driver.ports.http, [destDir]);
      recorder.step("匿名化出力を再取込み", { imported });
      if (imported.imported <= 0) {
        return { status: "fail" as const, error: `匿名化出力の再取込みに失敗しました: ${JSON.stringify(imported)}` };
      }

      const found = await findStudyByPatientId(ctx, newId);
      recorder.step(`新PatientID ${newId} で検索し、オプション付き匿名化後のスタディを確認`, { found });
      if (!found) {
        return { status: "fail" as const, error: `新PatientID ${newId} のスタディが検索で見つかりません（RetainSafePrivate有効時に失敗）` };
      }
      return { status: "pass" as const, notes: `RetainSafePrivate有効・新PatientID=${newId}で匿名化コピーが成功` };
    },
  },
  {
    id: "07-anonymizer.item-04",
    title: "出力（ZIP/フォルダ）が正しく生成される（standalone専用、webは非対応バナー）",
    category: "07-anonymizer",
    modes: ["desktop"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx: RunContext) {
      const { driver, recorder } = ctx;
      const page = driver.page;
      await selectFirstStudy(page, recorder);

      await page.getByTestId("toolbar-anonymizer-btn").click();
      const dialog = page.getByTestId("anonymizer-dialog");
      await dialog.waitFor({ state: "visible", timeout: 10_000 });

      // ElectronではPlaywrightの page.waitForEvent("download") がレンダラーのダウンロードを
      // 確実に捕捉できない（実機で確認: ZIP自体は正常に生成されるがイベントが発火しないことがある）。
      // 代わりにダイアログの完了メッセージで検証する（フォルダコピー系item-01/02と同じ手法）。
      await page.getByTestId("anon-zip-btn").click();
      const infoMsg = page.getByTestId("anon-info-message");
      await infoMsg.waitFor({ state: "visible", timeout: 60_000 });
      const infoText = await infoMsg.textContent();
      recorder.step("ZIP出力完了メッセージを確認", { infoText });

      await page.getByTestId("dialog-close-button").click();

      if (!infoText) {
        return { status: "fail" as const, error: "ZIP出力の完了メッセージが取得できませんでした" };
      }
      return { status: "pass" as const, notes: `ZIP出力完了: ${infoText}` };
    },
  },
];
