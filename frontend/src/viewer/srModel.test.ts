import { describe, expect, it } from "vitest";
import {
  codeLabel,
  escapeHtml,
  formatDicomDate,
  formatDicomDateTime,
  formatDicomTime,
  formatNum,
  formatPersonName,
  groupView,
  isMeasurementGroup,
  srToHtml,
  valueText,
  type SrCode,
  type SrDocument,
  type SrNode,
} from "./srModel";

const code = (value: string, meaning: string | null = null, scheme = "DCM"): SrCode => ({ value, scheme, meaning });
const node = (over: Partial<SrNode>): SrNode => ({
  relationship: "CONTAINS", valueType: null, concept: null, text: null, num: null, code: null, uid: null, date: null, time: null,
  dateTime: null, personName: null, continuity: null, ref: null, graphic: null, temporal: null, children: [], ...over,
});

describe("値の整形", () => {
  it("日付・時刻・日時・人名", () => {
    expect(formatDicomDate("20260801")).toBe("2026-08-01");
    expect(formatDicomTime("090000")).toBe("09:00:00");
    expect(formatDicomTime("0930")).toBe("09:30:00");
    expect(formatDicomDateTime("20260801090000.5+0900")).toBe("2026-08-01 09:00:00.5 (+0900)");
    expect(formatPersonName("Doe^Jane^^Dr")).toBe("Doe Jane Dr");
    // 解釈できないものは、そのまま（捏造しない）
    expect(formatDicomDate("garbage")).toBe("garbage");
    expect(formatDicomDate(null)).toBe("");
  });
  it("コードは意味があれば意味、無ければコード値", () => {
    expect(codeLabel(code("121070", "Findings"))).toBe("Findings");
    expect(codeLabel(code("ABSORBED_DOSE", null))).toBe("ABSORBED_DOSE");
    expect(codeLabel(null)).toBe("");
  });
  it("NUM は値と単位。値が無ければ「—」（0 にしない）", () => {
    expect(formatNum({ value: "1.3215", unit: code("Gy", "Gy", "UCUM"), qualifier: null })).toBe("1.3215 Gy");
    expect(formatNum({ value: null, unit: null, qualifier: null })).toBe("—");
    expect(formatNum(null)).toBe("—");
  });
  it("型ごとの値", () => {
    expect(valueText(node({ valueType: "TEXT", text: "a\nb" }))).toBe("a\nb");
    expect(valueText(node({ valueType: "UIDREF", uid: "1.2.3" }))).toBe("1.2.3");
    expect(valueText(node({ valueType: "IMAGE", ref: { sopClassUid: "c", sopInstanceUid: "1.2.3.4", frames: [1, 2], segments: [] } }))).toBe("1.2.3.4 · frame 1,2");
    expect(valueText(node({ valueType: "SCOORD", graphic: { type: "POLYLINE", data: [1, 2, 3, 4], frameOfReferenceUid: null } }))).toBe("POLYLINE (4 values)");
    expect(valueText(node({ valueType: "CONTAINER" }))).toBe("");
  });
});

describe("計測グループ", () => {
  const group = node({
    valueType: "CONTAINER", concept: code("125007", "Measurement Group"),
    children: [
      node({ valueType: "TEXT", concept: code("112039", "Tracking Identifier"), text: "cycle=1;voi=liver", relationship: "HAS OBS CONTEXT" }),
      node({ valueType: "NUM", concept: code("ABSORBED_DOSE", "Absorbed Dose", "99GRAPHY"), num: { value: "1.3215", unit: code("Gy", "Gy", "UCUM"), qualifier: null } }),
      node({ valueType: "NUM", concept: code("T_EFF", "Effective Half-Life", "99GRAPHY"), num: { value: "58.7346", unit: code("h", "h", "UCUM"), qualifier: null } }),
      node({ valueType: "IMAGE", concept: code("121112", "Source of Measurement"), ref: { sopClassUid: null, sopInstanceUid: "1.2.3", frames: [], segments: [] } }),
    ],
  });
  it("★ 計測グループは、NUM を表の行に、それ以外（追跡 ID・画像参照）を木に残す。順序を保つ", () => {
    expect(isMeasurementGroup(group)).toBe(true);
    const v = groupView(group);
    expect(v.rows).toEqual([
      { name: "Absorbed Dose", value: "1.3215", unit: "Gy" },
      { name: "Effective Half-Life", value: "58.7346", unit: "h" },
    ]);
    expect(v.others.map((o) => o.valueType)).toEqual(["TEXT", "IMAGE"]);
  });
  it("負例: 概念が 125007 でないコンテナ・コンテナでないものは、計測グループではない", () => {
    expect(isMeasurementGroup(node({ valueType: "CONTAINER", concept: code("126010", "Imaging Measurements") }))).toBe(false);
    expect(isMeasurementGroup(node({ valueType: "TEXT", concept: code("125007") }))).toBe(false);
  });
  it("値の無い NUM は、表の行にしない（0 で埋めない）", () => {
    const g = node({ valueType: "CONTAINER", concept: code("125007"), children: [node({ valueType: "NUM", concept: code("X"), num: { value: null, unit: null, qualifier: null } })] });
    expect(groupView(g).rows).toEqual([]);
    expect(groupView(g).others).toHaveLength(1);
  });
});

describe("HTML として保存（外部入力のエスケープ）", () => {
  const evil = `<script>alert(1)</script><img src=x onerror="alert(2)">'&`;
  const doc: SrDocument = {
    header: { sopClassUid: "1", sopClassName: evil, studyInstanceUid: null, seriesInstanceUid: null, sopInstanceUid: null, completionFlag: "COMPLETE", verificationFlag: "UNVERIFIED", contentDate: "20260802", contentTime: "103000", verifiers: [] },
    root: node({
      valueType: "CONTAINER", concept: code("X", evil),
      children: [
        node({ valueType: "TEXT", concept: code("121106", evil), text: evil }),
        node({ valueType: "CONTAINER", concept: code("125007", evil), children: [node({ valueType: "NUM", concept: code("Y", evil), num: { value: evil, unit: code("u", evil), qualifier: null } })] }),
      ],
    }),
    truncated: true, truncatedReason: evil, itemCount: 4,
  };
  it("★ `<script>` や `onerror=` を含む値が、要素にならない（すべて文字にエスケープされる）", () => {
    const html = srToHtml(doc, evil);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('onerror="alert');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&#39;&amp;");
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });
  it("外部依存が無い（script・link・外部 URL の読み込みが無い）", () => {
    const html = srToHtml({ ...doc, root: node({ valueType: "CONTAINER", concept: code("X", "T"), children: [] }), truncated: false, header: { ...doc.header, sopClassName: "SR" } }, "T");
    expect(/<script|<link|@import|url\(|src=|href=/.test(html)).toBe(false);
  });
  it("escapeHtml は 5 つの特殊文字を変える", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});
