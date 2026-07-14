import type { ChecklistItem } from "../../types.js";
import { resetDb } from "../../../backend/dbReset.js";
import { waitForMainScreenReady } from "./helpers.js";

export const dbAdminItems: ChecklistItem[] = [
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
