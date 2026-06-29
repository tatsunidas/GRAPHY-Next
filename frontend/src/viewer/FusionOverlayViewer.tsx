/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { imageLoader, metaData } from "@cornerstonejs/core";
import {
  buildSeriesLayout,
  buildLayoutFromDto,
  type SeriesLayout,
} from "./seriesLayout";
import { Viewer2D } from "./Viewer2D";
import { imageIdForInstance, type ViewerMode } from "./imageId";
import { fetchSeriesLayout, type Instance, type SeriesLayoutDto } from "../api";
import {
  computeFusionSlice,
  toImageData,
  autoWindowLevel,
  type FusionVolume,
  type FusionSlice,
  type BackgroundSliceMeta,
} from "./fusionEngine";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

/** Cornerstone3D imagePlaneModule から BackgroundSliceMeta を構築する。 */
function planeToMeta(plane: AnyObj, cols: number, rows: number): BackgroundSliceMeta | null {
  const iop = plane.imageOrientationPatient;
  const ipp = plane.imagePositionPatient;
  if (!Array.isArray(iop) || iop.length < 6 || !Array.isArray(ipp) || ipp.length < 3) return null;
  const colSp = plane.columnPixelSpacing as number ?? 1;
  const rowSp = plane.rowPixelSpacing as number ?? 1;
  return {
    iop: iop as [number, number, number, number, number, number],
    ipp: [Number(ipp[0]), Number(ipp[1]), Number(ipp[2])],
    pixelSpacingCol: colSp,
    pixelSpacingRow: rowSp,
    cols,
    rows,
  };
}

/** SeriesLayoutDto の zSpatial と IOP から FusionVolume のスケルトンを構築（ピクセルなし）。 */
function buildFgSkeleton(dto: SeriesLayoutDto): {
  iop: [number, number, number, number, number, number];
  pixelSpacingCol: number;
  pixelSpacingRow: number;
  cols: number;
  rows: number;
  zSpatialByZ: Map<number, [number, number, number]>;
} | null {
  if (!dto.imageOrientationPatient || !dto.zSpatial?.length) return null;
  const zSpatialByZ = new Map<number, [number, number, number]>();
  for (const s of dto.zSpatial) {
    zSpatialByZ.set(s.z, s.imagePositionPatient);
  }
  return {
    iop: dto.imageOrientationPatient,
    pixelSpacingCol: dto.pixelSpacingCol || 1,
    pixelSpacingRow: dto.pixelSpacingRow || 1,
    cols: dto.imageWidth || 512,
    rows: dto.imageHeight || 512,
    zSpatialByZ,
  };
}

/** imageId → loaded FusionSlice のモジュールレベルキャッシュ。 */
const _sliceCache = new Map<string, FusionSlice>();

/** imageId のピクセルデータと IPP を読み込む（キャッシュあり）。 */
async function loadFusionSlice(imageId: string): Promise<FusionSlice | null> {
  if (_sliceCache.has(imageId)) return _sliceCache.get(imageId)!;

  // IPP がなければ先にメタだけロード
  const plane0: AnyObj = metaData.get("imagePlaneModule", imageId) ?? {};
  if (!plane0.imagePositionPatient) {
    try { await imageLoader.loadAndCacheImage(imageId); } catch { return null; }
  }

  let image;
  try {
    image = await imageLoader.loadAndCacheImage(imageId);
  } catch {
    return null;
  }

  const plane: AnyObj = metaData.get("imagePlaneModule", imageId) ?? {};
  const lut: AnyObj = metaData.get("modalityLutModule", imageId) ?? {};
  const ippArr = plane.imagePositionPatient;
  if (!Array.isArray(ippArr) || ippArr.length < 3) return null;

  const slice: FusionSlice = {
    ipp: [Number(ippArr[0]), Number(ippArr[1]), Number(ippArr[2])],
    pixels: image.getPixelData(),
    slope: (lut.rescaleSlope as number | undefined) ?? (image as AnyObj).slope ?? 1,
    intercept: (lut.rescaleIntercept as number | undefined) ?? (image as AnyObj).intercept ?? 0,
  };
  _sliceCache.set(imageId, slice);
  return slice;
}

/**
 * Fusion オーバーレイビューア。
 *
 * - 前景シリーズの SeriesLayout に IOP/IPP が含まれる場合: canvas trilinear 精密 Fusion
 * - 含まれない場合: CSS opacity Viewer2D（比例 Z 追従フォールバック）
 */
export function FusionImageViewer({
  instances,
  mode,
  studyUid,
  seriesUid,
  syncSlice,
  syncImageId,
  overlayC,
  overlayT,
  lut,
  onLayoutChange,
}: {
  instances: Instance[];
  mode: ViewerMode;
  studyUid: string;
  seriesUid: string;
  /** ベースビューアのスライス位置（フォールバック比例追従用）。 */
  syncSlice: { z: number; nZ: number } | null;
  /** ベースビューアの現在スライス imageId（精密 Fusion 用）。 */
  syncImageId: string | null;
  overlayC: number;
  overlayT: number;
  /** カラー LUT（null でグレースケール）。 */
  lut?: { r: number[]; g: number[]; b: number[] } | null;
  onLayoutChange?: (layout: SeriesLayout) => void;
}) {
  const imageIds = useMemo(
    () => instances.map((i) => imageIdForInstance(mode, i.sopInstanceUid)),
    [instances, mode],
  );
  const imageIdBySop = useMemo(
    () => new Map(instances.map((i) => [i.sopInstanceUid, imageIdForInstance(mode, i.sopInstanceUid)])),
    [instances, mode],
  );
  const fallback = useMemo(() => buildSeriesLayout(imageIds), [imageIds]);
  const [layout, setLayout] = useState<SeriesLayout>(fallback);
  const [fgDto, setFgDto] = useState<SeriesLayoutDto | null>(null);

  // FG レイアウト取得（空間メタ込み）
  useEffect(() => {
    setLayout(fallback);
    let cancelled = false;
    fetchSeriesLayout(studyUid, seriesUid)
      .then((dto) => {
        if (cancelled) return;
        setFgDto(dto);
        const built = buildLayoutFromDto(dto, imageIdBySop);
        if (built) setLayout(built);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [studyUid, seriesUid, fallback, imageIdBySop]);

  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useEffect(() => {
    onLayoutChange?.(layout);
  }, [layout, onLayoutChange]);

  // ── CSS フォールバック用 Z 追従 ─────────────────────────────
  const cc = Math.min(Math.max(0, overlayC), layout.nC - 1);
  const tc = Math.min(Math.max(0, overlayT), layout.nT - 1);
  const zStack = layout.zStack(cc, tc);
  const nZ = zStack.length;
  const [z, setZ] = useState(0);
  useEffect(() => {
    if (!syncSlice || syncSlice.nZ <= 0 || nZ <= 0) return;
    const frac = syncSlice.z / Math.max(1, syncSlice.nZ - 1);
    setZ(Math.round(frac * Math.max(0, nZ - 1)));
  }, [syncSlice, nZ]);
  const zc = Math.min(Math.max(0, z), nZ - 1);

  // ── Canvas 精密 Fusion ──────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number } | null>(null);
  const computingRef = useRef(false);
  // キャンバスに少なくとも 1 フレーム描画されたかどうか。
  // false の間はフォールバック Viewer2D を表示し、空白キャンバスが透けるのを防ぐ。
  const [hasCanvasContent, setHasCanvasContent] = useState(false);

  // シリーズが切り替わったらキャンバス状態をリセット。
  useEffect(() => {
    setHasCanvasContent(false);
  }, [studyUid, seriesUid]);

  const runFusion = useCallback(async () => {
    if (computingRef.current) return;
    if (!syncImageId || !fgDto) return;
    // lut は useCallback の外スコープから参照（依存配列に追加済み）
    const activeLut = lut;

    const fgSkeleton = buildFgSkeleton(fgDto);
    if (!fgSkeleton) return; // 空間メタなし → フォールバック

    // 背景スライスのメタ取得
    let bgPlane: AnyObj = metaData.get("imagePlaneModule", syncImageId) ?? {};
    if (!bgPlane.imagePositionPatient) {
      try { await imageLoader.loadAndCacheImage(syncImageId); } catch { return; }
      bgPlane = metaData.get("imagePlaneModule", syncImageId) ?? {};
    }
    const bgPixel: AnyObj = metaData.get("imagePixelModule", syncImageId) ?? {};
    const bgCols = (bgPlane.columns as number | undefined) ?? (bgPixel.columns as number | undefined) ?? 512;
    const bgRows = (bgPlane.rows as number | undefined) ?? (bgPixel.rows as number | undefined) ?? 512;

    const bgMeta = planeToMeta(bgPlane, bgCols, bgRows);
    if (!bgMeta) return;

    // 前景スライス法線 fRs = cross(fRr, fRc)
    const iop = fgSkeleton.iop;
    const fRr = [iop[0], iop[1], iop[2]];
    const fRc = [iop[3], iop[4], iop[5]];
    const fRs = [fRr[1] * fRc[2] - fRr[2] * fRc[1], fRr[2] * fRc[0] - fRr[0] * fRc[2], fRr[0] * fRc[1] - fRr[1] * fRc[0]];

    // zSpatial を z 昇順に並べ、wPositions（前景 z 法線距離）を計算
    const sortedZ = [...fgSkeleton.zSpatialByZ.entries()].sort((a, b) => a[0] - b[0]);
    if (sortedZ.length === 0) return;
    const fgIpp0 = sortedZ[0][1];
    const wPositions = sortedZ.map(([, ipp]) => {
      const d = [ipp[0] - fgIpp0[0], ipp[1] - fgIpp0[1], ipp[2] - fgIpp0[2]];
      return d[0] * fRs[0] + d[1] * fRs[1] + d[2] * fRs[2];
    });

    // 背景スライス中心の前景 z 位置（どのスライスを読む必要があるか）
    const bgIpp = bgMeta.ipp;
    const bgToFg = [bgIpp[0] - fgIpp0[0], bgIpp[1] - fgIpp0[1], bgIpp[2] - fgIpp0[2]];
    const w_center = bgToFg[0] * fRs[0] + bgToFg[1] * fRs[1] + bgToFg[2] * fRs[2];

    // 必要な前景スライスインデックスを特定（center ± threshold の範囲）
    const sliceSpacing = sortedZ.length > 1 ? Math.abs(wPositions[1] - wPositions[0]) : 5;
    const threshold = Math.max(sliceSpacing * 2, 10); // mm
    const neededZIndices: number[] = [];
    const currentLayout = layoutRef.current;
    const fgZStack = currentLayout.zStack(
      Math.min(Math.max(0, overlayC), currentLayout.nC - 1),
      Math.min(Math.max(0, overlayT), currentLayout.nT - 1),
    );
    for (let i = 0; i < sortedZ.length; i++) {
      if (Math.abs(wPositions[i] - w_center) <= threshold) {
        neededZIndices.push(i);
      }
    }
    if (neededZIndices.length === 0) {
      // フォールバック: 最近傍スライスを 3 枚（trilinear のため前後も含む）
      let best = 0, bestDist = Infinity;
      for (let i = 0; i < wPositions.length; i++) {
        const d = Math.abs(wPositions[i] - w_center);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      if (best > 0) neededZIndices.push(best - 1);
      neededZIndices.push(best);
      if (best < sortedZ.length - 1) neededZIndices.push(best + 1);
    }

    // 前景スライスのピクセルデータを並列ロード
    computingRef.current = true;
    try {
      const sliceResults = await Promise.all(
        neededZIndices.map(async (i) => {
          const zIdx = sortedZ[i][0];
          const imageId = fgZStack[zIdx];
          if (!imageId) return null;
          const slice = await loadFusionSlice(imageId);
          if (!slice) return null;
          return { zIdx, slice };
        }),
      );

      // ロードできたスライスで FusionVolume を構築
      const loadedSlices: Array<{ zIdx: number; slice: FusionSlice }> =
        sliceResults.filter((r): r is { zIdx: number; slice: FusionSlice } => r !== null);
      if (loadedSlices.length === 0) return;

      // z 昇順でソート
      loadedSlices.sort((a, b) => a.zIdx - b.zIdx);

      const fgVolume: FusionVolume = {
        iop: fgSkeleton.iop,
        pixelSpacingCol: fgSkeleton.pixelSpacingCol,
        pixelSpacingRow: fgSkeleton.pixelSpacingRow,
        cols: fgSkeleton.cols,
        rows: fgSkeleton.rows,
        slices: loadedSlices.map(({ zIdx, slice }) => {
          // IPP は backend zSpatial から使う（Cornerstone3D ロード済みなので上書き不要だが念のため）
          const ipp = fgSkeleton.zSpatialByZ.get(zIdx);
          return ipp ? { ...slice, ipp } : slice;
        }),
      };

      // Trilinear リサンプリング
      const fusionPixels = computeFusionSlice(fgVolume, bgMeta);

      // W/L 決定
      const voiLut: AnyObj = metaData.get("voiLutModule", fgZStack[loadedSlices[0].zIdx] ?? "") ?? {};
      let center: number, width: number;
      const wc = voiLut.windowCenter;
      const ww = voiLut.windowWidth;
      if (typeof wc === "number" && typeof ww === "number" && ww > 0) {
        center = wc; width = ww;
      } else {
        const auto = autoWindowLevel(fusionPixels);
        center = auto.center; width = auto.width;
      }

      // Canvas への描画
      const canvas = canvasRef.current;
      if (!canvas) return;
      setCanvasSize({ w: bgCols, h: bgRows });
      // canvasSize の更新と canvas.width/height の設定は同期が必要
      canvas.width = bgCols;
      canvas.height = bgRows;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const imgData = toImageData(fusionPixels, bgCols, bgRows, center, width, activeLut);
      ctx.putImageData(imgData, 0, 0);
      setHasCanvasContent(true);
    } finally {
      computingRef.current = false;
    }
  }, [syncImageId, fgDto, overlayC, overlayT, lut]);

  useEffect(() => {
    void runFusion();
  }, [runFusion]);

  // ── Render ─────────────────────────────────────────────────

  // IOP/IPP 空間メタの有無（前景シリーズ）。
  const hasSpatial = !!(fgDto?.imageOrientationPatient && fgDto.zSpatial?.length);

  // Canvas Fusion を表示するのは「空間メタあり & syncImageId あり & 1 フレーム描画済み」の場合のみ。
  // それ以外（計算待ち・空間メタなし・背景 IOP/IPP なし）はフォールバック Viewer2D を表示する。
  const showCanvas = hasSpatial && !!syncImageId && hasCanvasContent;

  if (!showCanvas) {
    // フォールバック: 比例 Z 追従 Viewer2D（常に何かを表示する）
    if (zStack.length === 0) return null;
    return (
      <Viewer2D
        imageIds={zStack}
        imageIndex={zc}
        compact
        fill
        overlays={{ text: false, caliper: false, orientation: false }}
      />
    );
  }

  return (
    <canvas
      ref={canvasRef}
      width={canvasSize?.w ?? 512}
      height={canvasSize?.h ?? 512}
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        maxWidth: "100%",
        maxHeight: "100%",
        imageRendering: "pixelated",
      }}
    />
  );
}
