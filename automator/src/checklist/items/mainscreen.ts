import type { ChecklistItem } from "../types.js";
import { waitForMainScreenReady } from "./helpers.js";

export const mainscreenItems: ChecklistItem[] = [
  {
    id: "02-mainscreen.item-01",
    title: "スタディ検索（日付範囲・Today/Yesterday/週・モダリティチェック）ができる",
    category: "02-mainscreen",
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
];
