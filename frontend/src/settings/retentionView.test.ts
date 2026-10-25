/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import {
  apiErrorKey,
  canApplyForm,
  configFromForm,
  formFromConfig,
  formatBytes,
  invalidFields,
  lowFreeWarning,
  noticeKind,
  protectedSummary,
  protectionKey,
  reasonKey,
  resultKey,
  sameConfig,
  splitWarnings,
  warningView,
  type RetentionForm,
  type RetentionRun,
} from "./retentionView";

const empty: RetentionForm = formFromConfig({ days: null, maxGb: null, minFreeGb: null });
const GB = 1024 ** 3;

describe("retentionView", () => {
  it("条件が 1 つも無いと適用できない（既定値は置かない）", () => {
    expect(empty).toEqual({ daysOn: false, days: "", maxOn: false, maxGb: "", freeOn: false, minFreeGb: "" });
    expect(canApplyForm(empty)).toBe(false);
  });

  it("オンの欄が空・0・負・非数だと誤り、オフの欄は検査しない", () => {
    expect(invalidFields({ ...empty, daysOn: true, days: "" })).toEqual(["days"]);
    expect(invalidFields({ ...empty, daysOn: true, days: "0" })).toEqual(["days"]);
    expect(invalidFields({ ...empty, daysOn: true, days: "-3" })).toEqual(["days"]);
    expect(invalidFields({ ...empty, daysOn: true, days: "1.5" })).toEqual(["days"]); // 日数は整数
    expect(invalidFields({ ...empty, maxOn: true, maxGb: "abc" })).toEqual(["maxGb"]);
    expect(invalidFields({ ...empty, freeOn: true, minFreeGb: "0" })).toEqual(["minFreeGb"]);
    expect(invalidFields({ ...empty, days: "zzz" })).toEqual([]);
  });

  it("正しい入力は適用でき、オフの欄は null になる", () => {
    const f = { ...empty, daysOn: true, days: "30", freeOn: true, minFreeGb: "50.5" };
    expect(canApplyForm(f)).toBe(true);
    expect(configFromForm(f)).toEqual({ days: 30, maxGb: null, minFreeGb: 50.5 });
    expect(configFromForm({ ...f, days: "x" })).toEqual({ days: null, maxGb: null, minFreeGb: 50.5 });
  });

  it("誤りが 1 つでもあれば適用できない", () => {
    expect(canApplyForm({ ...empty, daysOn: true, days: "30", maxOn: true, maxGb: "" })).toBe(false);
  });

  it("保存済みと同じ条件かを比べる", () => {
    expect(sameConfig({ days: 30, maxGb: null, minFreeGb: null }, { days: 30, maxGb: null, minFreeGb: null })).toBe(true);
    expect(sameConfig({ days: 30, maxGb: null, minFreeGb: null }, { days: 31, maxGb: null, minFreeGb: null })).toBe(false);
  });

  it("容量は 1024³ の GB で整形する", () => {
    expect(formatBytes(GB)).toBe("1.0 GB");
    expect(formatBytes(1.5 * GB)).toBe("1.5 GB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(2048)).toBe("2 KB");
  });

  it("コード → 文言キー。未知のコードは汎用", () => {
    expect(reasonKey("days")).toBe("retention.reason.days");
    expect(reasonKey("zzz")).toBe("retention.reason.unknown");
    expect(protectionKey("inUse")).toBe("retention.protect.inUse");
    expect(protectionKey("new")).toBe("retention.protect.unknown");
    expect(resultKey("partial")).toBe("retention.result.partial");
    expect(resultKey("???")).toBe("retention.result.unknown");
    expect(warningView("protected:3").key).toBe("retention.warn.protected");
    expect(warningView("aborted").key).toBe("retention.warn.aborted");
    expect(warningView("x").key).toBe("retention.warn.unknown");
    expect(splitWarnings("free, protected:2")).toEqual(["free", "protected:2"]);
    expect(splitWarnings(null)).toEqual([]);
  });

  it("保護の内訳は多い順で、0 件は出さない", () => {
    expect(protectedSummary({ roi: 1, lock: 3, report: 0 })).toEqual([
      { code: "lock", n: 3 },
      { code: "roi", n: 1 },
    ]);
  });

  it("空きの下限が最大の検査より小さいときだけ注意", () => {
    expect(lowFreeWarning(1, 2 * GB)).toBe(true);
    expect(lowFreeWarning(3, 2 * GB)).toBe(false);
    expect(lowFreeWarning(null, 2 * GB)).toBe(false);
    expect(lowFreeWarning(1, 0)).toBe(false);
  });

  it("backend のエラーを専用の文言に当てる", () => {
    expect(apiErrorKey("cache-mode-unsupported")).toBe("retention.err.cacheMode");
    expect(apiErrorKey("not-enabled")).toBe("retention.err.notEnabled");
    expect(apiErrorKey("running")).toBe("retention.err.running");
    expect(apiErrorKey("条件が 1 つも無いので有効にできません")).toBeNull();
  });

  it("知らせは、消した実行と、警告だけの実行で出し分ける", () => {
    const base: RetentionRun = {
      id: "a", at: 0, trigger: "manual", planned: 0, deleted: 0, partial: 0, failed: 0, skipped: 0,
      bytesFreed: 0, satisfied: true, warnings: null,
    };
    expect(noticeKind({ ...base, deleted: 2 })).toBe("deleted");
    expect(noticeKind({ ...base, partial: 1 })).toBe("deleted");
    expect(noticeKind({ ...base, failed: 1 })).toBe("warning");
    expect(noticeKind({ ...base, satisfied: false })).toBe("warning");
  });
});
