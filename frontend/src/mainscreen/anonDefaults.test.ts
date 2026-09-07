/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { CLEAN_OPTS, DEFAULT_ANON_OPTIONS, RETAIN_OPTS, sanitizeAnonOptions, toggleAnonOption } from "./anonDefaults";

describe("Anonymizer の既定オプション", () => {
  it("Retain 系は Modified Dates 以外すべて既定 ON", () => {
    const expected = RETAIN_OPTS.filter(
      (o) => o !== "RetainLongitudinalTemporalInformationModifiedDates",
    );
    expect([...DEFAULT_ANON_OPTIONS].sort()).toEqual([...expected].sort());
    expect(DEFAULT_ANON_OPTIONS).toHaveLength(6);
  });

  it("Clean 系は 1 つも既定 ON にしない（画素・記述の破壊は明示的な操作に限る）", () => {
    for (const o of CLEAN_OPTS) {
      expect(DEFAULT_ANON_OPTIONS).not.toContain(o);
    }
  });

  it("日付の 2 つを同時に既定 ON にしない", () => {
    // 両方 ON にすると engine 側で Modified Dates の C が Full Dates の K を上書きし、
    // StudyDate が 20260101 → 20000101 に潰れる（2026-08-20 実測）。「保持」の意図と真逆になる。
    const both =
      DEFAULT_ANON_OPTIONS.includes("RetainLongitudinalTemporalInformationFullDates") &&
      DEFAULT_ANON_OPTIONS.includes("RetainLongitudinalTemporalInformationModifiedDates");
    expect(both).toBe(false);
    expect(DEFAULT_ANON_OPTIONS).toContain("RetainLongitudinalTemporalInformationFullDates");
  });

  it("患者の直接識別子を保持するオプションは存在しない（既定 ON が氏名/ID を残さないことの担保）", () => {
    // Retain 系はいずれも「装置・施設・患者特性・日付・UID・safe private」に限られ、
    // PatientName/PatientID は engine が常に D（置換）で処理する。
    for (const o of DEFAULT_ANON_OPTIONS) {
      expect(o.startsWith("Retain")).toBe(true);
    }
  });
});

/**
 * 日付オプションの排他。
 *
 * 🔴 なぜ書いたか: 既存テストは **DEFAULT_ANON_OPTIONS の中身だけ**を見ており、
 * 「利用者が手で両方 ON にする」「research プロファイルを押す」経路を素通りしていた。
 * 両方 ON にすると加工(C)が保持(K)に勝ち、日付が 20000101 に潰れる（2026-08-20 実測）。
 */
describe("日付オプションの排他", () => {
  const FULL = "RetainLongitudinalTemporalInformationFullDates" as const;
  const MOD = "RetainLongitudinalTemporalInformationModifiedDates" as const;

  it("ModifiedDates を ON にすると FullDates が OFF になる", () => {
    const r = toggleAnonOption(new Set([FULL]), MOD);
    expect(r.has(MOD)).toBe(true);
    expect(r.has(FULL)).toBe(false);
  });

  it("FullDates を ON にすると ModifiedDates が OFF になる", () => {
    const r = toggleAnonOption(new Set([MOD]), FULL);
    expect(r.has(FULL)).toBe(true);
    expect(r.has(MOD)).toBe(false);
  });

  it("両方 OFF は有効な選択として許す（Basic Profile の日付削除）", () => {
    const r = toggleAnonOption(new Set([FULL]), FULL);
    expect(r.has(FULL)).toBe(false);
    expect(r.has(MOD)).toBe(false);
  });

  it("日付以外のオプションは互いに影響しない", () => {
    const r = toggleAnonOption(new Set(["RetainUIDs", FULL]), "RetainDeviceIdentity");
    expect(r.has("RetainUIDs")).toBe(true);
    expect(r.has(FULL)).toBe(true);
    expect(r.has("RetainDeviceIdentity")).toBe(true);
  });

  it("プロファイルに両方入っていたら ModifiedDates を落とす", () => {
    const { options, dropped } = sanitizeAnonOptions([FULL, MOD, "RetainUIDs"]);
    expect(options.has(FULL)).toBe(true);
    expect(options.has(MOD)).toBe(false);
    expect(options.has("RetainUIDs")).toBe(true);
    expect(dropped).toEqual([MOD]);
  });

  it("片方だけのプロファイルは何も直さない", () => {
    const { options, dropped } = sanitizeAnonOptions([MOD]);
    expect(options.has(MOD)).toBe(true);
    expect(dropped).toEqual([]);
  });

  it("既定は両方 ON にならない", () => {
    const d = new Set(DEFAULT_ANON_OPTIONS);
    expect(d.has(FULL) && d.has(MOD)).toBe(false);
  });
});
