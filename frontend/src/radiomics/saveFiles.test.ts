// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutputFile } from "./datasetCsv";
import { saveFiles } from "./saveFiles";

const files: OutputFile[] = [
  { name: "a.csv", text: "x,y\r\n1,é\r\n", mime: "text/csv" },
  { name: "b.json", text: "{}", mime: "application/json" },
];
const w = window as unknown as { graphyDesktop?: unknown };

beforeEach(() => {
  delete w.graphyDesktop;
});
afterEach(() => {
  delete w.graphyDesktop;
  vi.restoreAllMocks();
});

describe("saveFiles", () => {
  it("Electron: フォルダを 1 回だけ選び、全ファイルを UTF-8 で書き、実際の名前（連番つき）を返す", async () => {
    const pick = vi.fn(async () => ({ ok: true as const, path: "/out" }));
    const written: { dir: string; name: string; bytes: Uint8Array }[] = [];
    const write = vi.fn(async (p: { dir: string; name: string; bytes: Uint8Array }) => {
      written.push(p);
      // main は同名があると「名前 (2).拡張子」にする
      return { ok: true as const, filePath: p.name === "a.csv" ? "/out/a (2).csv" : `/out/${p.name}` };
    });
    w.graphyDesktop = { pluginPickDirectory: pick, pluginWriteIntoDirectory: write };
    const r = await saveFiles(files);
    expect(pick).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ ok: true, names: ["a (2).csv", "b.json"] });
    expect(written.map((x) => x.dir)).toEqual(["/out", "/out"]);
    expect(new TextDecoder().decode(written[0].bytes)).toBe(files[0].text);
  });

  it("Electron: フォルダ選択を取り消したら何も書かない", async () => {
    const write = vi.fn();
    w.graphyDesktop = { pluginPickDirectory: async () => ({ ok: false, canceled: true }), pluginWriteIntoDirectory: write };
    const r = await saveFiles(files);
    expect(r).toEqual({ ok: false, canceled: true, names: [] });
    expect(write).not.toHaveBeenCalled();
  });

  it("Electron: 書き込みに失敗したら、そこで止めて、書けた分の名前とエラーを返す", async () => {
    let n = 0;
    w.graphyDesktop = {
      pluginPickDirectory: async () => ({ ok: true, path: "/out" }),
      pluginWriteIntoDirectory: async (p: { name: string }) => (n++ === 0 ? { ok: true, filePath: `/out/${p.name}` } : { ok: false, error: "EACCES" }),
    };
    expect(await saveFiles(files)).toEqual({ ok: false, names: ["a.csv"], error: "EACCES" });
  });

  it("ブラウザ（pluginPickDirectory が無い）: 従来どおりファイルごとにダウンロードする", async () => {
    const clicks: string[] = [];
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    });
    const r = await saveFiles(files);
    expect(clicks).toEqual(["a.csv", "b.json"]);
    expect(r).toEqual({ ok: true, names: ["a.csv", "b.json"] });
  });
});
