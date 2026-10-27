/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { Series, Study, StudyFilters } from "../api";

/** main（desktop/externalOpen.js）が解釈・検証した要求。型と形式はここでも確かめる（防御）。 */
export type ExternalReq = {
  studyInstanceUid?: string;
  seriesInstanceUid?: string;
  patientId?: string;
  studyDate?: string;
};

export type ExternalMsg = { ok: true; req: ExternalReq } | { ok: false; reason: string };

const UID_RE = /^[0-9.]{1,64}$/;

/** main から届いた値を、安全に ExternalMsg へ。形が合わなければ理由つきの失敗にする（何も開かない）。 */
export function normalizeMsg(raw: unknown): ExternalMsg {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "要求を読み取れません。" };
  const m = raw as { ok?: unknown; reason?: unknown; req?: unknown };
  if (m.ok !== true) return { ok: false, reason: typeof m.reason === "string" && m.reason ? m.reason : "要求が正しくありません。" };
  const r = (m.req ?? {}) as Record<string, unknown>;
  const req: ExternalReq = {};
  if (r.studyInstanceUid !== undefined) {
    if (typeof r.studyInstanceUid !== "string" || !UID_RE.test(r.studyInstanceUid)) return { ok: false, reason: "studyInstanceUid の形式が正しくありません。" };
    req.studyInstanceUid = r.studyInstanceUid;
  }
  if (r.seriesInstanceUid !== undefined) {
    if (typeof r.seriesInstanceUid !== "string" || !UID_RE.test(r.seriesInstanceUid)) return { ok: false, reason: "seriesInstanceUid の形式が正しくありません。" };
    req.seriesInstanceUid = r.seriesInstanceUid;
  }
  if (r.patientId !== undefined) {
    if (typeof r.patientId !== "string" || r.patientId === "") return { ok: false, reason: "patientId の形式が正しくありません。" };
    req.patientId = r.patientId;
  }
  if (r.studyDate !== undefined) {
    if (typeof r.studyDate !== "string" || !/^\d{8}$/.test(r.studyDate)) return { ok: false, reason: "studyDate の形式が正しくありません。" };
    req.studyDate = r.studyDate;
  }
  if (!req.studyInstanceUid && !(req.patientId && req.studyDate)) {
    return { ok: false, reason: "検査を指定してください（studyInstanceUid、または patientId と studyDate）。" };
  }
  return { ok: true, req };
}

/** 検査を探す条件。UID があれば UID だけ（他の条件は無視される）。患者 ID＋日付なら、その日の同じ患者 ID（部分一致なので、後で完全一致に絞る）。 */
export function toFilters(req: ExternalReq): StudyFilters {
  if (req.studyInstanceUid) return { studyInstanceUid: req.studyInstanceUid };
  return { patientId: req.patientId, studyDateFrom: req.studyDate, studyDateTo: req.studyDate };
}

const digits = (s: string | null | undefined) => (s ?? "").replace(/-/g, "");

export type Resolution =
  | { kind: "none" }
  | { kind: "one"; study: Study }
  | { kind: "many"; studies: Study[] };

/**
 * 検索結果から、開く検査を決める。UID 指定は UID が一致するものだけ。患者 ID＋日付は、患者 ID が**完全一致**し日付も一致するものだけ
 * （検索は部分一致なので、別の患者を巻き込まない）。1 件ならそれ、複数なら選ばせる（黙って先頭を開かない）。
 */
export function resolveStudies(req: ExternalReq, studies: Study[]): Resolution {
  const hits = studies.filter((s) =>
    req.studyInstanceUid
      ? s.studyInstanceUid === req.studyInstanceUid
      : s.patientId === req.patientId && digits(s.studyDate) === req.studyDate,
  );
  if (hits.length === 0) return { kind: "none" };
  if (hits.length === 1) return { kind: "one", study: hits[0] };
  return { kind: "many", studies: hits };
}

export type SeriesPick = { kind: "series"; series: Series | undefined } | { kind: "missing" };

/** 開くシリーズ。指定があればそれ（無ければ「見つからない」）、指定が無ければ先頭（シリーズが無ければ未指定）。 */
export function pickSeries(req: ExternalReq, list: Series[]): SeriesPick {
  if (req.seriesInstanceUid) {
    const s = list.find((x) => x.seriesInstanceUid === req.seriesInstanceUid);
    return s ? { kind: "series", series: s } : { kind: "missing" };
  }
  return { kind: "series", series: list[0] };
}

/** 画面に出す「見つかりません」の文言の i18n キーと値。 */
export function notFoundText(req: ExternalReq): { key: string; params: Record<string, string> } {
  if (req.studyInstanceUid) return { key: "externalOpen.notFound.uid", params: { uid: req.studyInstanceUid } };
  return { key: "externalOpen.notFound.patient", params: { patientId: req.patientId ?? "", studyDate: req.studyDate ?? "" } };
}

/** 設定値（文字列）の読み取り。受け付けるは既定オン、確認は既定オフ。 */
export function readFlags(settings: Record<string, string | undefined>): { enabled: boolean; confirm: boolean } {
  const on = (v: string | undefined, dflt: boolean) => (v === undefined || v === "" ? dflt : v === "true");
  return { enabled: on(settings["external.openEnabled"], true), confirm: on(settings["external.openConfirm"], false) };
}
