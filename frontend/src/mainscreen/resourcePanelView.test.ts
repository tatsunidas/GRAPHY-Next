// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { contactUrl, isSafeResourceUrl, loadOpen, sanitizeFacilityConfig, saveOpen } from "./resourcePanelView";

afterEach(() => vi.unstubAllGlobals());

describe("isSafeResourceUrl", () => {
  it("https と mailto だけ", () => {
    expect(isSafeResourceUrl("https://intra.example.org/a?b=1#c")).toBe(true);
    expect(isSafeResourceUrl("HTTPS://intra.example.org/")).toBe(true);
    expect(isSafeResourceUrl("mailto:it@example.org?subject=x")).toBe(true);
  });
  it("負例: http・javascript・file・data・相対・ホストなし・空白や制御文字・巨大・文字列でない", () => {
    for (const bad of ["http://a.example/", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "//a.example/", "/rel", "https://", "https:///x", "mailto:", "https://a b.example/", "https://a.example/\u0000", "ftp://a.example/", " https://a.example/", "https://a.example/".padEnd(2001, "x")]) {
      expect(isSafeResourceUrl(bad), bad).toBe(false);
    }
    expect(isSafeResourceUrl(null)).toBe(false);
    expect(isSafeResourceUrl(42)).toBe(false);
  });
});

const raw = {
  title: "T", updatedAt: "2026-11-18", contact: "mailto:a@example.org",
  groups: [
    { id: "g", title: "G", items: [
      { id: "g.0", type: "link", title: "ok", url: "https://a.example/", note: "n" },
      { id: "g.1", type: "link", title: "bad", url: "javascript:alert(1)" },
      { id: "g.2", type: "card", title: "card", body: "本文", url: "http://insecure.example/" },
      { id: "g.3", type: "image", title: "x" },
      { type: "link", title: "no id", url: "https://a.example/" },
    ], groups: [{ id: "h", title: "H", items: [], groups: [] }, "not-a-group", { title: "no id" }] },
    { id: "", title: "empty id" },
    42,
  ],
};

describe("sanitizeFacilityConfig（画面側の再検証）", () => {
  it("安全でないリンク・形の違う項目・グループは捨て、安全なものは残す", () => {
    const c = sanitizeFacilityConfig(raw)!;
    expect(c.groups.map((g) => g.id)).toEqual(["g"]);
    const g = c.groups[0];
    expect(g.items.map((i) => i.id)).toEqual(["g.0", "g.2"]); // javascript: のリンク・不明な種類・id なしは落ちる
    expect(g.items[0].url).toBe("https://a.example/");
    expect(g.items[1].type).toBe("card");
    expect(g.items[1].url).toBeNull(); // カードの http: のリンクは出さない
    expect(g.groups.map((x) => x.id)).toEqual(["h"]);
    expect(c.contact).toBe("mailto:a@example.org");
  });
  it("負例: groups が無い・オブジェクトでない → null。連絡先が mailto でなければ捨てる", () => {
    expect(sanitizeFacilityConfig(null)).toBeNull();
    expect(sanitizeFacilityConfig({})).toBeNull();
    expect(sanitizeFacilityConfig({ groups: "x" })).toBeNull();
    expect(sanitizeFacilityConfig({ groups: [], contact: "https://a.example/" })!.contact).toBeNull();
  });
});

describe("contactUrl", () => {
  it("件名が無ければ足し、あれば触らない", () => {
    expect(contactUrl("mailto:a@example.org", "資料パネル")).toBe("mailto:a@example.org?subject=%E8%B3%87%E6%96%99%E3%83%91%E3%83%8D%E3%83%AB");
    expect(contactUrl("mailto:a@example.org?subject=x", "y")).toBe("mailto:a@example.org?subject=x");
  });
});

describe("開閉の状態（localStorage）", () => {
  it("保存して読み戻せる。既定は空（すべて閉じる）", () => {
    localStorage.clear();
    expect(loadOpen().size).toBe(0);
    saveOpen(new Set(["a", "b"]));
    expect([...loadOpen()].sort()).toEqual(["a", "b"]);
  });
  it("負例: 壊れた値・localStorage が例外を投げても、既定（空）で動く", () => {
    localStorage.setItem("graphy.facility.open", "{not json");
    expect(loadOpen().size).toBe(0);
    localStorage.setItem("graphy.facility.open", JSON.stringify([1, "x", null]));
    expect([...loadOpen()]).toEqual(["x"]);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(loadOpen().size).toBe(0);
    expect(() => saveOpen(new Set(["a"]))).not.toThrow();
  });
});
