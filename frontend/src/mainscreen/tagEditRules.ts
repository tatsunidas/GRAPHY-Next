/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// タグの編集の決まり（画面ですぐ見せる用）。正は backend の TagEditRules.java で、保存の前に確認（preview）でも検査される。
// 表を変えるときは両方を同じに直す。

/** "(0008,103E)" を数に。読めなければ -1。 */
export function parseTagNumber(s: string): number {
  const m = /^\(?([0-9A-Fa-f]{4}),?([0-9A-Fa-f]{4})\)?$/.exec(s.trim());
  return m ? parseInt(m[1] + m[2], 16) >>> 0 : -1;
}

export function formatTag(n: number): string {
  const h = (n >>> 0).toString(16).toUpperCase().padStart(8, "0");
  return `(${h.slice(0, 4)},${h.slice(4)})`;
}

const PIXEL = new Set([
  0x7fe00010, 0x7fe00008, 0x7fe00009, 0x00280010, 0x00280011, 0x00280100, 0x00280101, 0x00280102, 0x00280103,
  0x00280002, 0x00280004, 0x00280008, 0x00280006,
]);
/** 幾何: ImagePositionPatient・ImageOrientationPatient・PixelSpacing・SliceThickness。 */
const GEOMETRY = new Set([0x00200032, 0x00200037, 0x00280030, 0x00180050]);
/** 患者情報の編集が受け持つ: PatientID・PatientName・PatientBirthDate・PatientSex。 */
const PATIENT = new Set([0x00100020, 0x00100010, 0x00100030, 0x00100040]);
const ORIGINAL_ATTRIBUTES_SEQUENCE = 0x04000561;
const BINARY = new Set(["OB", "OW", "OF", "OD", "OL", "OV", "UN"]);
const SINGLE = new Set(["LT", "ST", "UT", "UR"]);

/** 編集できない理由（i18n の `tagedit.lock.<理由>`）。編集できるなら null。 */
export function lockReason(tag: number, vr: string, depth = 0): string | null {
  const group = tag >>> 16;
  const element = tag & 0xffff;
  if (group === 0x0002) return "meta";
  if (group === 0x0000 || group === 0xfffe || element === 0x0000) return "structure";
  if (depth > 0) return "sequence";
  if (PATIENT.has(tag)) return "patient";
  if (PIXEL.has(tag)) return "pixel";
  if (GEOMETRY.has(tag)) return "geometry";
  if (tag === ORIGINAL_ATTRIBUTES_SEQUENCE) return "audit";
  if (vr === "UI") return "uid";
  if (vr === "SQ") return "sequence";
  if (!vr || BINARY.has(vr)) return "binary";
  if ((group & 1) === 1 && element >= 0x0010 && element <= 0x00ff) return "privateCreator";
  return null;
}

const DS = /^ *[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)? *$/;
const IS = /^ *[+-]?\d+ *$/;
const CS = /^[A-Z0-9 _]*$/;
const AS = /^\d{3}[DWMY]$/;
const DA = /^(\d{4})(\d{2})(\d{2})$/;
const TM = /^([01]\d|2[0-3])([0-5]\d([0-5]\d|60)?(\.\d{1,6})?)?$/;
const DT = /^\d{4}(\d{2}(\d{2}(\d{2}(\d{2}(\d{2}(\.\d{1,6})?)?)?)?)?)?([+-]\d{4})?$/;

/** 値が VR の決まりに合わない理由（i18n の `tagedit.err.<理由>`）。合えば null。空は許す。 */
export function valueError(vr: string, value: string): string | null {
  if (!value) return null;
  if (SINGLE.has(vr)) return one(vr, value);
  for (const v of value.split("\\")) {
    const e = one(vr, v);
    if (e) return e;
  }
  return null;
}

function one(vr: string, v: string): string | null {
  if (!v) return null;
  const text = vr === "LT" || vr === "ST" || vr === "UT";
  for (const ch of v) {
    const c = ch.codePointAt(0)!;
    const allowedCtl = text && (c === 13 || c === 10 || c === 9 || c === 12);
    if ((c < 0x20 && c !== 0x1b && !allowedCtl) || c === 0x7f) return "badChars";
  }
  const len = v.length;
  switch (vr) {
    case "AE":
      return len > 16 ? "tooLong" : ascii(v) ? null : "badChars";
    case "AS":
      return AS.test(v) ? null : "format";
    case "CS":
      return len > 16 ? "tooLong" : CS.test(v) ? null : "badChars";
    case "DA":
      return date(v);
    case "DS":
      return len > 16 ? "tooLong" : DS.test(v) ? null : "format";
    case "DT":
      return len > 26 ? "tooLong" : !DT.test(v) ? "format" : len >= 8 ? date(v.slice(0, 8)) : null;
    case "IS":
      return len > 12 ? "tooLong" : !IS.test(v) ? "format" : range(Number(v.trim()), -2147483648, 2147483647);
    case "LO":
      return len > 64 ? "tooLong" : null;
    case "SH":
      return len > 16 ? "tooLong" : null;
    case "LT":
      return len > 10240 ? "tooLong" : null;
    case "ST":
      return len > 1024 ? "tooLong" : null;
    case "PN":
      return personName(v);
    case "TM":
      return len > 14 ? "tooLong" : TM.test(v) ? null : "format";
    case "UR":
      return v.startsWith(" ") ? "format" : ascii(v) ? null : "badChars";
    case "UC":
    case "UT":
      return null;
    case "US":
      return integer(v, 0, 0xffff);
    case "SS":
      return integer(v, -32768, 32767);
    case "UL":
      return integer(v, 0, 0xffffffff);
    case "SL":
      return integer(v, -2147483648, 2147483647);
    case "SV":
    case "UV":
      // 64 ビットの範囲は JS の数で正確に比べられないので、形だけ見て範囲はサーバーに任せる
      return /^ *[+-]?\d{1,20} *$/.test(v) ? null : "format";
    case "FL":
    case "FD":
      return DS.test(v) && Number.isFinite(Number(v.trim())) ? null : "format";
    default:
      return "format";
  }
}

function ascii(v: string): boolean {
  return /^[\x20-\x7e]*$/.test(v);
}

function date(v: string): string | null {
  const m = DA.exec(v);
  if (!m) return "format";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d); // Date.UTC は 0〜99 年を 1900 年代に読み替えるので使わない
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? null : "format";
}

function personName(v: string): string | null {
  const groups = v.split("=");
  if (groups.length > 3) return "format";
  for (const g of groups) {
    if (g.length > 64) return "tooLong";
    if (g.split("^").length > 5) return "format";
  }
  return null;
}

function integer(v: string, min: number, max: number): string | null {
  const t = v.trim();
  if (!/^[+-]?\d{1,19}$/.test(t)) return "format";
  return range(Number(t), min, max);
}

function range(n: number, min: number, max: number): string | null {
  return n < min || n > max ? "outOfRange" : null;
}
