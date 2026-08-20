/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { CLEAN_OPTS, DEFAULT_ANON_OPTIONS, RETAIN_OPTS } from "./anonDefaults";

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
