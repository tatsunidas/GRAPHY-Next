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
    expect(searchDocs(chunks, "今日の天気と夕食のレシピを教えて", opt)).toEqual([]);
    expect(searchDocs(chunks, "", opt)).toEqual([]);
  });
  it("the docs exist (guards against a vacuous pass)", () => {
    expect(chunks.length).toBeGreaterThan(10);
  });
});
