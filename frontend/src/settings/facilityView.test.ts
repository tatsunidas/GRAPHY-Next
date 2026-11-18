/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { ja } from "../i18n/ja";
import { en } from "../i18n/en";
import { canEditPath, countFacility, facilityErrorKey, type FacilityConfig } from "./facilityView";

const item = (id: string) => ({ id, type: "link" as const, title: id, url: "https://a.example/", note: null, body: null });
const cfg: FacilityConfig = {
  title: null, updatedAt: null, contact: null,
  groups: [
    { id: "a", title: "A", items: [item("a.0"), item("a.1")], groups: [{ id: "b", title: "B", items: [item("b.0")], groups: [] }] },
    { id: "c", title: "C", items: [], groups: [] },
  ],
};

describe("countFacility", () => {
  it("入れ子を含むグループと項目の合計", () => {
    expect(countFacility(cfg)).toEqual({ groups: 3, items: 3 });
    expect(countFacility(null)).toEqual({ groups: 0, items: 0 });
  });
});

describe("facilityErrorKey", () => {
  it("backend の理由コードは、ja・en の両方に文言がある（バックエンドが返しうる全コード）", () => {
    const codes = ["parse", "schema", "schema-version", "limit", "url", "id-duplicate", "not-a-file", "extension-not-allowed", "file-too-large", "decode-failed", "read-failed", "path-unreadable", "file-missing"];
    for (const c of codes) {
      const k = facilityErrorKey(c);
      expect(k).toBe(`facility.err.${c}`);
      expect((ja as Record<string, string>)[k], k).toBeTruthy();
      expect((en as Record<string, string>)[k], k).toBeTruthy();
    }
  });
  it("負例: 知らないコード・null は汎用の文言（コードをそのまま画面に出さない）", () => {
    expect(facilityErrorKey("something-new")).toBe("facility.err.unknown");
    expect(facilityErrorKey(null)).toBe("facility.err.unknown");
    expect((ja as Record<string, string>)["facility.err.unknown"]).toBeTruthy();
  });
});

describe("canEditPath", () => {
  it("standalone で、サーバー側の設定が無いときだけ変えられる", () => {
    expect(canEditPath("standalone", "none")).toBe(true);
    expect(canEditPath("standalone", "setting")).toBe(true);
    expect(canEditPath("standalone", "server")).toBe(false);
    expect(canEditPath("web", "none")).toBe(false);
    expect(canEditPath(undefined, "none")).toBe(false);
  });
});
