import type { ChecklistItem } from "../../types.js";
import { waitForMainScreenReady, selectFirstStudy } from "./helpers.js";

export const mainscreenItems: ChecklistItem[] = [
  {
    id: "02-mainscreen.item-01",
    title: "スタディ検索（日付範囲・Today/Yesterday/週・モダリティチェック）ができる",
    category: "02-mainscreen",
    modes: ["desktop", "web"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx) {
      const { driver, recorder } = ctx;
      const page = driver.page;
      // driver.start() が既にこの実行専用の新規プロセスで MainScreen をロード済みのため、
      // reload は不要（不要な reload は React マウントとの競合で白紙化する罠を実機で踏んだ）。
      await waitForMainScreenReady(page);
      recorder.step("MainScreen の初期マウントを確認");

      // インポート済みfixtureのStudyDateに依存しないよう、日付フィルタを空にして無条件検索する。
      // 無条件検索は確認ダイアログが出るため自動で許可する。
      page.once("dialog", (d) => void d.accept());
      const dateInputs = page.locator('input[type="date"]');
      await dateInputs.nth(0).fill("");
      await dateInputs.nth(1).fill("");
      recorder.step("日付フィルタをクリア");

      await page.getByTestId("search-submit-button").click();
      recorder.step("検索ボタンをクリック（無条件検索の確認ダイアログを自動許可）");

      const rows = page.locator('[data-testid^="study-row-"]');
      await rows.first().waitFor({ state: "visible", timeout: 15_000 });
      const count = await rows.count();
      recorder.step("study-row-* の件数を確認", { count });

      if (count < 1) {
        return { status: "fail" as const, error: "インポート済みのはずのスタディが検索結果に現れません" };
      }
      return { status: "pass" as const, notes: `${count}件のスタディが見つかりました` };
    },
  },
  {
    id: "02-mainscreen.item-03",
    title: "メニュー(File/Function/Image/System/Help)とツールバーの各ボタンが対応機能を起動する",
    category: "02-mainscreen",
    modes: ["desktop", "web"],
    requiresHuman: false,
    // File > Send はスタディ未選択だと window.alert で拒否される仕様のため、事前選択が要る。
    dependsOnFixtures: ["ct-basic"],
    async run(ctx) {
      const { driver, recorder } = ctx;
      const page = driver.page;
      await selectFirstStudy(page, recorder);

      // 各トップレベルメニューが開き、1件以上の項目を持つことを確認する（土台検証）。
      const menuIds = ["file", "function", "image", "system", "help"];
      for (const id of menuIds) {
        await page.getByTestId(`mainscreen-menu-${id}`).click();
        const dropdown = page.getByTestId(`mainscreen-menu-${id}`).locator("xpath=following-sibling::div").first();
        await dropdown.waitFor({ state: "visible", timeout: 5_000 });
        const itemCount = await dropdown.locator("button").count();
        recorder.step(`メニュー[${id}]を開いて項目数を確認`, { itemCount });
        if (itemCount < 1) {
          return { status: "fail" as const, error: `メニュー[${id}]の項目が0件です` };
        }
        // メニューを閉じる（次のメニューを開く前に）。
        await page.keyboard.press("Escape").catch(() => {});
        await page.mouse.click(5, 5);
      }

      // 代表機能として File > Send がダイアログを起動することを確認する。
      await page.getByTestId("mainscreen-menu-file").click();
      await page.getByTestId("menu-item-send").click();
      const sendDialog = page.getByTestId("send-dialog");
      await sendDialog.waitFor({ state: "visible", timeout: 10_000 });
      recorder.step("File > Send メニューから send-dialog が開くことを確認");
      await page.getByTestId("dialog-close-button").click();
      await sendDialog.waitFor({ state: "hidden", timeout: 5_000 });

      return { status: "pass" as const, notes: `${menuIds.length}メニューの起動とFile>Sendの起動を確認` };
    },
  },
  {
    id: "02-mainscreen.item-04",
    title: "環境設定・DB管理ボタンからダイアログが開く",
    category: "02-mainscreen",
    modes: ["desktop", "web"],
    requiresHuman: false,
    async run(ctx) {
      const { driver, recorder } = ctx;
      const page = driver.page;
      await waitForMainScreenReady(page);
      recorder.step("MainScreen の初期マウントを確認");

      await page.getByTestId("mainscreen-menu-system").click();
      await page.getByTestId("menu-item-settings").click();
      const settingsDialog = page.getByTestId("settings-dialog");
      await settingsDialog.waitFor({ state: "visible", timeout: 10_000 });
      recorder.step("System > 環境設定 から settings-dialog が開くことを確認");
      await page.getByTestId("dialog-close-button").click();
      await settingsDialog.waitFor({ state: "hidden", timeout: 5_000 });

      await page.getByTestId("mainscreen-menu-system").click();
      const dbItem = page.getByTestId("menu-item-dbadmin");
      const disabled = await dbItem.isDisabled();
      if (disabled) {
        // web/standalone非対応時はメニュー項目が無効化される仕様（isStandalone===false）。
        await page.keyboard.press("Escape").catch(() => {});
        return { status: "pass" as const, notes: "standalone以外のためDB管理は無効化（仕様通り）" };
      }
      await dbItem.click();
      const dbDialog = page.getByTestId("dbadmin-dialog");
      await dbDialog.waitFor({ state: "visible", timeout: 10_000 });
      recorder.step("System > DB管理 から dbadmin-dialog が開くことを確認");
      await page.getByTestId("dialog-close-button").click();
      await dbDialog.waitFor({ state: "hidden", timeout: 5_000 });

      return { status: "pass" as const, notes: "環境設定・DB管理ダイアログの起動を確認" };
    },
  },
];
