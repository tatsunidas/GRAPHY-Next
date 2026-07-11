import { loadManifest, categoryDir, listCategoryFiles, type FixtureCategory } from "./manifest.js";

export interface FixtureCheckResult {
  category: FixtureCategory;
  fileCount: number;
  ok: boolean;
}

export function checkCategory(cat: FixtureCategory): FixtureCheckResult {
  const fileCount = listCategoryFiles(cat).length;
  return { category: cat, fileCount, ok: fileCount >= cat.minFiles };
}

export function checkAll(categoryId?: string): FixtureCheckResult[] {
  const manifest = loadManifest();
  const categories = categoryId
    ? manifest.categories.filter((c) => c.id === categoryId)
    : manifest.categories;
  if (categoryId && categories.length === 0) {
    throw new Error(`未知の fixture カテゴリ: "${categoryId}"`);
  }
  return categories.map(checkCategory);
}

/** 不足があれば分かりやすいメッセージで例外を投げる。checklist item の前提チェックから直接呼ぶ想定。 */
export function requireFixtures(categoryIds: string[]): void {
  const manifest = loadManifest();
  const missing: string[] = [];
  for (const id of categoryIds) {
    const cat = manifest.categories.find((c) => c.id === id);
    if (!cat) {
      missing.push(`${id} (manifest.yaml に未定義)`);
      continue;
    }
    const result = checkCategory(cat);
    if (!result.ok) {
      missing.push(`${id} — ${categoryDir(cat)} に最低${cat.minFiles}ファイル必要（現在${result.fileCount}件）`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `fixture が不足しています:\n` + missing.map((m) => `  - ${m}`).join("\n") +
      `\n\nautomator/fixtures/<category>/ にサンプルデータを配置してください（automator/fixtures/<category>/README.md 参照）。`,
    );
  }
}

export function formatCheckReport(results: FixtureCheckResult[]): string {
  const lines = results.map((r) => {
    const status = r.ok ? "OK  " : "MISS";
    return `[${status}] ${r.category.id.padEnd(28)} ${r.fileCount}/${r.category.minFiles}件`;
  });
  return lines.join("\n");
}
