// 本体の SeriesLayoutDto を、媒体の DICOM ヘッダからクライアント側で組む（本体では backend が行う）。
// 描画核（viewer/SeriesViewer）は DTO を受け取るだけなので、同じ形で渡せば本体と同じ挙動になる。
//
// 範囲（段 2）:
// - 単一フレーム画像の通常シリーズ: IPP を法線へ射影して Z 昇順。同じ位置が同数ずつ繰り返す場合は T 軸。
// - マルチフレームの 1 インスタンス（XA/US シネなど）: フレームを T 軸（stackAxis="t"）。
// - Siemens モザイクのデモザイク・欠損スライスのブランク埋め・Enhanced の位置別フレームは未対応
//   （単一軸のフォールバックで表示する。画像は出る）。
import dicomParser from "dicom-parser";
import type { SeriesLayoutDto, SeriesLayoutCell } from "../../src/api";

export interface HeaderInfo {
  sopUid: string;
  url: string;
  instanceNumber: number;
  ipp: [number, number, number] | null;
  iop: [number, number, number, number, number, number] | null;
  rows: number;
  cols: number;
  pixelSpacing: [number, number] | null;
  frameOfReference: string | null;
  frames: number;
  temporalPos: number | null;
  acqTime: number | null;
}

const HEAD_BYTES = 128 * 1024;

function nums(ds: dicomParser.DataSet, tag: string, n: number): number[] | null {
  const s = ds.string(tag);
  if (!s) return null;
  const v = s.split("\\").map((x) => Number(x.trim()));
  return v.length >= n && v.slice(0, n).every(Number.isFinite) ? v.slice(0, n) : null;
}

function timeToSec(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{2})(\d{2})(\d{2})(\.\d+)?/.exec(s.trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(m[4]) : 0) : null;
}

/** 先頭だけを Range で読んでヘッダを解析する（ヘッダが大きいときは全体を読み直す）。 */
export async function readHeader(sopUid: string, url: string, instanceNumber: number): Promise<HeaderInfo> {
  const parse = async (full: boolean): Promise<dicomParser.DataSet> => {
    const res = await fetch(url, full ? {} : { headers: { Range: `bytes=0-${HEAD_BYTES - 1}` } });
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return dicomParser.parseDicom(bytes, { untilTag: "x7fe00010" });
  };
  let ds: dicomParser.DataSet;
  try {
    ds = await parse(false);
  } catch {
    ds = await parse(true);
  }
  const ipp = nums(ds, "x00200032", 3) as [number, number, number] | null;
  const iop = nums(ds, "x00200037", 6) as HeaderInfo["iop"];
  const ps = nums(ds, "x00280030", 2) as [number, number] | null;
  const nf = Number(ds.string("x00280008") ?? "1");
  return {
    sopUid,
    url,
    instanceNumber: Number.isFinite(Number(ds.string("x00200013"))) && ds.string("x00200013") ? Number(ds.string("x00200013")) : instanceNumber,
    ipp,
    iop,
    rows: ds.uint16("x00280010") ?? 0,
    cols: ds.uint16("x00280011") ?? 0,
    pixelSpacing: ps,
    frameOfReference: ds.string("x00200052") ?? null,
    frames: Number.isFinite(nf) && nf > 0 ? nf : 1,
    temporalPos: ds.string("x00200100") ? Number(ds.string("x00200100")) : null,
    acqTime: timeToSec(ds.string("x00080032") ?? ds.string("x00080033")),
  };
}

/** 同時に走らせる数を絞って全インスタンスのヘッダを読む。 */
export async function readHeaders(
  items: { sopUid: string; url: string; instanceNumber: number }[],
  onProgress?: (done: number) => void,
): Promise<HeaderInfo[]> {
  const out: HeaderInfo[] = new Array(items.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await readHeader(items[i].sopUid, items[i].url, items[i].instanceNumber);
      onProgress?.(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, worker));
  return out;
}

const cross = (a: number[], b: number[]): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** ヘッダ群から本体と同じ形のレイアウト DTO を作る。 */
export function buildLayoutDto(hs: HeaderInfo[]): SeriesLayoutDto {
  const first = hs[0];
  const base = {
    cDimension: null,
    tDimension: null,
    imageOrientationPatient: first?.iop ?? null,
    pixelSpacingRow: first?.pixelSpacing?.[0] ?? 0,
    pixelSpacingCol: first?.pixelSpacing?.[1] ?? 0,
    imageWidth: first?.cols ?? 0,
    imageHeight: first?.rows ?? 0,
    frameOfReferenceUID: first?.frameOfReference ?? null,
  };

  // マルチフレーム 1 インスタンス: フレーム軸（XA/US シネ）。
  if (hs.length === 1 && first.frames > 1) {
    const cells: SeriesLayoutCell[] = Array.from({ length: first.frames }, (_, t) => ({ c: 0, z: 0, t, sopInstanceUid: first.sopUid, frame: t }));
    return {
      ...base, nZ: 1, nC: 1, nT: first.frames, cells, zSpatial: null, tDimension: "Frame",
      axes: { z: null, c: null, t: { label: "Frame", kind: "frame" }, stackAxis: "t" },
    };
  }

  const single = (order: HeaderInfo[]): SeriesLayoutDto => ({
    ...base, nZ: order.length, nC: 1, nT: 1,
    cells: order.map((h, z) => ({ c: 0, z, t: 0, sopInstanceUid: h.sopUid })),
    zSpatial: null,
  });
  const byInstance = [...hs].sort((a, b) => a.instanceNumber - b.instanceNumber);

  const hasPos = hs.every((h) => h.ipp) && first?.iop;
  if (!hasPos) return single(byInstance);

  const iop = first.iop!;
  const n = cross(iop.slice(0, 3), iop.slice(3, 6));
  const proj = (h: HeaderInfo) => h.ipp![0] * n[0] + h.ipp![1] * n[1] + h.ipp![2] * n[2];
  // 位置ごとにまとめる（0.01 mm 丸め）。
  const groups = new Map<number, HeaderInfo[]>();
  for (const h of hs) {
    const k = Math.round(proj(h) * 100);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(h);
  }
  const keys = [...groups.keys()].sort((a, b) => a - b);
  const sizes = new Set(keys.map((k) => groups.get(k)!.length));
  if (sizes.size !== 1) return single([...hs].sort((a, b) => proj(a) - proj(b) || a.instanceNumber - b.instanceNumber));
  const nT = [...sizes][0];

  const cells: SeriesLayoutCell[] = [];
  keys.forEach((k, z) => {
    const g = groups.get(k)!.sort((a, b) => (a.temporalPos ?? 0) - (b.temporalPos ?? 0) || (a.acqTime ?? 0) - (b.acqTime ?? 0) || a.instanceNumber - b.instanceNumber);
    g.forEach((h, t) => cells.push({ c: 0, z, t, sopInstanceUid: h.sopUid }));
  });
  return {
    ...base, nZ: keys.length, nC: 1, nT, cells,
    tDimension: nT > 1 ? "Temporal" : null,
    zSpatial: keys.map((k, z) => ({ z, imagePositionPatient: groups.get(k)![0].ipp! })),
  };
}
