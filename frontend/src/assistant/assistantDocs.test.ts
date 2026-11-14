import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { searchDocs, splitDocs, tokenize } from "./docsIndex";

const dir = join(__dirname, "../../../docs");
const files = Object.fromEntries(
  readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => [f, readFileSync(join(dir, f), "utf8")]),
);
const chunks = splitDocs(files);
const opt = { k: 3, maxChars: 1500, minScore: 2 };

describe("docsIndex", () => {
  it("splits by heading with the file name", () => {
    const c = splitDocs({ "a/x.md": "# T\nintro\n## S\nbody\n### deep\nmore" });
    expect(c.map((x) => x.heading)).toEqual(["T", "T › S"]);
    expect(c[1].text).toContain("### deep");
    expect(c[0].file).toBe("x.md");
  });
  it("tokenizes ascii words and CJK bigrams", () => {
    expect(tokenize("DICOM を開く")).toEqual(expect.arrayContaining(["dicom", "開く"]));
    expect(tokenize("a")).toEqual([]);
  });
  it("positive: relevant questions hit the right file", () => {
    const top = (q: string) => searchDocs(chunks, q, opt)[0]?.file;
    expect(top("2D ビューアでウィンドウ幅とレベルを調整するには")).toBe("viewer2d.md");
    expect(top("インストールして起動する手順")).toBe("install.md");
    expect(top("プラグインの作り方")).toBe("plugins.md");
  });
  it("negative: unrelated questions attach nothing", () => {
    // 「今日」はデータベースウィンドウの日付ボタンの語として資料にある。無関係な問いは、資料にない語だけで作る
    expect(searchDocs(chunks, "明日の天気と夕食のレシピを教えて", opt)).toEqual([]);
    expect(searchDocs(chunks, "", opt)).toEqual([]);
  });
  it("splits a long ## section at ### (heading gets the h3), keeps a short one whole", () => {
    const long = "# T\n## S\nintro\n### A\n" + "a".repeat(40) + "\n### B\n" + "b".repeat(40);
    const c = splitDocs({ "x.md": long }, 50);
    expect(c.map((x) => x.heading)).toEqual(["T › S", "T › S › A", "T › S › B"]);
    expect(c[1].text.startsWith("### A")).toBe(true);
    expect(splitDocs({ "x.md": long }, 1000).map((x) => x.heading)).toEqual(["T › S"]);
  });
  it("strips the {.ui} markers from chunk text", () => {
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((c) => c.text.includes("{.ui}"))).toBe(false);
    expect(splitDocs({ "x.md": "# T\n**検索**{.ui} を押す" })[0].text).toBe("**検索** を押す");
  });
  it("matches only on the text that is actually sent (words past maxChars do not score)", () => {
    const c = splitDocs({ "x.md": "# 長い\n" + "あ".repeat(60) + " 検索 解析\n", "y.md": "# 短い\n検索 解析\n" });
    const top = searchDocs(c, "検索と解析", { k: 3, maxChars: 30, minScore: 0.1 });
    expect(top.map((h) => h.file)).toEqual(["y.md"]);
  });
  it("how-to question: the procedure page is the top hit", () => {
    const hit = searchDocs(chunks, "患者名で探して、プレビューで画像を確認してから 2D Viewer で開く手順を教えて。", opt);
    expect(hit[0].file).toBe("howto.md");
    expect(hit.some((h) => h.file === "main-screen.md" || h.file === "howto.md")).toBe(true);
  });
  it("the docs exist (guards against a vacuous pass)", () => {
    expect(chunks.length).toBeGreaterThan(10);
  });
});
