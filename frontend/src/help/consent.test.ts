/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { CONSENT_VERSION, consentRecord, needsConsent } from "./consent";

describe("needsConsent", () => {
  it("現行版の記録があれば不要", () => {
    expect(needsConsent(consentRecord())).toBe(false);
    expect(needsConsent(JSON.stringify({ version: CONSENT_VERSION + 1 }))).toBe(false);
  });
  it("未設定・空・壊れた値・版の欠落や型違い・古い版は必要", () => {
    expect(needsConsent(undefined)).toBe(true);
    expect(needsConsent(null)).toBe(true);
    expect(needsConsent("")).toBe(true);
    expect(needsConsent("{oops")).toBe(true);
    expect(needsConsent("{}")).toBe(true);
    expect(needsConsent('{"version":"1"}')).toBe(true);
    expect(needsConsent("null")).toBe(true);
    expect(needsConsent(JSON.stringify({ version: 0 }))).toBe(true);
  });
  it("同意文の版を上げると、現行版で同意済みの記録が必要に戻る", () => {
    expect(needsConsent(consentRecord(), CONSENT_VERSION + 1)).toBe(true);
  });
  it("記録は版と ISO 日時を持つ", () => {
    const r = JSON.parse(consentRecord(new Date("2026-10-20T01:02:03Z")));
    expect(r).toEqual({ version: CONSENT_VERSION, acceptedAt: "2026-10-20T01:02:03.000Z" });
  });
});
