import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * DICOM の日付を「YYYY-MM-DD」に自前で組み立てて**画面に出す**コードが残っていないことを見る
 * （書式の設定が効かなくなる）。検索欄の `<input type="date">` の値を作る関数は、表示ではないので許可する。
 */
const SRC = join(__dirname, "..");
const ALLOWED = new Set([
  "i18n/dateFormat.ts",
  "dbadmin/DbScopePicker.tsx", // <input type="date"> の値
  "qr/QrSearchBar.tsx", // 同上
  "mainscreen/SearchPanel.tsx", // 同上
  "mainscreen/seriesCondUtil.ts", // 同上
]);
const PATTERN = /slice\(0, ?4\)\}[-/]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("DICOM の日付の表示は dateFormat.ts を通す", () => {
  it("検出器が実在する（走査対象があり、許可の一覧に実際に当たるファイルがある）", () => {
    const files = walk(SRC).map((f) => relative(SRC, f));
    expect(files.length).toBeGreaterThan(100);
    const hits = files.filter((f) => PATTERN.test(readFileSync(join(SRC, f), "utf8")));
    expect(hits.length).toBeGreaterThan(0);
  });
  it("自前で組み立てた日付の表示が残っていない", () => {
    const hits = walk(SRC)
      .map((f) => relative(SRC, f))
      .filter((f) => !ALLOWED.has(f) && PATTERN.test(readFileSync(join(SRC, f), "utf8")));
    expect(hits).toEqual([]);
  });
});
