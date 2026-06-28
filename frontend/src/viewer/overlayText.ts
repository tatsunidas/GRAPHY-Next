import dicomImageLoader from "@cornerstonejs/dicom-image-loader";
import {
  type OverlayConfig,
  type OverlayCorner,
  type OverlayField,
  MAX_VALUE_CHARS,
} from "./overlayConfig";

/** 表示中 imageId の dicom-parser DataSet（wadouri キャッシュ）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dataSetOf(imageId: string): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wadouri = (dicomImageLoader as any).wadouri;
    const { url } = wadouri.parseImageId(imageId);
    return wadouri.dataSetCacheManager.get(url) ?? null;
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rawValue(ds: any, tag: string): string | null {
  const v = ds?.string?.("x" + tag.toLowerCase());
  return v == null || v === "" ? null : String(v);
}

function fmtDate(v: string): string {
  return /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v;
}
function fmtTime(v: string): string {
  return /^\d{6}/.test(v) ? `${v.slice(0, 2)}:${v.slice(2, 4)}:${v.slice(4, 6)}` : v;
}
function fmtPN(v: string): string {
  return v.replace(/\^+/g, " ").trim();
}

/** 生年月日(YYYYMMDD)と検査日(YYYYMMDD)から満年齢。 */
function ageOf(birth: string | null, study: string | null): string | null {
  if (!birth || !study || !/^\d{8}$/.test(birth) || !/^\d{8}$/.test(study)) return null;
  const by = +birth.slice(0, 4), bm = +birth.slice(4, 6), bd = +birth.slice(6, 8);
  const sy = +study.slice(0, 4), sm = +study.slice(4, 6), sd = +study.slice(6, 8);
  let age = sy - by;
  if (sm < bm || (sm === bm && sd < bd)) age--;
  if (age < 0 || age > 200) return null;
  return `${age}Y`;
}

function truncate(s: string): string {
  return s.length > MAX_VALUE_CHARS ? s.slice(0, MAX_VALUE_CHARS - 1) + "…" : s;
}

/** 1 項目を表示文字列に解決（属性が無ければ null＝非表示）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveField(field: OverlayField, ds: any): string | null {
  let value: string | null;
  if (field.tag === "AGE") {
    value = ageOf(rawValue(ds, "00100030"), rawValue(ds, "00080020"));
  } else {
    const raw = rawValue(ds, field.tag);
    if (raw == null) return null;
    switch (field.vr) {
      case "PN":
        value = fmtPN(raw);
        break;
      case "DA":
        value = fmtDate(raw);
        break;
      case "TM":
        value = fmtTime(raw);
        break;
      default:
        value = raw;
    }
  }
  if (value == null || value === "") return null;
  return truncate(value);
}

/** 4 隅ぶんの表示行（空項目は除外）。 */
export type ResolvedOverlay = Record<OverlayCorner, string[]>;

export function resolveOverlay(config: OverlayConfig, imageId: string | undefined): ResolvedOverlay {
  const empty: ResolvedOverlay = { topLeft: [], topRight: [], bottomLeft: [], bottomRight: [] };
  if (!imageId) return empty;
  const ds = dataSetOf(imageId);
  if (!ds) return empty;
  const corners: OverlayCorner[] = ["topLeft", "topRight", "bottomLeft", "bottomRight"];
  for (const corner of corners) {
    for (const field of config[corner]) {
      const v = resolveField(field, ds);
      if (v != null) empty[corner].push(v);
    }
  }
  return empty;
}
