/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { Study } from "../api";
import type { EmrStatus } from "../settings/emrView";

/**
 * 「電子カルテの患者の、直近の検査を開く」の判定（純関数）。
 *
 * 開く検査は、**PACS の直近の検査**（backend が C-FIND で見つけて取り込む）であって、手元にある最新の検査ではない
 * （手元に古い検査だけがあるとき、それを「直近」として開くと、新しい検査があるのに古いほうが出てしまう）。
 * そのため、backend の取り込みの状態を見て決める。手元の索引は、PACS に無い・つながらないときの逃げ道にだけ使う。
 */
export type LatestDecision =
  | { kind: "wait" }
  /** 直近の検査が開ける（取り込み済み）。 */
  | { kind: "open"; studyUid: string }
  /** PACS に無い、または取れなかった。手元に検査があれば、その最新を開く。無ければ理由を出す。 */
  | { kind: "local"; reason: "not-found" | "error"; error: string | null }
  | { kind: "timeout" };

/**
 * @param status    `GET /api/emr/status` の応答（取れなければ null）
 * @param patientId 開きたい患者の ID
 * @param elapsedMs 待ち始めてからの時間
 * @param timeoutMs 待つ上限
 */
export function decideLatest(status: EmrStatus | null, patientId: string, elapsedMs: number, timeoutMs: number): LatestDecision {
  const f = status?.fetch;
  // 別の患者の状態（まだ自分の取り込みが始まっていない）は、待つ
  if (f && f.patientId === patientId) {
    if (f.latestReady && f.latestStudyUid) return { kind: "open", studyUid: f.latestStudyUid };
    if (f.state === "not-found") return { kind: "local", reason: "not-found", error: null };
    if (f.state === "error") return { kind: "local", reason: "error", error: f.error };
    if (f.state === "done" && !f.latestReady) return { kind: "local", reason: "error", error: f.error ?? "latest-not-ready" };
  }
  return elapsedMs >= timeoutMs ? { kind: "timeout" } : { kind: "wait" };
}

/** 手元の索引から、その患者（完全一致）の最新の検査。日付の新しい順で、日付が無いものは最後。 */
export function newestExact(studies: Study[], patientId: string): Study | null {
  const hits = studies.filter((s) => s.patientId === patientId);
  if (hits.length === 0) return null;
  const key = (s: Study) => (s.studyDate ?? "").replace(/-/g, "");
  return [...hits].sort((a, b) => key(b).localeCompare(key(a)))[0];
}
