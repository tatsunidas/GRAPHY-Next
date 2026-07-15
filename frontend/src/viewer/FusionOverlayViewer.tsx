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
import type { ImageRect } from "./Viewer2D";
import { imageIdForInstance, type ViewerMode } from "./imageId";
import { getModalityCalibration } from "./pixelCalibration";
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
  const ippArr = plane.imagePositionPatient;
  if (!Array.isArray(ippArr) || ippArr.length < 3) return null;

  // 校正は pixelCalibration に一元化（preScale 二重適用を防ぐ）。fusionEngine は pixels*slope+intercept
  // でモダリティ値を得るため、slope/intercept へ preScale 考慮済みの scale/offset を渡す
  // （preScale 済みなら {1,0} = そのまま HU）。
  const cal = getModalityCalibration(image, imageId);
  const slice: FusionSlice = {
    ipp: [Number(ippArr[0]), Number(ippArr[1]), Number(ippArr[2])],
    pixels: image.getPixelData(),
    slope: cal.scale,
    intercept: cal.offset,
  };
  _sliceCache.set(imageId, slice);
  return slice;
}

/**
 * Fusion オーバーレイビューア。
 *
 * GRAPHY の FusionDisplay 同様、「base 画像と同じキャンバス（表示矩形）」に前景を重ねる。
 * - 前景・背景に IOP/IPP がある場合: `computeFusionSlice` で前景を背景グリッドに再構成（実座標整合）
 * - ない場合: 前景スライスを比例 Z で選び、base 画像矩形にストレッチ（GRAPHY Phase3 相当）
 * いずれも単一 `<canvas>` を base 画像の表示矩形 `rect` に正確に重ねて描画するため、
 * 原点が一致し、画像領域にクリップされ、zoom/pan/fit に追従する。LUT は常に canvas 経由で適用。
 */
export function FusionImageViewer({
  instances,
  mode,
  studyUid,
  seriesUid,
  rect,
  baseImageId,
  baseIndex,
  baseCount,
  overlayC,
  overlayT,
  lut,
  opacity,
  windowCenter,
  windowWidth,
  onAutoWL,
  onLayoutChange,
}: {
  instances: Instance[];
  mode: ViewerMode;
  studyUid: string;
  seriesUid: string;
  /** base 画像の表示矩形（wrap 内 CSS px）。ここに正確に重ねる。 */
  rect: ImageRect;
  /** base の現在スライス imageId（空間 Fusion 用）。 */
  baseImageId: string;
  /** base の現在スライスインデックスと総数（非空間フォールバックの比例 Z 用）。 */
  baseIndex: number;
  baseCount: number;
  overlayC: number;
  overlayT: number;
  /** カラー LUT（null でグレースケール）。 */
  lut?: { r: number[]; g: number[]; b: number[] } | null;
  /** 不透明度（0–1）。 */
  opacity: number;
  /** オーバーレイ W/L の上書き（未指定/null なら DICOM 既定 or 自動 W/L）。 */
  windowCenter?: number | null;
  windowWidth?: number | null;
  /** 実際に用いた既定 W/L（DICOM or 自動）を親へ通知（コントロールバーの初期値シード用）。 */
  onAutoWL?: (center: number, width: number) => void;
  onLayoutChange?: (layout: SeriesLayout) => void;
}) {
  const imageIds = useMemo(
    () => instances.map((i) => imageIdForInstance(mode, i.sopInstanceUid, studyUid, seriesUid)),
    [instances, mode, studyUid, seriesUid],
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
        const built = buildLayoutFromDto(dto, mode, studyUid, seriesUid);
        if (built) setLayout(built);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [studyUid, seriesUid, fallback, mode]);

  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useEffect(() => {
    onLayoutChange?.(layout);
  }, [layout, onLayoutChange]);

  // ── Canvas（base 矩形に重ねる単一キャンバス） ──────────────────
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const computingRef = useRef(false);

  /**
   * 物理値配列 + W/L を canvas に描画する。
   * canvas.width/height は **imperative にのみ**設定する（JSX 属性にすると再レンダ時に
   * React が書き戻して canvas がクリアされ、描画済みオーバーレイが消えるため）。
   */
  const drawValues = useCallback(
    (values: Float32Array, cols: number, rows: number, center: number, width: number, activeLut?: typeof lut) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (canvas.width !== cols) canvas.width = cols;
      if (canvas.height !== rows) canvas.height = rows;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.putImageData(toImageData(values, cols, rows, center, width, activeLut), 0, 0);
    },
    [],
  );

  /** オーバーレイを消去する（前景ボリューム範囲外のスライスなど、何も描かない場合に呼ぶ）。 */
  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  const runFusion = useCallback(async () => {
    if (computingRef.current) return;
    if (!fgDto) return;
    const activeLut = lut;

    // W/L 解決: 上書き値があればそれを、無ければ DICOM 既定 or 自動を用い、既定値は親へ通知。
    const resolveWL = (voiLut: AnyObj, values: Float32Array): { center: number; width: number } => {
      if (typeof windowCenter === "number" && typeof windowWidth === "number" && windowWidth > 0) {
        return { center: windowCenter, width: windowWidth };
      }
      let def: { center: number; width: number };
      if (typeof voiLut.windowCenter === "number" && typeof voiLut.windowWidth === "number" && voiLut.windowWidth > 0) {
        def = { center: voiLut.windowCenter, width: voiLut.windowWidth };
      } else {
        def = autoWindowLevel(values);
      }
      onAutoWL?.(def.center, def.width);
      return def;
    };
    const currentLayout = layoutRef.current;
    const cc = Math.min(Math.max(0, overlayC), currentLayout.nC - 1);
    const tc = Math.min(Math.max(0, overlayT), currentLayout.nT - 1);
    const fgZStack = currentLayout.zStack(cc, tc);
    if (fgZStack.length === 0) return;

    const fgSkeleton = buildFgSkeleton(fgDto);

    // base スライスの空間メタ（取得できれば空間 Fusion）。
    let bgMeta: BackgroundSliceMeta | null = null;
    let bgCols = 0, bgRows = 0;
    if (baseImageId && fgSkeleton) {
      let bgPlane: AnyObj = metaData.get("imagePlaneModule", baseImageId) ?? {};
      if (!bgPlane.imagePositionPatient) {
        try { await imageLoader.loadAndCacheImage(baseImageId); } catch { /* fallthrough */ }
        bgPlane = metaData.get("imagePlaneModule", baseImageId) ?? {};
      }
      const bgPixel: AnyObj = metaData.get("imagePixelModule", baseImageId) ?? {};
      bgCols = (bgPlane.columns as number | undefined) ?? (bgPixel.columns as number | undefined) ?? 512;
      bgRows = (bgPlane.rows as number | undefined) ?? (bgPixel.rows as number | undefined) ?? 512;
      bgMeta = planeToMeta(bgPlane, bgCols, bgRows);
    }

    computingRef.current = true;
    try {
      if (fgSkeleton && bgMeta) {
        // ── 空間 Fusion: 前景を背景グリッドに trilinear リサンプリング ──
        const iop = fgSkeleton.iop;
        const fRr = [iop[0], iop[1], iop[2]];
        const fRc = [iop[3], iop[4], iop[5]];
        const fRs = [fRr[1] * fRc[2] - fRr[2] * fRc[1], fRr[2] * fRc[0] - fRr[0] * fRc[2], fRr[0] * fRc[1] - fRr[1] * fRc[0]];

        const sortedZ = [...fgSkeleton.zSpatialByZ.entries()].sort((a, b) => a[0] - b[0]);
        if (sortedZ.length === 0) return;
        const fgIpp0 = sortedZ[0][1];
        const wPositions = sortedZ.map(([, ipp]) => {
          const d = [ipp[0] - fgIpp0[0], ipp[1] - fgIpp0[1], ipp[2] - fgIpp0[2]];
          return d[0] * fRs[0] + d[1] * fRs[1] + d[2] * fRs[2];
        });

        const bgIpp = bgMeta.ipp;
        const bgToFg = [bgIpp[0] - fgIpp0[0], bgIpp[1] - fgIpp0[1], bgIpp[2] - fgIpp0[2]];
        const w_center = bgToFg[0] * fRs[0] + bgToFg[1] * fRs[1] + bgToFg[2] * fRs[2];

        const sliceSpacing = sortedZ.length > 1 ? Math.abs(wPositions[1] - wPositions[0]) : 5;

        // 背景スライスが前景ボリュームの z 範囲外なら、その断面に前景は存在しない → 消去して終了。
        // （末端スライスへのクランプ描画で「実際にはない場所」にオーバーレイが残るのを防ぐ。）
        let minW = wPositions[0], maxW = wPositions[0];
        for (const wp of wPositions) { if (wp < minW) minW = wp; if (wp > maxW) maxW = wp; }
        const margin = sliceSpacing / 2; // 末端スライスの厚み分だけ許容
        if (w_center < minW - margin || w_center > maxW + margin) {
          clearCanvas();
          return;
        }

        const threshold = Math.max(sliceSpacing * 2, 10); // mm
        const neededZIndices: number[] = [];
        for (let i = 0; i < sortedZ.length; i++) {
          if (Math.abs(wPositions[i] - w_center) <= threshold) neededZIndices.push(i);
        }
        if (neededZIndices.length === 0) {
          let best = 0, bestDist = Infinity;
          for (let i = 0; i < wPositions.length; i++) {
            const d = Math.abs(wPositions[i] - w_center);
            if (d < bestDist) { bestDist = d; best = i; }
          }
          if (best > 0) neededZIndices.push(best - 1);
          neededZIndices.push(best);
          if (best < sortedZ.length - 1) neededZIndices.push(best + 1);
        }

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
        const loadedSlices = sliceResults.filter(
          (r): r is { zIdx: number; slice: FusionSlice } => r !== null,
        );
        if (loadedSlices.length === 0) return;
        loadedSlices.sort((a, b) => a.zIdx - b.zIdx);

        const fgVolume: FusionVolume = {
          iop: fgSkeleton.iop,
          pixelSpacingCol: fgSkeleton.pixelSpacingCol,
          pixelSpacingRow: fgSkeleton.pixelSpacingRow,
          cols: fgSkeleton.cols,
          rows: fgSkeleton.rows,
          slices: loadedSlices.map(({ zIdx, slice }) => {
            const ipp = fgSkeleton.zSpatialByZ.get(zIdx);
            return ipp ? { ...slice, ipp } : slice;
          }),
        };

        const fusionPixels = computeFusionSlice(fgVolume, bgMeta);
        const voiLut: AnyObj = metaData.get("voiLutModule", fgZStack[loadedSlices[0].zIdx] ?? "") ?? {};
        const { center, width } = resolveWL(voiLut, fusionPixels);
        drawValues(fusionPixels, bgCols, bgRows, center, width, activeLut);
      } else {
        // ── 非空間フォールバック: 比例 Z で前景スライスを base 矩形にストレッチ ──
        const frac = baseCount > 1 ? baseIndex / (baseCount - 1) : 0;
        const zi = Math.min(fgZStack.length - 1, Math.max(0, Math.round(frac * (fgZStack.length - 1))));
        const fgId = fgZStack[zi];
        if (!fgId) return;
        let image;
        try { image = await imageLoader.loadAndCacheImage(fgId); } catch { return; }
        const img = image as AnyObj;
        const cols = (img.columns as number | undefined) ?? (img.width as number | undefined) ?? 0;
        const rows = (img.rows as number | undefined) ?? (img.height as number | undefined) ?? 0;
        const pix = img.getPixelData() as ArrayLike<number>;
        if (!cols || !rows || pix.length < cols * rows) return; // カラー等は非対応
        // 校正は pixelCalibration に一元化（preScale 二重適用を防ぐ。preScale 済みなら scale/offset={1,0}）。
        const { scale, offset } = getModalityCalibration(img, fgId);
        const values = new Float32Array(cols * rows);
        for (let i = 0; i < values.length; i++) values[i] = pix[i] * scale + offset;
        const voiLut: AnyObj = metaData.get("voiLutModule", fgId) ?? {};
        const { center, width } = resolveWL(voiLut, values);
        drawValues(values, cols, rows, center, width, activeLut);
      }
    } finally {
      computingRef.current = false;
    }
  }, [baseImageId, baseIndex, baseCount, fgDto, overlayC, overlayT, lut, windowCenter, windowWidth, onAutoWL, drawValues, clearCanvas]);

  useEffect(() => {
    void runFusion();
  }, [runFusion]);

  // base 画像の表示矩形にぴったり重ねる。canvas 内部解像度（再構成 px）は CSS で矩形に伸縮。
  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        opacity,
        pointerEvents: "none",
        imageRendering: "pixelated",
      }}
    />
  );
}
