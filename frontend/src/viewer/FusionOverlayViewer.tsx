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
import { overlayPlacement, type ImageRect } from "./overlayPlacement";
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
import {
  composeTransforms,
  isZeroAdjust,
  manualAdjustToTransform,
  type ManualAdjust,
  type Vec3,
  type WorldTransform,
} from "./regTransform";

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
  adjust,
  registration,
  onAutoWL,
  onSpatialChange,
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
  /**
   * 手動位置合わせ（`fw/registration-design.md` R1）。moving（＝この前景）をどう動かすかの 6 パラメータ。
   * **回転中心は前景ボリュームの中心**で、ここで幾何から算出する（UI に座標を組ませない）。
   * 空間 Fusion（IOP/IPP あり）のときだけ効く。
   */
  adjust?: ManualAdjust | null;
  /**
   * 自動位置合わせ（R3）の結果。fixed world → moving world の変換。
   *
   * <p>手動調整とは**合成**する（`composeTransforms(自動, 手動)`）。手動の 6 値へ
   * 畳み込まないのは、畳み込むと回転中心の幾何を UI 側に持たせることになり、
   * さらに R4 の非剛体が 6 値で表現できないため（設計 §12.1）。
   */
  registration?: WorldTransform | null;
  /** 実際に用いた既定 W/L（DICOM or 自動）を親へ通知（コントロールバーの初期値シード用）。 */
  onAutoWL?: (center: number, width: number) => void;
  /** 空間 Fusion（実座標整合）で描けているかを親へ通知。false のとき手動位置合わせは効かない。 */
  onSpatialChange?: (spatial: boolean) => void;
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

  // 親から渡されるコールバックは ref 越しに呼ぶ（最新値を使いつつ、識別子を依存に載せない）。
  // ⚠ このコンポーネントは `renderOverlay(ctx)` という**レンダプロップの戻り値**として生成される。
  // 親がコールバックをその関数の内側で作っていると毎レンダ別関数になり、依存に載せた瞬間
  // 「毎レンダ再計算 → その中で親へ setState → 再レンダ」の無限ループになる
  // （実際に R1 で発生: Maximum update depth exceeded）。親の書き方に依存しないよう、
  // ここで identity を断ち切る。
  const onAutoWLRef = useRef(onAutoWL);
  onAutoWLRef.current = onAutoWL;
  const onSpatialChangeRef = useRef(onSpatialChange);
  onSpatialChangeRef.current = onSpatialChange;
  const onLayoutChangeRef = useRef(onLayoutChange);
  onLayoutChangeRef.current = onLayoutChange;

  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useEffect(() => {
    onLayoutChangeRef.current?.(layout);
  }, [layout]);

  // 空間 Fusion 可否は**変化したときだけ**親へ通知する（毎回の再計算で setState を撃たない）。
  const lastSpatialRef = useRef<boolean | null>(null);
  const notifySpatial = useCallback((spatial: boolean) => {
    if (lastSpatialRef.current === spatial) return;
    lastSpatialRef.current = spatial;
    onSpatialChangeRef.current?.(spatial);
  }, []);

  // ── Canvas（base 矩形に重ねる単一キャンバス） ──────────────────
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const computingRef = useRef(false);
  const pendingRef = useRef(false);

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
    if (computingRef.current) {
      pendingRef.current = true;
      return;
    }
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
      onAutoWLRef.current?.(def.center, def.width);
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
      // 手動位置合わせが使えるのは空間 Fusion のときだけ。UI が死んだコントロールを出さないよう通知する。
      notifySpatial(!!(fgSkeleton && bgMeta));
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

        let minW = wPositions[0], maxW = wPositions[0];
        for (const wp of wPositions) { if (wp < minW) minW = wp; if (wp > maxW) maxW = wp; }

        // ── 手動位置合わせ（R1）: 回転中心＝前景ボリュームの中心を幾何から算出する ──
        // UI は 6 つの数値しか持たない。座標を UI 側に組ませると実空間の意味が壊れるため
        // （`fw/plugin-architecture.md` H4b の「幾何はプラグインに書かせない」と同じ方針）。
        let xf: WorldTransform | null = null;
        let manual: WorldTransform | null = null;
        if (!isZeroAdjust(adjust)) {
          const halfU = ((fgSkeleton.cols - 1) / 2) * fgSkeleton.pixelSpacingCol;
          const halfV = ((fgSkeleton.rows - 1) / 2) * fgSkeleton.pixelSpacingRow;
          const midW = (minW + maxW) / 2;
          const fgCenter: Vec3 = [
            fgIpp0[0] + halfU * fRr[0] + halfV * fRc[0] + midW * fRs[0],
            fgIpp0[1] + halfU * fRr[1] + halfV * fRc[1] + midW * fRs[1],
            fgIpp0[2] + halfU * fRr[2] + halfV * fRc[2] + midW * fRs[2],
          ];
          manual = manualAdjustToTransform(adjust, fgCenter);
        }
        // 自動（R3）→ 手動（R1）の順に適用する。手動は「自動結果の上に乗せる
        // 微調整」であり、逆順にすると自動をやり直すたびに手の分が別の場所に効く。
        if (registration || manual) {
          const composed = composeTransforms(registration, manual);
          xf = composed.kind === "identity" ? null : composed;
        }

        // 背景スライス上の点を前景法線方向の位置 w に落とす（変換があれば通してから）。
        const xp: Vec3 = [0, 0, 0];
        const wOf = (x: number, y: number, z: number): number => {
          let px = x, py = y, pz = z;
          if (xf) { xf.mapPoint(px, py, pz, xp); px = xp[0]; py = xp[1]; pz = xp[2]; }
          return (px - fgIpp0[0]) * fRs[0] + (py - fgIpp0[1]) * fRs[1] + (pz - fgIpp0[2]) * fRs[2];
        };

        const bgIpp = bgMeta.ipp;
        const w_center = wOf(bgIpp[0], bgIpp[1], bgIpp[2]);

        // 回転が入ると背景スライス内で w が一定でなくなるので、四隅の振れ幅 dev を許容幅に足す。
        // **変換が無いときは dev=0** とし、従来の「IPP 1 点で判定」と完全に同じ挙動を保つ
        // （非平行な背景スライスでの既存挙動を変えないため。厳密化は R3 以降で扱う）。
        let dev = 0;
        if (xf) {
          const bRow = [bgMeta.iop[0], bgMeta.iop[1], bgMeta.iop[2]];
          const bCol = [bgMeta.iop[3], bgMeta.iop[4], bgMeta.iop[5]];
          const extU = (bgMeta.cols - 1) * bgMeta.pixelSpacingCol;
          const extV = (bgMeta.rows - 1) * bgMeta.pixelSpacingRow;
          for (const [u, v] of [[extU, 0], [0, extV], [extU, extV]]) {
            const w = wOf(
              bgIpp[0] + u * bRow[0] + v * bCol[0],
              bgIpp[1] + u * bRow[1] + v * bCol[1],
              bgIpp[2] + u * bRow[2] + v * bCol[2],
            );
            const d = Math.abs(w - w_center);
            if (d > dev) dev = d;
          }
        }

        const sliceSpacing = sortedZ.length > 1 ? Math.abs(wPositions[1] - wPositions[0]) : 5;

        // 背景スライスが前景ボリュームの z 範囲外なら、その断面に前景は存在しない → 消去して終了。
        // （末端スライスへのクランプ描画で「実際にはない場所」にオーバーレイが残るのを防ぐ。）
        const margin = sliceSpacing / 2 + dev; // 末端スライスの厚み分 ＋ 回転による振れ幅
        if (w_center < minW - margin || w_center > maxW + margin) {
          clearCanvas();
          return;
        }

        const threshold = Math.max(sliceSpacing * 2, 10) + dev; // mm
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

        const fusionPixels = computeFusionSlice(fgVolume, bgMeta, xf);
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
      if (pendingRef.current) {
        pendingRef.current = false;
        void runFusion();
      }
    }
    // ⚠ 親のコールバック（onAutoWL / onSpatialChange）は**依存に入れない**。ref 経由で呼んでいる。
    // 入れると、レンダプロップ内で毎レンダ生成される関数によって再計算が毎レンダ走る。
  }, [baseImageId, baseIndex, baseCount, fgDto, overlayC, overlayT, lut, windowCenter, windowWidth,
      adjust, registration, notifySpatial, drawValues, clearCanvas]);

  useEffect(() => {
    void runFusion();
  }, [runFusion]);

  // base 画像の表示矩形にぴったり重ねる。canvas 内部解像度（再構成 px）は CSS で矩形に伸縮。
  return (
    <canvas
      ref={canvasRef}
      style={{
        ...overlayPlacement(rect),
        opacity,
        pointerEvents: "none",
        imageRendering: "pixelated",
      }}
    />
  );
}
