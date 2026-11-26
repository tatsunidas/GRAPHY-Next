/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * DICOM SR の内容の木（backend `GET …/instances/{sop}/sr`）を、画面に出すための型と純関数。
 *
 * <p>**HTML は、ここでは作らない**（React の要素で描く）。SR は外から取り込んだ入力で、文字列に `<script>` などを
 * 含みうる。画面は文字として描き、`dangerouslySetInnerHTML` を使わない。「HTML として保存」だけは文字列の HTML を作るので、
 * {@link escapeHtml} で**すべての**値をエスケープする（{@link srToHtml}）。
 */

export interface SrCode {
  value: string | null;
  scheme: string | null;
  meaning: string | null;
}

export interface SrRef {
  sopClassUid: string | null;
  sopInstanceUid: string | null;
  frames: number[];
  segments: number[];
}

export interface SrGraphic {
  type: string | null;
  data: number[];
  frameOfReferenceUid: string | null;
}

export interface SrTemporal {
  rangeType: string | null;
  samplePositions: number[];
  timeOffsets: number[];
  dateTimes: string[];
}

export interface SrNum {
  value: string | null;
  unit: SrCode | null;
  qualifier: SrCode | null;
}

export interface SrNode {
  relationship: string | null;
  valueType: string | null;
  concept: SrCode | null;
  text: string | null;
  num: SrNum | null;
  code: SrCode | null;
  uid: string | null;
  date: string | null;
  time: string | null;
  dateTime: string | null;
  personName: string | null;
  continuity: string | null;
  ref: SrRef | null;
  graphic: SrGraphic | null;
  temporal: SrTemporal | null;
  children: SrNode[];
}

export interface SrVerifier {
  organization: string | null;
  dateTime: string | null;
  name: string | null;
}

export interface SrHeader {
  sopClassUid: string | null;
  sopClassName: string | null;
  studyInstanceUid: string | null;
  seriesInstanceUid: string | null;
  sopInstanceUid: string | null;
  completionFlag: string | null;
  verificationFlag: string | null;
  contentDate: string | null;
  contentTime: string | null;
  verifiers: SrVerifier[];
}

export interface SrDocument {
  header: SrHeader;
  root: SrNode;
  truncated: boolean;
  truncatedReason: string | null;
  itemCount: number;
}

/** PS3.16 の「Measurement Group」（計測 1 組）。コーディングスキームは DCM。 */
export const CONCEPT_MEASUREMENT_GROUP = "125007";

/** コードの表示名（意味があれば意味、無ければコード値）。 */
export function codeLabel(c: SrCode | null | undefined): string {
  if (!c) return "";
  return (c.meaning ?? "").trim() || (c.value ?? "").trim();
}

/** DICOM の日付 `YYYYMMDD` → `YYYY-MM-DD`。解釈できなければそのまま。 */
export function formatDicomDate(da: string | null | undefined): string {
  if (!da) return "";
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(da.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : da;
}

/** DICOM の時刻 `HHMMSS[.FFF]` → `HH:MM:SS`。解釈できなければそのまま。 */
export function formatDicomTime(tm: string | null | undefined): string {
  if (!tm) return "";
  const m = /^(\d{2})(\d{2})?(\d{2})?(\.\d+)?$/.exec(tm.trim());
  if (!m) return tm;
  return [m[1], m[2] ?? "00", m[3] ?? "00"].join(":") + (m[4] ?? "");
}

/** DICOM の日時 `YYYYMMDDHHMMSS[.FFF][&ZZXX]` → `YYYY-MM-DD HH:MM:SS`。解釈できなければそのまま。 */
export function formatDicomDateTime(dt: string | null | undefined): string {
  if (!dt) return "";
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(\.\d+)?([+-]\d{4})?$/.exec(dt.trim());
  if (!m) return dt;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (m[4] === undefined) return date;
  return `${date} ${m[4]}:${m[5] ?? "00"}:${m[6] ?? "00"}${m[7] ?? ""}${m[8] ? ` (${m[8]})` : ""}`;
}

/** 人名 `Family^Given^Middle^Prefix^Suffix` → 空白区切り。 */
export function formatPersonName(pn: string | null | undefined): string {
  return (pn ?? "").split("^").map((x) => x.trim()).filter((x) => x !== "").join(" ");
}

/** NUM を `値 単位` に。値が無ければ「—」。 */
export function formatNum(n: SrNum | null | undefined): string {
  if (!n || n.value === null || n.value.trim() === "") return "—";
  const unit = codeLabel(n.unit);
  const q = codeLabel(n.qualifier);
  return [n.value.trim(), unit, q ? `(${q})` : ""].filter((x) => x !== "").join(" ");
}

/** 参照（IMAGE・COMPOSITE・WAVEFORM）を 1 行に。 */
export function formatRef(r: SrRef | null | undefined): string {
  if (!r) return "";
  const parts = [r.sopInstanceUid ?? ""];
  if (r.frames.length > 0) parts.push(`frame ${r.frames.join(",")}`);
  if (r.segments.length > 0) parts.push(`segment ${r.segments.join(",")}`);
  return parts.filter((x) => x !== "").join(" · ");
}

/** 図形（SCOORD）を 1 行に（座標は数の個数だけ。数を全部は出さない）。 */
export function formatGraphic(g: SrGraphic | null | undefined): string {
  if (!g) return "";
  return `${g.type ?? "?"} (${g.data.length} values)`;
}

/** 木の項目の値を、型ごとの 1 つの文字列にする（CONTAINER は空）。 */
export function valueText(n: SrNode): string {
  switch (n.valueType) {
    case "TEXT": return n.text ?? "";
    case "NUM": return formatNum(n.num);
    case "CODE": return codeLabel(n.code);
    case "DATE": return formatDicomDate(n.date);
    case "TIME": return formatDicomTime(n.time);
    case "DATETIME": return formatDicomDateTime(n.dateTime);
    case "PNAME": return formatPersonName(n.personName);
    case "UIDREF": return n.uid ?? "";
    case "IMAGE":
    case "COMPOSITE":
    case "WAVEFORM": return formatRef(n.ref);
    case "SCOORD":
    case "SCOORD3D": return formatGraphic(n.graphic);
    case "TCOORD": return n.temporal ? `${n.temporal.rangeType ?? "?"}` : "";
    default: return "";
  }
}

/** 計測グループ（`125007 Measurement Group` のコンテナ）か。 */
export function isMeasurementGroup(n: SrNode): boolean {
  return n.valueType === "CONTAINER" && n.concept?.value === CONCEPT_MEASUREMENT_GROUP;
}

export interface GroupRow {
  name: string;
  value: string;
  unit: string;
}

export interface MeasurementGroupView {
  /** 計測の表（NUM の項目）。 */
  rows: GroupRow[];
  /** 表にならない項目（追跡 ID・所見・画像参照など）。木のまま出す。 */
  others: SrNode[];
}

/** 計測グループを、計測の表とそれ以外に分ける。NUM は表に、それ以外は `others`（順序を保つ）。 */
export function groupView(n: SrNode): MeasurementGroupView {
  const rows: GroupRow[] = [];
  const others: SrNode[] = [];
  for (const c of n.children) {
    if (c.valueType === "NUM" && c.num && c.num.value !== null) {
      rows.push({ name: codeLabel(c.concept), value: c.num.value.trim(), unit: [codeLabel(c.num.unit), codeLabel(c.num.qualifier)].filter((x) => x !== "").join(" ") });
    } else {
      others.push(c);
    }
  }
  return { rows, others };
}

// --- HTML として保存 --------------------------------------------------------------------

/** HTML の特殊文字をエスケープする（要素の中身・属性の値のどちらにも使える）。 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const HTML_STYLE = `body{font:14px/1.6 system-ui,sans-serif;color:#1f2933;max-width:960px;margin:24px auto;padding:0 16px}
h1{font-size:20px;margin:0 0 4px}h2,h3,h4{margin:14px 0 4px;color:#0b5cad}
.meta{color:#5b6773;font-size:12px;margin-bottom:12px}.row{margin:2px 0}.name{color:#5b6773}.name::after{content:" : "}
table{border-collapse:collapse;margin:6px 0}th,td{border:1px solid #c9d1d9;padding:3px 8px;text-align:left}th{background:#f2f6fa}
td.num{text-align:right;font-variant-numeric:tabular-nums}pre{white-space:pre-wrap;margin:2px 0;font:inherit}
.warn{background:#fff6d6;border:1px solid #e0c35a;padding:6px 8px;margin:8px 0}`;

function nodeHtml(n: SrNode, depth: number): string {
  if (n.valueType === "CONTAINER") {
    const level = Math.min(4, depth + 2);
    const title = escapeHtml(codeLabel(n.concept));
    if (isMeasurementGroup(n)) {
      const { rows, others } = groupView(n);
      const table = rows.length === 0 ? "" :
        `<table><thead><tr><th>${escapeHtml("Measurement")}</th><th>${escapeHtml("Value")}</th><th>${escapeHtml("Unit")}</th></tr></thead><tbody>${
          rows.map((r) => `<tr><td>${escapeHtml(r.name)}</td><td class="num">${escapeHtml(r.value)}</td><td>${escapeHtml(r.unit)}</td></tr>`).join("")
        }</tbody></table>`;
      return `<section><h${level}>${title}</h${level}>${others.map((o) => nodeHtml(o, depth + 1)).join("")}${table}</section>`;
    }
    return `<section><h${level}>${title}</h${level}>${n.children.map((c) => nodeHtml(c, depth + 1)).join("")}</section>`;
  }
  const v = valueText(n);
  const body = n.valueType === "TEXT" ? `<pre>${escapeHtml(v)}</pre>` : escapeHtml(v);
  return `<div class="row"><span class="name">${escapeHtml(codeLabel(n.concept))}</span>${body}</div>`;
}

/** 表示と同じ内容の、外部依存の無い 1 ファイルの HTML（印刷・共有用）。**すべての値をエスケープする。** */
export function srToHtml(doc: SrDocument, title: string): string {
  const h = doc.header;
  const meta = [h.sopClassName, h.completionFlag, h.verificationFlag, [formatDicomDate(h.contentDate), formatDicomTime(h.contentTime)].filter((x) => x).join(" ")]
    .filter((x): x is string => !!x && x !== "").map(escapeHtml).join(" · ");
  const warn = doc.truncated ? `<div class="warn">${escapeHtml(doc.truncatedReason ?? "truncated")}</div>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${HTML_STYLE}</style></head><body>` +
    `<h1>${escapeHtml(title)}</h1><div class="meta">${meta}</div>${warn}${nodeHtml(doc.root, 0)}</body></html>`;
}
