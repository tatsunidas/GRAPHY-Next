import type { Page } from "@playwright/test";
import type { ChecklistItem, RunContext } from "../../types.js";
import { openFirstSeriesInViewer } from "../shared/helpers.js";

const CT_BASIC_PATIENT_ID = "HCC_001";

export const dbAdminNotifyItems: ChecklistItem[] = [
  {
    id: "03-db-admin.item-05",
    title: "編集中に別ウィンドウ（2D Viewer）でポップアップ通知が出る",
    category: "03-db-admin",
    // 別ウィンドウ(Electron BrowserWindow)を開くdesktop固有の導線(d.openViewer IPC)に依存するためdesktopのみ。
    modes: ["desktop"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx: RunContext) {
      const { driver, recorder } = ctx;
      const mainPage = driver.page;

      // 2D Viewerウィンドウを開く（対象スタディのコンテキストを引き継ぐ）。
      await openFirstSeriesInViewer(mainPage, recorder);
      const viewerPage: Page = await driver.waitForNewPage(
        () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
        (url) => url.includes("2dviewer"),
      );
      await viewerPage.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 15_000 });
      recorder.step("2D Viewerウィンドウを開き、シリーズのロードを確認");

      // メインウィンドウでDB管理ダイアログを開き、当該スタディのシリーズを削除する（emitDbChangedが発火）。
      await mainPage.getByTestId("mainscreen-menu-system").click();
      await mainPage.getByTestId("menu-item-dbadmin").click();
      await mainPage.getByTestId("dbadmin-dialog").waitFor({ state: "visible", timeout: 10_000 });
      await mainPage.getByTestId("dbadmin-search-input").fill(CT_BASIC_PATIENT_ID);
      await mainPage.getByTestId("dbadmin-search-button").click();
      const patientExpand = mainPage.getByTestId(`dbadmin-patient-expand-${CT_BASIC_PATIENT_ID}`);
      await patientExpand.waitFor({ state: "visible", timeout: 10_000 });
      await patientExpand.click();
      const studyExpand = mainPage.locator('[data-testid^="dbadmin-study-expand-"]').first();
      await studyExpand.waitFor({ state: "visible", timeout: 10_000 });
      await studyExpand.click();
      await mainPage.locator('[data-testid^="dbadmin-series-checkbox-"]').first().waitFor({ state: "visible", timeout: 10_000 });
      recorder.step("メインウィンドウのDB管理ダイアログで対象スタディのシリーズ一覧を表示");

      mainPage.once("dialog", (d) => void d.accept());
      const deleteBtn = mainPage.locator('[data-testid^="dbadmin-series-delete-"]').first();
      await deleteBtn.click();
      recorder.step("メインウィンドウでシリーズを削除（確認ダイアログを自動許可）");

      // 2D Viewerウィンドウ側でポップアップ通知の出現を確認する。
      const notice = viewerPage.getByTestId("db-change-notice");
      const noticeShown = await notice.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false);
      recorder.step("2D Viewerウィンドウで db-change-notice の出現を確認", { noticeShown });

      if (noticeShown) {
        await viewerPage.getByTestId("db-change-notice-dismiss").click();
      }
      await viewerPage.close().catch(() => {});

      if (!noticeShown) {
        return { status: "fail" as const, error: "別ウィンドウ（2D Viewer）にDB変更のポップアップ通知が現れませんでした" };
      }
      return { status: "pass" as const, notes: "DB編集（シリーズ削除）で別ウィンドウにポップアップ通知が出ることを確認" };
    },
  },
];
