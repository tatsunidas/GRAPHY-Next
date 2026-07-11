import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const AUTOMATOR_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const FIXTURES_ROOT = path.join(AUTOMATOR_ROOT, "fixtures");
const MANIFEST_PATH = path.join(FIXTURES_ROOT, "manifest.yaml");

const FixtureCategorySchema = z.object({
  id: z.string(),
  dir: z.string(),
  minFiles: z.number().int().nonnegative(),
  description: z.string(),
});

const ManifestSchema = z.object({
  categories: z.array(FixtureCategorySchema),
});

export type FixtureCategory = z.infer<typeof FixtureCategorySchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

let cached: Manifest | null = null;

export function loadManifest(): Manifest {
  if (cached) return cached;
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`fixture manifest が見つかりません: ${MANIFEST_PATH}`);
  }
  const raw = parseYaml(fs.readFileSync(MANIFEST_PATH, "utf8"));
  cached = ManifestSchema.parse(raw);
  return cached;
}

export function getCategory(id: string): FixtureCategory {
  const manifest = loadManifest();
  const cat = manifest.categories.find((c) => c.id === id);
  if (!cat) {
    const known = manifest.categories.map((c) => c.id).join(", ");
    throw new Error(`未知の fixture カテゴリ: "${id}"。既知のカテゴリ: ${known}`);
  }
  return cat;
}

export function categoryDir(cat: FixtureCategory): string {
  return path.join(FIXTURES_ROOT, cat.dir);
}

/** カテゴリ配下の実データファイル一覧（README.md は除外）。 */
export function listCategoryFiles(cat: FixtureCategory): string[] {
  const dir = categoryDir(cat);
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "README.md") continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}
