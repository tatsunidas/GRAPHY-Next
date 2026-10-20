/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { CatalogItem, PluginPreview } from "../plugins/pluginManagerApi";
import { checkAgainstEntry, filterRows, toRow } from "./pluginCatalogView";

const OFFICIAL = "98EA7C6BA2D50118";

function item(over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: "art", name: "Art of Imaging", repo: "tatsunidas/graphy-next-plugin-art",
    description: "画風変換", category: "ai", signerKeyId: OFFICIAL, minGraphy: "0.3.0",
    officialSigner: true, installed: null, ...over,
  };
}

function preview(over: Partial<PluginPreview> = {}): PluginPreview {
  return { id: "art", signature: "trusted", signerKeyId: OFFICIAL, ...over } as PluginPreview;
}

describe("toRow", () => {
  it("同梱は台帳の source.type=bundled から決まる", () => {
    const r = toRow(item({ installed: { version: "0.1.0", sourceType: "bundled", enabled: true, trust: "verified" } }));
    expect(r.tier).toBe("bundled");
    expect(r.officialConfirmed).toBe(true);
  });
  it("導入済みで verified なら公式（確定）", () => {
    const r = toRow(item({ installed: { version: "0.1.1", sourceType: "github", enabled: true, trust: "verified" } }));
    expect(r.tier).toBe("official");
    expect(r.officialConfirmed).toBe(true);
  });
  it("未導入で公式鍵の記載があれば公式だが確定ではない", () => {
    const r = toRow(item());
    expect(r.tier).toBe("official");
    expect(r.officialConfirmed).toBe(false);
  });
  it("索引が公式鍵を名乗っても、導入済みで verified でなければコミュニティ", () => {
    const r = toRow(item({ installed: { version: "0.1.1", sourceType: "file", enabled: true, trust: "local" } }));
    expect(r.tier).toBe("community");
    expect(r.officialConfirmed).toBe(false);
  });
  it("公式鍵でなければコミュニティ", () => {
    expect(toRow(item({ officialSigner: false, signerKeyId: "1111111111111111" })).tier).toBe("community");
  });
});

describe("filterRows", () => {
  const rows = [
    toRow(item()),
    toRow(item({ id: "vis-monai", name: "MONAI Bundle", repo: "tatsunidas/graphy-next-plugin-monai", description: null })),
    toRow(item({ id: "x", name: "Third", repo: "someone/x", description: "別の説明", officialSigner: false, signerKeyId: null })),
  ];
  it("空の検索語・全区分なら全部", () => {
    expect(filterRows(rows, { query: " ", tier: "all" })).toHaveLength(3);
  });
  it("名前・repo・説明に大文字小文字を無視して一致", () => {
    expect(filterRows(rows, { query: "monai", tier: "all" }).map((r) => r.item.id)).toEqual(["vis-monai"]);
    expect(filterRows(rows, { query: "画風", tier: "all" }).map((r) => r.item.id)).toEqual(["art"]);
    expect(filterRows(rows, { query: "SOMEONE/", tier: "all" }).map((r) => r.item.id)).toEqual(["x"]);
  });
  it("区分で絞れる", () => {
    expect(filterRows(rows, { query: "", tier: "community" }).map((r) => r.item.id)).toEqual(["x"]);
    expect(filterRows(rows, { query: "", tier: "official" })).toHaveLength(2);
  });
  it("該当なしは空", () => {
    expect(filterRows(rows, { query: "zzz", tier: "all" })).toEqual([]);
  });
});

describe("checkAgainstEntry", () => {
  it("正例: id・鍵・公式がすべて合えば null（大文字小文字は無視）", () => {
    expect(checkAgainstEntry(item(), preview())).toBeNull();
    expect(checkAgainstEntry(item({ signerKeyId: OFFICIAL.toLowerCase() }), preview())).toBeNull();
  });
  it("負例: id が違う", () => {
    expect(checkAgainstEntry(item(), preview({ id: "other" }))).toBe("idMismatch");
  });
  it("負例: 別の鍵で署名されている", () => {
    expect(checkAgainstEntry(item(), preview({ signerKeyId: "1111111111111111", signature: "first-use" }))).toBe("keyMismatch");
  });
  it("負例: 署名が剥がされている", () => {
    expect(checkAgainstEntry(item(), preview({ signature: "unsigned", signerKeyId: null }))).toBe("keyMismatch");
  });
  it("負例: 鍵 ID は合うが公式鍵として検証できていない", () => {
    expect(checkAgainstEntry(item(), preview({ signature: "first-use" }))).toBe("notTrusted");
  });
  it("鍵の記載が無い索引の行は鍵を問わない（コミュニティ）", () => {
    const i = item({ signerKeyId: null, officialSigner: false });
    expect(checkAgainstEntry(i, preview({ signature: "unsigned", signerKeyId: null }))).toBeNull();
  });
});
