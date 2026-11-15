/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { QrProbeResult } from "../api";
import { en } from "../i18n/en";
import { ja } from "../i18n/ja";
import { filtersToMatchKeys } from "../qr/qrUtil";
import { compactProfile, presetOf } from "./FindProfileEditor";
import { bestFind, conclusion, isDefaultProfile, qrErrorMsg, reportText, rowViews, type Msg } from "./probeView";

function res(p: Partial<QrProbeResult> & Pick<QrProbeResult, "id" | "stage" | "verdict">): QrProbeResult {
  return {
    label: p.id, kind: null, status: null, errorComment: null, reason: null, count: null, returnedKeys: [],
    millis: 5, command: null, evidence: null, sampleStudyUid: null, adopt: null, ...p,
  };
}

const ECHO_OK = res({ id: "echo", stage: "echo", verdict: "ok", kind: "OK" });
const ECHO_NG = res({ id: "echo", stage: "echo", verdict: "ng", kind: "UNREACHABLE" });
const find = (id: string, verdict: QrProbeResult["verdict"], kind: string | null = null, adopt: QrProbeResult["adopt"] = null) =>
  res({ id, stage: "find", verdict, kind, label: `L-${id}`, adopt, count: verdict === "ok" ? 1 : null });
const get = (verdict: QrProbeResult["verdict"], kind: string | null = null, status: number | null = null) =>
  res({ id: "get", stage: "get", verdict, kind, status });
const move = (verdict: QrProbeResult["verdict"], kind: string | null = null, status: number | null = null) =>
  res({ id: "move", stage: "move", verdict, kind, status });

/** 画面に出る文言のキーが、ja・en の両方に実在すること（無いと画面にキーがそのまま出る）。 */
function allKeys(ms: Array<Msg | null>): string[] {
  return ms.filter((m): m is Msg => m != null).map((m) => m.key);
}

describe("通信テストの文言（切断型: 標準の探し方は切断され、最小の項目なら通る）", () => {
  const psp = [
    ECHO_OK,
    find("find-minimal", "ok", "OK", { studyKeys: ["StudyInstanceUID"] }),
    find("find-basic", "ok", "OK", { studyKeys: ["StudyInstanceUID", "PatientID"] }),
    find("find-standard", "ng", "DROPPED"),
    find("find-implicit", "ng", "DROPPED"),
    get("ng", "SERVICE_REFUSED"),
    move("ng", "SERVICE_REFUSED"),
  ];

  it("検索は『通る・ただし標準では通らない』と言い、採用を促す。採用は標準でなく通った方", () => {
    const rows = rowViews(psp, null);
    const f = rows.find((r) => r.id === "find")!;
    expect(f.tone).toBe("ok");
    expect(f.what?.key).toBe("qrProbe.find.ok.other");
    expect(f.next?.key).toBe("qrProbe.find.adoptHint");
    // 好ましい順: basic（返る項目が多い）が minimal より先
    expect(bestFind(psp)?.id).toBe("find-basic");
  });

  it("GET・MOVE を断られたら、✕ と次にすることを出す", () => {
    const rows = rowViews(psp, null);
    expect(rows.find((r) => r.id === "get")).toMatchObject({ tone: "ng", icon: "✕" });
    expect(rows.find((r) => r.id === "get")!.next?.key).toBe("qrProbe.get.refused.next");
    expect(rows.find((r) => r.id === "move")!.what?.key).toBe("qrProbe.move.refused");
  });

  it("結論: 検索はできる・取得はどちらも通らない", () => {
    expect(conclusion(psp).map((m) => m.key)).toEqual(["qrProbe.sum.findOk", "qrProbe.sum.retrieve.none"]);
  });
});

describe("通信テストの文言（そのほか）", () => {
  it("標準で通るなら、設定の変更は要らない（採用の促しなし）", () => {
    const r = [ECHO_OK, find("find-standard", "ok", "OK", {}), get("ok", "OK"), move("ok", "OK")];
    const f = rowViews(r, null).find((x) => x.id === "find")!;
    expect(f.what?.key).toBe("qrProbe.find.ok.standard");
    expect(f.next).toBeNull();
    expect(conclusion(r).map((m) => m.key)).toEqual(["qrProbe.sum.findOk", "qrProbe.sum.retrieve.both"]);
  });

  it("疎通が通らなければ、以降の行は『試していません』", () => {
    const rows = rowViews([ECHO_NG], null);
    expect(rows[0]).toMatchObject({ tone: "ng" });
    expect(rows[0].next?.key).toBe("qrProbe.echo.UNREACHABLE.next");
    for (const id of ["find", "get", "move"]) {
      expect(rows.find((x) => x.id === id)).toMatchObject({ tone: "muted" });
      expect(rows.find((x) => x.id === id)!.what?.key).toBe("qrProbe.blocked");
    }
    expect(conclusion([ECHO_NG]).map((m) => m.key)).toEqual(["qrProbe.sum.noConnect"]);
  });

  it("接続の拒否は理由で次の行動が変わる", () => {
    const called = res({ id: "echo", stage: "echo", verdict: "ng", kind: "ASSOCIATION_REJECTED", reason: "called-AE-title-not-recognized" });
    const calling = res({ id: "echo", stage: "echo", verdict: "ng", kind: "ASSOCIATION_REJECTED", reason: "calling-AE-title-not-recognized" });
    expect(rowViews([called], null)[0].next?.key).toBe("qrProbe.echo.rj.called");
    expect(rowViews([calling], null)[0].next?.key).toBe("qrProbe.echo.rj.calling");
  });

  it("MOVE の a801H は『受け付けたが宛先 AE が未登録』（△）", () => {
    const rows = rowViews([ECHO_OK, find("find-standard", "ok", "OK", {}), get("ok", "OK"), move("warn", "STATUS_ERROR", 0xa801)], null);
    const m = rows.find((r) => r.id === "move")!;
    expect(m).toMatchObject({ tone: "warn", icon: "△" });
    expect(m.what?.key).toBe("qrProbe.move.a801");
    expect(m.next?.key).toBe("qrProbe.move.a801.next");
  });

  it("検索が全滅のときは、最小の探し方の失敗の種類で言う（切断／拒否）", () => {
    const dropped = [ECHO_OK, find("find-minimal", "ng", "DROPPED"), find("find-standard", "ng", "DROPPED")];
    expect(rowViews(dropped, null).find((r) => r.id === "find")!.what?.key).toBe("qrProbe.find.DROPPED");
    const refused = [ECHO_OK, find("find-minimal", "ng", "SERVICE_REFUSED")];
    expect(rowViews(refused, null).find((r) => r.id === "find")!.next?.key).toBe("qrProbe.find.SERVICE_REFUSED.next");
  });

  it("実行中の行は『確かめています』", () => {
    const rows = rowViews([ECHO_OK], "find");
    expect(rows.find((r) => r.id === "find")).toMatchObject({ tone: "running" });
    expect(rows.find((r) => r.id === "get")!.what?.key).toBe("qrProbe.notYet");
  });

  it("使う文言のキーが ja・en の両方にある", () => {
    const scenarios: QrProbeResult[][] = [
      [ECHO_NG], [res({ id: "echo", stage: "echo", verdict: "ng", kind: "ASSOCIATION_REJECTED", reason: "x" })],
      [res({ id: "echo", stage: "echo", verdict: "ng", kind: "TIMEOUT" })], [res({ id: "echo", stage: "echo", verdict: "ng", kind: "UNKNOWN" })],
      [ECHO_OK, find("find-minimal", "ng", "STATUS_ERROR")], [ECHO_OK, find("find-minimal", "ng", "ASSOCIATION_REJECTED")],
      [ECHO_OK, find("find-minimal", "ng", "TIMEOUT")], [ECHO_OK, find("find-minimal", "ng", "UNKNOWN")],
      [ECHO_OK, find("find-minimal", "ng", "DROPPED")], [ECHO_OK, find("find-minimal", "ng", "SERVICE_REFUSED")],
      [ECHO_OK, find("find-standard", "ok", "OK", {}), get("warn", "STATUS_ERROR", 0xa701), move("warn", "STATUS_ERROR", 0xa801)],
      [ECHO_OK, find("find-basic", "ok", "OK", {}), get("ng", "DROPPED"), move("ng", "UNKNOWN")],
      [ECHO_OK, find("find-standard", "ok", "OK", {}), get("ok", "OK"), move("ok", "OK")],
      [ECHO_OK, get("ng", "SERVICE_REFUSED"), move("ng", "SERVICE_REFUSED")],
    ];
    const keys = new Set<string>(["qrProbe.running", "qrProbe.notYet", "qrProbe.blocked"]);
    for (const s of scenarios) {
      for (const row of rowViews(s, null)) {
        allKeys([row.title, row.what, row.next]).forEach((k) => keys.add(k));
      }
      allKeys(conclusion(s)).forEach((k) => keys.add(k));
    }
    for (const d of ["SERVICE_REFUSED", "DROPPED", "TIMEOUT", "UNREACHABLE", "STATUS_ERROR", "ASSOCIATION_REJECTED"]) {
      const m = qrErrorMsg({ error: "qr-find-failed", kind: d });
      expect(m, d).not.toBeNull();
      keys.add(m!.key);
    }
    for (const k of keys) {
      expect(ja[k], `ja に無い: ${k}`).toBeTruthy();
      expect(en[k], `en に無い: ${k}`).toBeTruthy();
    }
  });
});

describe("Q/R のエラー表示と一致方法", () => {
  it("構造化エラーだけを分類し、他は null（従来の表示のまま）", () => {
    expect(qrErrorMsg(null)).toBeNull();
    expect(qrErrorMsg({ message: "x" })).toBeNull();
    expect(qrErrorMsg({ error: "qr-find-failed", kind: "STATUS_ERROR", status: "A900H", errorComment: "Missing PatientID" }))
      .toEqual({ key: "qrProbe.err.STATUS_ERROR", vars: { status: "A900H", comment: " Missing PatientID" } });
    expect(qrErrorMsg({ error: "qr-find-failed", kind: "WHAT" })).toBeNull();
  });

  it("患者 ID・名前の一致方法: 既定は従来どおり前後に *", () => {
    const f = { patientId: "HCC", patientName: "山田", accessionNumber: "A1", modality: "CT", studyDateFrom: "20261101", studyDateTo: "20261114" } as never;
    expect(filtersToMatchKeys(f)).toMatchObject({ PatientID: "*HCC*", PatientName: "*山田*" });
    expect(filtersToMatchKeys(f, "contains")).toMatchObject({ PatientID: "*HCC*" });
    expect(filtersToMatchKeys(f, "prefix")).toMatchObject({ PatientID: "HCC*", PatientName: "山田*" });
    expect(filtersToMatchKeys(f, "exact")).toMatchObject({ PatientID: "HCC", PatientName: "山田", AccessionNumber: "A1" });
  });
});

describe("報告用の文面と検索方式の編集", () => {
  it("報告用の文面は、件数・項目名・status だけ（結果の値をそのまま写す）", () => {
    const txt = reportText({ aeTitle: "RELAY", host: "10.0.0.5", port: 4000 }, [
      ECHO_OK, res({ ...find("find-basic", "ok", "OK", {}), returnedKeys: ["StudyInstanceUID", "PatientID"], command: "findscu -c RELAY@10.0.0.5:4000 -m PatientID=<値>" }),
      res({ id: "find-standard", stage: "find", verdict: "ng", kind: "DROPPED", evidence: "i/o exception: java.io.EOFException in State: Sta6" }),
    ]);
    expect(txt).toContain("RELAY@10.0.0.5:4000");
    expect(txt).toContain("returned=StudyInstanceUID,PatientID");
    expect(txt).toContain("[ng] find-standard DROPPED");
    expect(txt).toContain("EOFException in State: Sta6");
  });

  it("標準（未指定）の判定と、編集後の整理", () => {
    expect(isDefaultProfile(null)).toBe(true);
    expect(isDefaultProfile({})).toBe(true);
    expect(isDefaultProfile({ studyKeys: [] })).toBe(true);
    expect(isDefaultProfile({ model: "PatientRoot" })).toBe(false);
    expect(compactProfile({ model: "StudyRoot", wildcard: "contains", studyKeys: [], charset: "" })).toBeNull();
    expect(compactProfile({ model: "PatientRoot", transferSyntax: "implicit" })).toEqual({ model: "PatientRoot", transferSyntax: "implicit" });
    expect(presetOf(null)).toBe("standard");
    expect(presetOf({ studyKeys: ["StudyInstanceUID"] })).toBe("minimal");
    expect(presetOf({ studyKeys: ["PatientID"] })).toBe("custom");
  });
});
