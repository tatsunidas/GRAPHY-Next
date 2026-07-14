import type { ChecklistItem } from "../../types.js";
import { importFixtureCategory } from "../../../fixtures/importFixtures.js";

export const importExportItems: ChecklistItem[] = [
  {
    id: "04-import-export.item-01",
    title: "ローカルDICOMファイル/フォルダのImportができる",
    category: "04-import-export",
    // standalone 専用 API(/api/import/paths, ローカルファイル読込)に依存するため desktop のみ。
    // web はPACS/DICOMweb経由のデータ投入になり、別itemとして web/ 側に実装する。
    modes: ["desktop"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx) {
      const { driver, recorder } = ctx;
      const result = await importFixtureCategory(driver.ports.http, "ct-basic");
      recorder.step("POST /api/import/paths で ct-basic フィクスチャを投入", { result });

      if (result.imported <= 0) {
        return {
          status: "fail" as const,
          error: `imported=0 (skipped=${result.skipped}, failed=${result.failed}, errors=${JSON.stringify(result.errors)})`,
        };
      }
      return { status: "pass" as const, notes: `imported=${result.imported}` };
    },
  },
];
