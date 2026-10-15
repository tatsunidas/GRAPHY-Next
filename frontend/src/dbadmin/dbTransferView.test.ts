import { describe, expect, it } from "vitest";
import { hasInboxNews, inboxNewsKey, targetCandidates, transferReasonKey } from "./dbTransferView";
import { ja } from "../i18n/ja";
import { en } from "../i18n/en";

describe("dbTransferView", () => {
  it("理由コードは先頭の語で引く。未知は null（backend の文をそのまま出す）", () => {
    expect(transferReasonKey("target-is-current")).toBe("dbTransfer.reason.targetIsCurrent");
    expect(transferReasonKey("study-not-found: 1.2.3")).toBe("dbTransfer.reason.studyNotFound");
    expect(transferReasonKey("not-enough-space: 10 / 5")).toBe("dbTransfer.reason.notEnoughSpace");
    expect(transferReasonKey("DICOM ファイルが見つかりません: x")).toBeNull();
    for (const c of ["target-missing", "target-not-absolute", "target-not-found", "target-not-writable",
      "target-has-semicolon", "target-is-current", "target-not-db-folder", "not-enough-space",
      "study-not-found", "local-only"]) {
      const k = transferReasonKey(c)!;
      expect(ja[k], `ja ${k}`).toBeTruthy();
      expect(en[k], `en ${k}`).toBeTruthy();
    }
  });

  it("移し先の候補は、使用中でなく実在する DB だけ", () => {
    const rows = [
      { path: "/a", isDefault: true, exists: true, active: true },
      { path: "/b", isDefault: false, exists: true, active: false },
      { path: "/c", isDefault: false, exists: false, active: false },
    ];
    expect(targetCandidates(rows).map((r) => r.path)).toEqual(["/b"]);
  });

  it("取り込みが終わってから、結果か残骸があるときだけ知らせる", () => {
    const r = { id: "p1", mode: "copy" as const, sourceDbFolder: "/a", processedAt: "", imported: 1, skippedExisting: 0,
      failed: 0, errors: [], relatedInserted: 0, relatedSame: 0, conflicts: 0 };
    expect(hasInboxNews(null)).toBe(false);
    expect(hasInboxNews({ running: true, results: [r], stalePartials: [] })).toBe(false);
    expect(hasInboxNews({ running: false, results: [], stalePartials: [] })).toBe(false);
    expect(hasInboxNews({ running: false, results: [], stalePartials: ["x.partial"] })).toBe(true);
    expect(inboxNewsKey({ running: false, results: [r], stalePartials: ["x.partial"] })).toBe("p1,x.partial");
  });
});
