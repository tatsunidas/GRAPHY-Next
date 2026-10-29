/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { Series, Study } from "../api";
import { normalizeMsg, notFoundText, pickSeries, readFlags, resolveStudies, toFilters } from "./externalOpenLogic";

const study = (over: Partial<Study>): Study => ({
  studyInstanceUid: "1.2.3", patientId: "P1", patientName: "A", studyDate: "20260131", studyDescription: null, modality: "CT", numberOfInstances: 1,
  ...over,
} as Study);
const series = (uid: string): Series => ({ seriesInstanceUid: uid } as Series);

describe("normalizeMsg", () => {
  it("正しい要求はそのまま通る", () => {
    expect(normalizeMsg({ ok: true, req: { studyInstanceUid: "1.2.3", seriesInstanceUid: "1.2.3.4" } }))
      .toEqual({ ok: true, req: { studyInstanceUid: "1.2.3", seriesInstanceUid: "1.2.3.4" } });
  });
  it("main が不正と判断したものは、その理由のまま失敗", () => {
    expect(normalizeMsg({ ok: false, reason: "形式が違います" })).toEqual({ ok: false, reason: "形式が違います" });
  });
  it("形が壊れていれば開かない（null・文字列・UID の文字種違反）", () => {
    expect(normalizeMsg(null).ok).toBe(false);
    expect(normalizeMsg("x").ok).toBe(false);
    expect(normalizeMsg({ ok: true, req: { studyInstanceUid: "../x" } }).ok).toBe(false);
    expect(normalizeMsg({ ok: true, req: {} }).ok).toBe(false);
    expect(normalizeMsg({ ok: true, req: { patientId: "P" } }).ok).toBe(false); // 検査日が無い
  });
});

describe("toFilters", () => {
  it("UID があれば UID だけ", () => {
    expect(toFilters({ studyInstanceUid: "1.2", patientId: "P", studyDate: "20260101" })).toEqual({ studyInstanceUid: "1.2" });
  });
  it("患者 ID＋日付は、その日だけに絞る", () => {
    expect(toFilters({ patientId: "P", studyDate: "20260101" })).toEqual({ patientId: "P", studyDateFrom: "20260101", studyDateTo: "20260101" });
  });
});

describe("resolveStudies", () => {
  it("UID 指定: 一致が 1 件なら開く、無ければ none", () => {
    expect(resolveStudies({ studyInstanceUid: "1.2.3" }, [study({})])).toEqual({ kind: "one", study: study({}) });
    expect(resolveStudies({ studyInstanceUid: "9.9" }, [study({})])).toEqual({ kind: "none" });
    expect(resolveStudies({ studyInstanceUid: "9.9" }, [])).toEqual({ kind: "none" });
  });
  it("患者 ID は完全一致（部分一致で別の患者を巻き込まない）", () => {
    const r = resolveStudies({ patientId: "P1", studyDate: "20260131" }, [
      study({ studyInstanceUid: "1.1", patientId: "P1" }),
      study({ studyInstanceUid: "1.2", patientId: "P10" }), // 部分一致で返ってきた別の患者
    ]);
    expect(r).toEqual({ kind: "one", study: expect.objectContaining({ studyInstanceUid: "1.1" }) });
  });
  it("日付は、ハイフンつきの表記でも比べられる", () => {
    const r = resolveStudies({ patientId: "P1", studyDate: "20260131" }, [study({ studyDate: "2026-01-31" })]);
    expect(r.kind).toBe("one");
  });
  it("同じ条件が複数なら、選ばせる（黙って先頭を開かない）", () => {
    const r = resolveStudies({ patientId: "P1", studyDate: "20260131" }, [study({ studyInstanceUid: "1.1" }), study({ studyInstanceUid: "1.2" })]);
    expect(r.kind).toBe("many");
    if (r.kind === "many") expect(r.studies).toHaveLength(2);
  });
  it("日付が違うものは含めない", () => {
    expect(resolveStudies({ patientId: "P1", studyDate: "20260101" }, [study({})])).toEqual({ kind: "none" });
  });
});

describe("pickSeries", () => {
  it("指定があればそのシリーズ、無ければ先頭、空なら未指定", () => {
    expect(pickSeries({ seriesInstanceUid: "2" }, [series("1"), series("2")])).toEqual({ kind: "series", series: series("2") });
    expect(pickSeries({}, [series("1"), series("2")])).toEqual({ kind: "series", series: series("1") });
    expect(pickSeries({}, [])).toEqual({ kind: "series", series: undefined });
  });
  it("指定したシリーズが無ければ missing（黙って別のシリーズを開かない）", () => {
    expect(pickSeries({ seriesInstanceUid: "9" }, [series("1")])).toEqual({ kind: "missing" });
  });
});

describe("notFoundText / readFlags", () => {
  it("見つからない文言に UID を含める", () => {
    expect(notFoundText({ studyInstanceUid: "1.2.3" })).toEqual({ key: "externalOpen.notFound.uid", params: { uid: "1.2.3" } });
    expect(notFoundText({ patientId: "P1", studyDate: "20260131" }))
      .toEqual({ key: "externalOpen.notFound.patient", params: { patientId: "P1", studyDate: "20260131" } });
  });
  it("受け付けるは既定オン、確認は既定オフ", () => {
    expect(readFlags({})).toEqual({ enabled: true, confirm: false });
    expect(readFlags({ "external.openEnabled": "false", "external.openConfirm": "true" })).toEqual({ enabled: false, confirm: true });
  });
});
