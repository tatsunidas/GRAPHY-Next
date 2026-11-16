/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { Study } from "../api";
import type { EmrStatus } from "../settings/emrView";
import { decideLatest, newestExact } from "./emrOpenLogic";

const st = (fetch: Partial<EmrStatus["fetch"]>): EmrStatus => ({
  enabled: true, valid: true, errors: [], autoOpen: true,
  file: { state: "ok", error: null, lastReadAt: 1 },
  patient: { id: "P2", seq: 2, changedAt: 1 },
  fetch: { state: "idle", patientId: null, found: 0, retrieved: 0, latestStudyUid: null, latestReady: false, error: null, ...fetch },
});
const study = (o: Partial<Study>): Study => ({ studyInstanceUid: "1.1", patientId: "P1", patientName: "A", studyDate: "20260101",
  studyDescription: null, modality: "CT", numberOfInstances: 1, ...o } as Study);

describe("decideLatest（PACS の直近の検査が開けるまで待つ）", () => {
  it("直近の検査が取れたら、その UID を開く", () => {
    expect(decideLatest(st({ state: "retrieving", patientId: "P1", latestStudyUid: "1.2.3", latestReady: true }), "P1", 100, 180_000))
      .toEqual({ kind: "open", studyUid: "1.2.3" });
  });
  it("🔴 別の患者の「取れた」では開かない（患者が切り替わった直後に、前の患者を開かない）", () => {
    const old = st({ state: "done", patientId: "P1", latestStudyUid: "1.2.3", latestReady: true });
    expect(decideLatest(old, "P2", 100, 180_000)).toEqual({ kind: "wait" });
    expect(decideLatest(old, "P2", 180_000, 180_000)).toEqual({ kind: "timeout" }); // 待ちきれなければ、開かずに時間切れ
  });
  it("探している・取り込み中（直近はまだ）は待つ。状態が取れなくても待つ", () => {
    expect(decideLatest(st({ state: "finding", patientId: "P1" }), "P1", 10, 1000)).toEqual({ kind: "wait" });
    expect(decideLatest(st({ state: "retrieving", patientId: "P1", latestStudyUid: "1.2.3", latestReady: false }), "P1", 10, 1000)).toEqual({ kind: "wait" });
    expect(decideLatest(null, "P1", 10, 1000)).toEqual({ kind: "wait" });
    expect(decideLatest(null, "P1", 1000, 1000)).toEqual({ kind: "timeout" });
  });
  it("PACS に無い・取れなかったら、手元に逃げる（理由つき）", () => {
    expect(decideLatest(st({ state: "not-found", patientId: "P1" }), "P1", 10, 1000)).toEqual({ kind: "local", reason: "not-found", error: null });
    expect(decideLatest(st({ state: "error", patientId: "P1", error: "find-failed:DROPPED" }), "P1", 10, 1000))
      .toEqual({ kind: "local", reason: "error", error: "find-failed:DROPPED" });
    // 完了したのに直近が開けない状態（直近だけ取れなかった）も、手元へ
    expect(decideLatest(st({ state: "done", patientId: "P1", latestReady: false, error: "latest-retrieve-failed" }), "P1", 10, 1000))
      .toEqual({ kind: "local", reason: "error", error: "latest-retrieve-failed" });
  });
});

describe("newestExact", () => {
  it("患者 ID が完全一致するものだけから、日付の最も新しい検査を選ぶ（部分一致の別の患者を巻き込まない）", () => {
    const list = [
      study({ studyInstanceUid: "a", patientId: "P1", studyDate: "2025-01-01" }),
      study({ studyInstanceUid: "b", patientId: "P1", studyDate: "2026-02-01" }),
      study({ studyInstanceUid: "c", patientId: "P10", studyDate: "2027-01-01" }), // 部分一致の別の患者
      study({ studyInstanceUid: "d", patientId: "P1", studyDate: null }),
    ];
    expect(newestExact(list, "P1")?.studyInstanceUid).toBe("b");
    expect(newestExact(list, "P9")).toBeNull();
    expect(newestExact([], "P1")).toBeNull();
  });
});
