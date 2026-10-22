/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { Study, StudyFilters } from "../api";

// シリーズ抽出の「対象を絞る」まわりの純ロジック（画面から切り離してテストする）。

/** スタディの一覧（チェックで個別に外せる）を出す上限。超えたら絞り込みを足してもらい、条件全体を対象にする。 */
export const LIST_CAP = 2000;
/** 探索するシリーズ数がこれを超えたら「時間がかかる」と知らせる。 */
export const LARGE_SERIES = 3000;
/** 結果表に描画する行の上限（CSV には全件）。 */
export const RESULT_ROWS_CAP = 1000;

/** 対象の指定: スタディ UID の明示か、絞り込み条件（サーバーで解決）。 */
export interface ScopeSpec {
  studyUids?: string[];
  filters?: StudyFilters;
}

/** 空欄を捨てた絞り込み条件。全部空なら undefined（＝DB 全体）。 */
export function cleanFilters(f: StudyFilters): StudyFilters | undefined {
  const out: StudyFilters = {};
  for (const [k, v] of Object.entries(f)) {
    const t = typeof v === "string" ? v.trim() : v;
    if (t) (out as Record<string, string>)[k] = t as string;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface PatientGroup {
  patientId: string;
  patientName: string;
  studies: Study[];
}

/** 患者ごとにまとめる（患者 ID 順。スタディは検査日の新しい順）。 */
export function groupByPatient(studies: Study[]): PatientGroup[] {
  const m = new Map<string, PatientGroup>();
  for (const s of studies) {
    const g = m.get(s.patientId) ?? { patientId: s.patientId, patientName: s.patientName ?? "", studies: [] };
    g.studies.push(s);
    m.set(s.patientId, g);
  }
  const out = [...m.values()].sort((a, b) => a.patientId.localeCompare(b.patientId));
  for (const g of out) g.studies.sort((a, b) => (b.studyDate ?? "").localeCompare(a.studyDate ?? ""));
  return out;
}

/** 患者行のチェック状態。 */
export function patientState(g: PatientGroup, excluded: ReadonlySet<string>): "all" | "some" | "none" {
  const off = g.studies.filter((s) => excluded.has(s.studyInstanceUid)).length;
  if (off === 0) return "all";
  return off === g.studies.length ? "none" : "some";
}

export function toggleStudy(excluded: ReadonlySet<string>, uid: string): Set<string> {
  const n = new Set(excluded);
  if (n.has(uid)) n.delete(uid);
  else n.add(uid);
  return n;
}

/** 患者行を押したとき: 全部入っていれば全部外す、そうでなければ全部入れる。 */
export function togglePatient(excluded: ReadonlySet<string>, g: PatientGroup): Set<string> {
  const n = new Set(excluded);
  if (patientState(g, excluded) === "all") for (const s of g.studies) n.add(s.studyInstanceUid);
  else for (const s of g.studies) n.delete(s.studyInstanceUid);
  return n;
}

/**
 * 実行時の対象。一覧を出していて 1 件でも外してあれば UID の明示、そうでなければ条件（サーバーで解決）。
 * 一覧が上限を超えていて出せないとき（studies=null）も条件全体。
 */
export function buildScope(filters: StudyFilters, studies: Study[] | null, excluded: ReadonlySet<string>): ScopeSpec {
  if (studies && excluded.size > 0) {
    return { studyUids: studies.map((s) => s.studyInstanceUid).filter((u) => !excluded.has(u)) };
  }
  return { filters: cleanFilters(filters) ?? {} };
}

/** 残り時間の目安（秒）。処理が進んでいない・始めて間もないときは当てにならないので null。 */
export function etaSeconds(elapsedMs: number, processed: number, total: number): number | null {
  if (total <= 0 || processed <= 0 || processed >= total) return null;
  if (elapsedMs < 2000 || processed / total < 0.03) return null;
  return Math.round(((elapsedMs / processed) * (total - processed)) / 1000);
}

/** 「約 45 秒」「約 3 分」。 */
export function formatEta(sec: number): { unit: "sec" | "min"; n: number } {
  return sec < 90 ? { unit: "sec", n: Math.max(1, sec) } : { unit: "min", n: Math.round(sec / 60) };
}

export const isLargeScope = (series: number) => series > LARGE_SERIES;
