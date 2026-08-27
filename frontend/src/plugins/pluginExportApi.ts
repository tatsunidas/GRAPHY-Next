/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * プラグイン host API の書き出し層（H22 = DICOM SEG / H23 = RTDOSE）。
 *
 * <p><b>DICOM はプラグインに書かせない</b>（H4b / H9 と同じ）。プラグインは
 * 「どのシリーズの、どの格子に、何が入っているか」だけを渡し、
 * SEG / RTDOSE の組み立て・UID 採番・患者/検査の引き継ぎは backend が行う。
 *
 * <h3>ここが引き受けている 1 点</h3>
 *
 * <p>プラグインが持っているのは <b>H10 で読んだボリュームの格子</b>であり、
 * DICOM が要求するのは <b>元シリーズのインスタンス</b>との対応である。その橋渡し
 * （z 番目 ↔ SOPInstanceUID / IPP）をここで解決する。
 * <b>対応が取れなければ書かない</b>——ずれた SEG は「別のスライスに塗られたマスク」になり、
 * 見ないと気付けない。
 */
import { exportDicomSeg, exportRtDose, fetchSeriesLayout, type RtDoseExportRequest, type SegExportRequest, type SegExportSegment } from "../api";
import type { ViewerMode } from "../viewer/imageId";
import {
  gridFrameOffsets,
  quantizeDoseGrid,
  sliceMask,
  u8ToBase64,
  type Vec3,
} from "./pluginExportCore";
import type {
  PluginExportGrid,
  PluginRtDoseRequest,
  PluginSegmentationRequest,
  PluginSeriesRef,
} from "./pluginTypes";

/** シリーズ参照から studyUid を解決する（開いているタイルから引く）。H10 と同じ作法。 */
export type StudyResolver = (seriesUid: string) => string | undefined;

/** 元シリーズの 1 スライス。 */
interface RefSlice {
  sopInstanceUid: string;
  ipp: Vec3;
}

/** 元シリーズの幾何と、ボリューム z 順のスライス一覧。 */
interface RefGeometry {
  studyUid: string;
  rows: number;
  columns: number;
  iop: number[];
  /** [row, col] mm（DICOM PixelSpacing の順）。 */
  pixelSpacing: [number, number];
  frameOfReferenceUid: string | null;
  slices: RefSlice[];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function norm(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/** IOP から面法線（単位ベクトル）。 */
function normalOf(iop: number[]): Vec3 | null {
  if (iop.length < 6) return null;
  const n: Vec3 = [
    iop[1] * iop[5] - iop[2] * iop[4],
    iop[2] * iop[3] - iop[0] * iop[5],
    iop[0] * iop[4] - iop[1] * iop[3],
  ];
  const l = norm(n);
  return l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : null;
}

/**
 * 元シリーズの幾何を読み、**ボリュームの z と同じ並び**のスライス一覧を作る。
 *
 * <p>並べ替えの規則は `regVolumeLoader`（H10 が使っているローダ）と同じ
 * 「面法線への射影の昇順」。同じ規則を 2 か所に書くことになるので、
 * <b>{@link matchGrid} で実際に一致するかを必ず検査する</b>——一致しなければ書かない。
 */
async function refGeometry(ref: PluginSeriesRef, studyUid: string): Promise<RefGeometry | string> {
  const dto = await fetchSeriesLayout(studyUid, ref.seriesUid);
  if (!dto.imageOrientationPatient || !dto.zSpatial?.length) {
    return "元シリーズに患者座標（IOP/IPP）がありません（SEG / RTDOSE は幾何が要ります）";
  }
  const iop = dto.imageOrientationPatient as number[];
  const n = normalOf(iop);
  if (!n) return "元シリーズの ImageOrientationPatient が不正です";

  const c = Math.min(Math.max(0, ref.c ?? 0), Math.max(0, dto.nC - 1));
  const t = Math.min(Math.max(0, ref.t ?? 0), Math.max(0, dto.nT - 1));
  const sopByZ = new Map<number, string>();
  for (const cell of dto.cells) {
    if (cell.c === c && cell.t === t) sopByZ.set(cell.z, cell.sopInstanceUid);
  }
  const slices: RefSlice[] = [];
  for (const zs of dto.zSpatial) {
    const sop = sopByZ.get(zs.z);
    const ipp = zs.imagePositionPatient;
    if (!sop || !ipp) continue;
    slices.push({ sopInstanceUid: sop, ipp: [ipp[0], ipp[1], ipp[2]] });
  }
  if (!slices.length) return "元シリーズのスライスを解決できません";
  slices.sort((a, b) => {
    const wa = a.ipp[0] * n[0] + a.ipp[1] * n[1] + a.ipp[2] * n[2];
    const wb = b.ipp[0] * n[0] + b.ipp[1] * n[1] + b.ipp[2] * n[2];
    return wa - wb;
  });

  return {
    studyUid,
    rows: dto.imageHeight,
    columns: dto.imageWidth,
    iop,
    pixelSpacing: [dto.pixelSpacingRow || 0, dto.pixelSpacingCol || 0],
    frameOfReferenceUid: dto.frameOfReferenceUID,
    slices,
  };
}

/**
 * プラグインの格子が、元シリーズのスライスと**本当に一致しているか**を検査する。
 *
 * <p>面内の大きさ（rows/cols）とスライス数、そして各スライスの IPP が
 * `ipp + k·sliceStep` と 0.1 mm 以内で一致すること。ここを通さないと、
 * 「1 枚ずれた SEG」「面内にずれた線量」が黙って保存される。
 *
 * @returns 問題があればその説明、無ければ null
 */
function matchGrid(geom: RefGeometry, grid: PluginExportGrid): string | null {
  const [nx, ny, nz] = grid.dims;
  if (nx !== geom.columns || ny !== geom.rows) {
    return `面内の大きさが元シリーズと違います（プラグイン ${nx}×${ny} / 元 ${geom.columns}×${geom.rows}）`;
  }
  if (nz !== geom.slices.length) {
    return `スライス数が元シリーズと違います（プラグイン ${nz} / 元 ${geom.slices.length}）`;
  }
  const tol = 0.1; // mm
  for (let k = 0; k < nz; k++) {
    const expect: Vec3 = [
      grid.ipp[0] + k * grid.sliceStep[0],
      grid.ipp[1] + k * grid.sliceStep[1],
      grid.ipp[2] + k * grid.sliceStep[2],
    ];
    const d = norm(sub(expect, geom.slices[k].ipp));
    if (d > tol) {
      return `z=${k} のスライス位置が元シリーズと ${d.toFixed(3)} mm ずれています`
        + "（ボリュームの並びと元シリーズの並びが一致していません）";
    }
  }
  return null;
}

// ------------------------------------------------------------------
// H22: DICOM SEG
// ------------------------------------------------------------------

export type SegPrepared =
  | { ok: true; request: SegExportRequest; foregroundVoxels: number[]; segmentCount: number }
  | { ok: false; error: string };

/** SEG 書き出しの要求を組み立てる（保存はしない＝確認ダイアログの前に呼ぶ）。 */
export async function prepareSegExport(
  _mode: ViewerMode,
  resolver: StudyResolver,
  req: PluginSegmentationRequest,
  producer: { id: string; name: string; version: string },
): Promise<SegPrepared> {
  const studyUid = req.reference.studyUid ?? resolver(req.reference.seriesUid);
  if (!studyUid) return { ok: false, error: "元シリーズのスタディを解決できません" };
  if (!req.segments?.length) return { ok: false, error: "セグメントが空です" };

  const geom = await refGeometry(req.reference, studyUid);
  if (typeof geom === "string") return { ok: false, error: geom };
  const mismatch = matchGrid(geom, req.grid);
  if (mismatch) return { ok: false, error: mismatch };

  const segments: SegExportSegment[] = [];
  const foreground: number[] = [];
  for (let i = 0; i < req.segments.length; i++) {
    const s = req.segments[i];
    let sliced;
    try {
      sliced = sliceMask(req.grid.dims, s.data);
    } catch (e) {
      return { ok: false, error: `セグメント "${s.label}": ${String(e)}` };
    }
    foreground.push(sliced.foregroundVoxels);
    // 🔴 前景ゼロのセグメントは**入れない**。入れると受け側では
    //   「あるはずのラベルが空」に見え、切り忘れと区別できない。
    if (sliced.foregroundVoxels === 0) continue;
    segments.push({
      number: segments.length + 1,
      label: s.label,
      color: s.color ?? null,
      description: s.description ?? null,
      frames: sliced.planes.map((p) => ({
        sopInstanceUid: geom.slices[p.z].sopInstanceUid,
        imagePositionPatient: geom.slices[p.z].ipp,
        mask: u8ToBase64(p.mask),
      })),
    });
  }
  if (!segments.length) {
    return { ok: false, error: "どのセグメントにも前景がありません（空の SEG は作りません）" };
  }

  const step = norm(req.grid.sliceStep);
  return {
    ok: true,
    segmentCount: segments.length,
    foregroundVoxels: foreground,
    request: {
      studyInstanceUid: studyUid,
      seriesInstanceUid: req.reference.seriesUid,
      rows: geom.rows,
      columns: geom.columns,
      imageOrientationPatient: geom.iop,
      pixelSpacing: geom.pixelSpacing,
      sliceThickness: step > 0 ? step : 1,
      frameOfReferenceUID: geom.frameOfReferenceUid,
      seriesDescription: req.seriesDescription ?? "Segmentation",
      segments,
      // 出所は**本体が付ける**（プラグインに名乗らせない）。
      producer,
    },
  };
}

export const commitSegExport = (request: SegExportRequest) => exportDicomSeg(request);

// ------------------------------------------------------------------
// H23: RTDOSE
// ------------------------------------------------------------------

export type RtDosePrepared =
  | {
      ok: true;
      request: RtDoseExportRequest;
      doseGridScaling: number;
      quantizationErrorGy: number;
      filledVoxels: number;
      maxGy: number;
      frames: number;
    }
  | { ok: false; error: string };

/** RTDOSE 書き出しの要求を組み立てる（保存はしない＝確認ダイアログの前に呼ぶ）。 */
export async function prepareRtDoseExport(
  _mode: ViewerMode,
  resolver: StudyResolver,
  req: PluginRtDoseRequest,
  producer: { id: string; name: string; version: string },
): Promise<RtDosePrepared> {
  const studyUid = req.reference.studyUid ?? resolver(req.reference.seriesUid);
  if (!studyUid) return { ok: false, error: "元シリーズのスタディを解決できません" };

  const [nx, ny, nz] = req.grid.dims;
  if (req.doseGy.length !== nx * ny * nz) {
    return { ok: false, error: `線量の長さが格子と一致しません（期待 ${nx * ny * nz} / 実際 ${req.doseGy.length}）` };
  }

  const geom = await refGeometry(req.reference, studyUid);
  if (typeof geom === "string") return { ok: false, error: geom };
  const mismatch = matchGrid(geom, req.grid);
  if (mismatch) return { ok: false, error: mismatch };

  const offsets = gridFrameOffsets(req.grid.iop, req.grid.sliceStep, nz);
  if (!offsets) {
    return {
      ok: false,
      error: "スライスが面法線と平行に並んでいないため RTDOSE では表せません"
        + "（丸めて書くと受け側で面内にずれます）",
    };
  }

  let q;
  try {
    q = quantizeDoseGrid(req.doseGy, req.backgroundGy);
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }

  return {
    ok: true,
    doseGridScaling: q.doseGridScaling,
    quantizationErrorGy: q.quantizationErrorGy,
    filledVoxels: q.filledVoxels,
    maxGy: q.maxGy,
    frames: nz,
    request: {
      studyInstanceUid: studyUid,
      seriesInstanceUid: req.reference.seriesUid,
      seriesDescription: req.seriesDescription ?? "RT Dose",
      seriesNumber: null,
      rows: ny,
      columns: nx,
      imageOrientationPatient: req.grid.iop,
      imagePositionPatient: req.grid.ipp,
      // DICOM PixelSpacing は [行間隔, 列間隔]。格子の x が列・y が行。
      pixelSpacing: [req.grid.spacing[1], req.grid.spacing[0]],
      gridFrameOffsetVector: offsets,
      doseUnits: "GY",
      doseType: req.doseType ?? "PHYSICAL",
      doseSummationType: req.doseSummationType ?? "PLAN",
      doseComment: req.doseComment ?? null,
      doseGridScaling: q.doseGridScaling,
      tissueHeterogeneityCorrection: req.tissueHeterogeneityCorrection ?? null,
      pixels: u8ToBase64(q.bytes),
      referencedSopInstanceUids: geom.slices.map((s) => s.sopInstanceUid),
      referencedRtPlan: null,
      producer,
    },
  };
}

export const commitRtDoseExport = (request: RtDoseExportRequest) => exportRtDose(request);
