import { describe, expect, it } from "vitest";
import { badgeKeys, canForget, canSwitch, reasonKey } from "./dbFolderView";
import { ja } from "../i18n/ja";
import { en } from "../i18n/en";

const row = (o: Partial<{ path: string; isDefault: boolean; exists: boolean; active: boolean }>) => ({
  path: "/x",
  isDefault: false,
  exists: true,
  active: false,
  ...o,
});

describe("dbFolderView", () => {
  it("使用中・既定・見つからないの札", () => {
    expect(badgeKeys(row({ active: true, isDefault: true }))).toEqual([
      "settings.dbFolder.badge.active",
      "settings.dbFolder.badge.default",
    ]);
    expect(badgeKeys(row({ exists: false }))).toEqual(["settings.dbFolder.badge.missing"]);
  });

  it("切り替えは使用中でなく実在するものだけ。既定と使用中は一覧から外せない", () => {
    expect(canSwitch(row({}))).toBe(true);
    expect(canSwitch(row({ active: true }))).toBe(false);
    expect(canSwitch(row({ exists: false }))).toBe(false);
    expect(canForget(row({}))).toBe(true);
    expect(canForget(row({ isDefault: true }))).toBe(false);
    expect(canForget(row({ active: true }))).toBe(false);
  });

  it("理由コードは既知なら専用の文言、未知なら汎用。どの文言も ja と en の両方にある", () => {
    expect(reasonKey("has-semicolon")).toBe("settings.dbFolder.reason.hasSemicolon");
    expect(reasonKey("???")).toBe("settings.dbFolder.reason.unknown");
    expect(reasonKey(undefined)).toBe("settings.dbFolder.reason.unknown");
    const codes = ["not-absolute", "has-semicolon", "not-found", "not-directory", "not-writable",
      "not-a-db-folder", "not-empty", "in-use", "already-active", "???"];
    for (const c of codes) {
      const k = reasonKey(c);
      expect(ja[k as keyof typeof ja], `ja ${k}`).toBeTruthy();
      expect(en[k as keyof typeof en], `en ${k}`).toBeTruthy();
    }
  });
});
