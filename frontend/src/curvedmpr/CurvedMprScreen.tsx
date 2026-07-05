/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Curved MPR ウィンドウ（P4）。旧 GRAPHY `2D Viewer > Image > Curved MPR...`
 * （`CurvedMprDialog` / `CurvedMprCurvePanel` / `CurvedReformatter` / `VolumeSampler` / `VolumeLoader`）の移植。
 *
 * **cornerstone のビューポート/座標変換は使わない**（GRAPHY と同じく自前）:
 * - `buildDicomResliceVolume`（≒ `VolumeLoader.loadVolumeData`）: DICOM 実 IPP/IOP/PixelSpacing で
 *   患者座標系(LPS mm) の 3D ボリュームを組み立てる（値は実ピクセル、未 prescale のみ rescale→HU）。
 * - 参照スライスを**自前 canvas に描画**し、**画面px→画像px→物理(LPS)** を `toPhysical/toVoxelIndex`
 *   （≒ `VolumeSampler`）で直接変換（＝旧 `CurvedMprCurvePanel` の scale＋sampler 方式）。
 * - 曲線＋再構成は `viewer/centerline.ts`（`Centerline3D`）/ `viewer/curvedReformat.ts`（`CurvedReformatter`,
 *   サンプラ＝`viewer/reslice.ts` の `makeWorldSampler`＝`VolumeSampler.sampleTrilinear` 相当・純関数）。
 *
 * 操作: 参照上でダブルクリック＝点追加 / ドラッグ＝移動 / 右クリック＝削除 / ホイール＝スライス / 右ドラッグ＝W/L。
 * 起動: `localStorage("graphy-curvedmpr-ctx")`（2D ビューアの View メニュー）。standalone のみ。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { imageLoader, metaData, cache } from "@cornerstonejs/core";
import { fetchSeries, fetchInstances, fetchSeriesLayout, prefetchSeries, type AppStatus, type Study, type Series, type SeriesLayoutDto } from "../api";
import { ensureCornerstoneInitialized } from "../viewer/cornerstoneSetup";
import { imageIdForInstance, imageIdForCell } from "../viewer/imageId";
import { type ResliceVolume, type Vec3 } from "../viewer/reslice";
import { Centerline3D, type FrameMode } from "../viewer/centerline";
import { reformat, defaultCurvedParams, type ProjectionMode, type CurvedResult } from "../viewer/curvedReformat";
import { httpSend } from "../http";
import { emitDbChanged } from "../dbEvents";
import { useI18n } from "../i18n/i18n";

const FRAME_MODES: FrameMode[] = ["FIXED_Z", "ROTATION_MINIMIZING"];
const PROJECTION_MODES: ProjectionMode[] = ["CENTERLINE_ONLY", "AVERAGE", "MIP", "MINIP"];

interface CurvedMprContext {
  study: Study;
  series?: Series;
  c?: number;
  t?: number;
  ts: number;
}

type Phase = "idle" | "loading" | "ready" | "error" | "unsupported";

interface CurveParamsUi {
  frameMode: FrameMode;
  projectionMode: ProjectionMode;
  bandHalfWidthMm: number;
  secondAxisMinMm: number;
  secondAxisMaxMm: number;
}

interface WL {
  center: number;
  width: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

// ── ベクトル小道具 ─────────────────────────────────────────────
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};
const clampInt = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(v)));

// ── VolumeSampler 相当（純関数・direction は正規直交前提） ──
/** 物理(LPS mm) → 連続ボクセル index (i,j,k)。 */
function toVoxelIndex(vol: ResliceVolume, p: Vec3): Vec3 {
  const d = vol.direction, o = vol.origin, s = vol.spacing;
  const dx = p[0] - o[0], dy = p[1] - o[1], dz = p[2] - o[2];
  return [
    (dx * d[0] + dy * d[1] + dz * d[2]) / s[0],
    (dx * d[3] + dy * d[4] + dz * d[5]) / s[1],
    (dx * d[6] + dy * d[7] + dz * d[8]) / s[2],
  ];
}
/** 連続ボクセル index (i,j,k) → 物理(LPS mm)。 */
function toPhysical(vol: ResliceVolume, i: number, j: number, k: number): Vec3 {
  const d = vol.direction, o = vol.origin, s = vol.spacing;
  const a = i * s[0], b = j * s[1], c = k * s[2];
  return [
    o[0] + d[0] * a + d[3] * b + d[6] * c,
    o[1] + d[1] * a + d[4] * b + d[7] * c,
    o[2] + d[2] * a + d[5] * b + d[8] * c,
  ];
}

/** Int16Array を Int16LE バイト列とみなして Base64 化。 */
function framePixelsBase64(frame: Int16Array): string {
  const bytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

/** レイアウトから (c,t) 固定の単一 Z スタック imageIds を取り出す（z 昇順）。 */
function imageIdsForCT(
  layout: SeriesLayoutDto,
  mode: "standalone" | "web",
  c: number,
  t: number,
  studyUid: string,
  seriesUid: string,
): string[] {
  return layout.cells
    .filter((cell) => cell.c === c && cell.t === t)
    .slice()
    .sort((a, b) => a.z - b.z)
    .map((cell) => imageIdForCell(mode, cell.sopInstanceUid, cell.frame, studyUid, seriesUid));
}

/**
 * DICOM 実 IPP/IOP から患者座標系(LPS mm) の 3D ボリュームを構築（≒ GRAPHY `VolumeLoader.loadVolumeData`）。
 * origin=法線ソート先頭スライスの IPP、dirK=IPP 進行方向、spacing_z=IPP 間隔。値は実ピクセル
 * （未 prescale のみ rescale→HU。getPixelData が既に HU を返す設定での二重適用＝空気値化を防ぐ）。
 */
async function buildDicomResliceVolume(imageIds: string[]): Promise<ResliceVolume | null> {
  try {
    await Promise.all(imageIds.map((id) => imageLoader.loadAndCacheImage(id).catch(() => null)));
    const plane0: AnyObj = metaData.get("imagePlaneModule", imageIds[0]) ?? {};
    const iopRaw = plane0.imageOrientationPatient;
    if (!Array.isArray(iopRaw) || iopRaw.length < 6) return null;
    const iop = iopRaw.map(Number);
    const rowCos: Vec3 = [iop[0], iop[1], iop[2]];
    const colCos: Vec3 = [iop[3], iop[4], iop[5]];
    const normal = normalize(cross(rowCos, colCos));
    const cols = Number(plane0.columns);
    const rows = Number(plane0.rows);
    if (!cols || !rows) return null;
    const ps = plane0.pixelSpacing ?? [1, 1];
    const psY = Number(ps[0]) || 1;
    const psX = Number(ps[1]) || 1;

    const recs: Array<{ id: string; ipp: Vec3 }> = [];
    for (const id of imageIds) {
      const p: AnyObj = metaData.get("imagePlaneModule", id) ?? {};
      const ipp = p.imagePositionPatient;
      if (!Array.isArray(ipp) || ipp.length < 3) continue;
      recs.push({ id, ipp: [Number(ipp[0]), Number(ipp[1]), Number(ipp[2])] });
    }
    if (recs.length < 2) return null;
    recs.sort((a, b) => dot(a.ipp, normal) - dot(b.ipp, normal));

    const D = recs.length;
    const origin = recs[0].ipp;
    const spanVec = sub(recs[D - 1].ipp, origin);
    const span = Math.hypot(spanVec[0], spanVec[1], spanVec[2]);
    const sliceSpacing = span / (D - 1) || Number(plane0.sliceThickness) || 1;
    const dirK: Vec3 = span > 1e-6 ? normalize(spanVec) : normal;

    const sliceLen = cols * rows;
    const out = new Int16Array(sliceLen * D);
    let filled = 0;
    let min = Infinity;
    for (let k = 0; k < D; k++) {
      const id = recs[k].id;
      const plane: AnyObj = metaData.get("imagePlaneModule", id) ?? {};
      if (Number(plane.columns || cols) !== cols || Number(plane.rows || rows) !== rows) continue;
      const img = cache.getImage(id) as AnyObj | undefined;
      if (!img?.getPixelData) continue;
      const px = img.getPixelData() as ArrayLike<number>;
      if (!px || px.length < sliceLen) continue;
      const preScaled = !!(img.preScale && img.preScale.scaled);
      const lut: AnyObj = metaData.get("modalityLutModule", id) ?? {};
      const slope = preScaled ? 1 : Number((lut.rescaleSlope ?? img.slope) ?? 1);
      const intercept = preScaled ? 0 : Number((lut.rescaleIntercept ?? img.intercept) ?? 0);
      const base = k * sliceLen;
      for (let i = 0; i < sliceLen; i++) {
        const v = Math.round(px[i] * slope + intercept);
        out[base + i] = v;
        if (v < min) min = v;
      }
      filled++;
    }
    if (filled < 2) return null;
    if (!Number.isFinite(min)) min = 0;
    const direction = [rowCos[0], rowCos[1], rowCos[2], colCos[0], colCos[1], colCos[2], dirK[0], dirK[1], dirK[2]];
    return { data: out, dimensions: [cols, rows, D], spacing: [psX, psY, sliceSpacing], origin, direction, airValue: min };
  } catch {
    return null;
  }
}

/** ボリューム中央スライスから妥当な W/L 既定を推定（CT は HU 窓、その他はデータ範囲）。 */
function defaultWL(vol: ResliceVolume, modality: string | null): WL {
  if ((modality ?? "").toUpperCase() === "CT") return { center: 40, width: 400 };
  const [W, H, D] = vol.dimensions;
  const base = Math.floor(D / 2) * W * H;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < W * H; i++) {
    const v = vol.data[base + i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || max <= min) return { center: 0, width: 1 };
  return { center: (min + max) / 2, width: max - min };
}

export function CurvedMprScreen({ status }: { status: AppStatus | null }) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const refCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const sliceCanvasRef = useRef<HTMLCanvasElement | null>(null); // 現在スライスのオフスクリーン（W×H）
  const startedRef = useRef(false);
  const volRef = useRef<ResliceVolume | null>(null);
  const curveRef = useRef<Centerline3D>(new Centerline3D());
  const viewRef = useRef<{ scale: number; offsetX: number; offsetY: number }>({ scale: 1, offsetX: 0, offsetY: 0 });
  const dragRef = useRef<{ index: number } | null>(null);
  const wlDragRef = useRef<{ x: number; y: number; center: number; width: number } | null>(null);
  const resultRef = useRef<CurvedResult | null>(null);
  const srcStudyRef = useRef<string>("");
  const srcSeriesRef = useRef<string>("");
  const srcDescRef = useRef<string>("");
  const outSpacingRef = useRef<number>(1);

  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [sliceZ, setSliceZ] = useState(0);
  const [wl, setWl] = useState<WL>({ center: 40, width: 400 });
  const [params, setParams] = useState<CurveParamsUi>({
    frameMode: "FIXED_Z",
    projectionMode: "CENTERLINE_ONLY",
    bandHalfWidthMm: 0,
    secondAxisMinMm: -50,
    secondAxisMaxMm: 50,
  });
  const [curveVersion, setCurveVersion] = useState(0);
  const [previewInfo, setPreviewInfo] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [dimInfo, setDimInfo] = useState<{ nC: number; nT: number; c: number; t: number } | null>(null);
  const [hover, setHover] = useState<{ world: Vec3; hu: number } | null>(null);

  const paramsRef = useRef(params);
  paramsRef.current = params;
  const sliceZRef = useRef(sliceZ);
  sliceZRef.current = sliceZ;
  const wlRef = useRef(wl);
  wlRef.current = wl;

  const mode = status?.mode === "standalone" ? "standalone" : "web";

  // ── 参照スライスのオフスクリーン再構築（sliceZ / W/L 変更時のみの重い処理） ──
  const rebuildSliceOffscreen = useCallback(() => {
    const vol = volRef.current;
    if (!vol) return;
    const [W, H, D] = vol.dimensions;
    const z = clampInt(sliceZRef.current, 0, D - 1);
    let off = sliceCanvasRef.current;
    if (!off) {
      off = document.createElement("canvas");
      sliceCanvasRef.current = off;
    }
    off.width = W;
    off.height = H;
    const octx = off.getContext("2d");
    if (!octx) return;
    const { center, width } = wlRef.current;
    const lower = center - width / 2;
    const range = Math.max(1e-6, width);
    const img = octx.createImageData(W, H);
    const base = z * W * H;
    for (let p = 0; p < W * H; p++) {
      let v = (vol.data[base + p] - lower) / range;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      const g = Math.round(v * 255);
      const o = p * 4;
      img.data[o] = g;
      img.data[o + 1] = g;
      img.data[o + 2] = g;
      img.data[o + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
  }, []);

  // ── 参照 canvas 描画（スライス drawImage＋曲線オーバーレイ）。scale/offset を viewRef に保存 ──
  const drawReference = useCallback(() => {
    const canvas = refCanvasRef.current;
    const container = containerRef.current;
    const vol = volRef.current;
    const off = sliceCanvasRef.current;
    if (!canvas || !container || !vol || !off) return;
    const cw = Math.max(1, container.clientWidth);
    const ch = Math.max(1, container.clientHeight);
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cw, ch);
    const [W, H] = vol.dimensions;
    const scale = Math.min(cw / W, ch / H);
    const dw = W * scale;
    const dh = H * scale;
    const offsetX = (cw - dw) / 2;
    const offsetY = (ch - dh) / 2;
    viewRef.current = { scale, offsetX, offsetY };
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, offsetX, offsetY, dw, dh);

    // 曲線（画面px = toVoxelIndex(物理)→画像px→×scale+offset）。
    const curve = curveRef.current;
    const n = curve.size();
    const scr = (i: number): [number, number] => {
      const idx = toVoxelIndex(vol, curve.getControlPoint(i));
      return [idx[0] * scale + offsetX, idx[1] * scale + offsetY];
    };
    if (n >= 2) {
      ctx.strokeStyle = "#ffd200";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const [sx, sy] = scr(i);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
    }
    for (let i = 0; i < n; i++) {
      const [sx, sy] = scr(i);
      ctx.fillStyle = "#ffa030";
      ctx.beginPath();
      ctx.arc(sx, sy, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }, []);

  const redrawAll = useCallback(() => {
    rebuildSliceOffscreen();
    drawReference();
  }, [rebuildSliceOffscreen, drawReference]);

  // 画面px → 画像px(i,j)（scale/offset の逆）。
  const screenToImage = useCallback((sx: number, sy: number): [number, number] => {
    const { scale, offsetX, offsetY } = viewRef.current;
    return [(sx - offsetX) / scale, (sy - offsetY) / scale];
  }, []);

  // ── プレビュー再構成＋描画 ──
  const recomputePreview = useCallback(() => {
    const vol = volRef.current;
    const curve = curveRef.current;
    const canvas = previewCanvasRef.current;
    if (!vol || !canvas) return;
    if (curve.size() < 2) {
      resultRef.current = null;
      canvas.width = 1;
      canvas.height = 1;
      canvas.getContext("2d")?.clearRect(0, 0, 1, 1);
      setPreviewInfo(t("curvedMpr.needPoints"));
      return;
    }
    const p = paramsRef.current;
    const step = outSpacingRef.current;
    const cp = defaultCurvedParams();
    cp.arcStepMm = step;
    cp.secondAxisStepMm = step;
    cp.secondAxisMinMm = p.secondAxisMinMm;
    cp.secondAxisMaxMm = p.secondAxisMaxMm;
    cp.frameMode = p.frameMode;
    cp.projectionMode = p.projectionMode;
    cp.bandHalfWidthMm = p.bandHalfWidthMm;
    cp.bandSampleCount = 9;
    cp.outOfBoundsValue = vol.airValue ?? 0;

    let result: CurvedResult;
    try {
      result = reformat(curve, vol, cp);
    } catch (e) {
      setPreviewInfo(`${t("curvedMpr.error")}: ${String(e)}`);
      return;
    }
    resultRef.current = result;

    const { center, width } = wlRef.current;
    const lower = center - width / 2;
    const range = Math.max(1e-6, width);
    const img = new ImageData(result.width, result.height);
    for (let i = 0; i < result.pixels.length; i++) {
      let v = (result.pixels[i] - lower) / range;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      const g = Math.round(v * 255);
      const o = i * 4;
      img.data[o] = g;
      img.data[o + 1] = g;
      img.data[o + 2] = g;
      img.data[o + 3] = 255;
    }
    canvas.width = result.width;
    canvas.height = result.height;
    canvas.getContext("2d")?.putImageData(img, 0, 0);
    setPreviewInfo(
      t("curvedMpr.previewInfo", { w: String(result.width), h: String(result.height), px: step.toFixed(2) }),
    );
  }, [t]);

  // ── 起動 ──
  const start = useCallback(async () => {
    let ctx: CurvedMprContext | null = null;
    try {
      const raw = localStorage.getItem("graphy-curvedmpr-ctx");
      if (raw) ctx = JSON.parse(raw) as CurvedMprContext;
    } catch {
      ctx = null;
    }
    if (!ctx?.study) {
      setPhase("error");
      setMessage(t("curvedMpr.noContext"));
      return;
    }
    // web も対応: imageId は BFF(WADO-RS) 経由の wadouri。reslice 用 volume は cornerstone が
    // 各スライスを BFF から読み込んで構築する（standalone と同一経路。参照/展開は自前 canvas 描画）。
    setPhase("loading");
    setMessage(t("curvedMpr.loading"));
    try {
      await ensureCornerstoneInitialized();
      let series = ctx.series;
      if (!series) {
        const list = await fetchSeries(ctx.study.studyInstanceUid);
        series = list.slice().sort((a, b) => b.numberOfInstances - a.numberOfInstances)[0];
      }
      if (!series) {
        setPhase("error");
        setMessage(t("curvedMpr.noSeries"));
        return;
      }
      setTitle(series.seriesDescription || series.seriesInstanceUid);
      srcStudyRef.current = ctx.study.studyInstanceUid;
      srcSeriesRef.current = series.seriesInstanceUid;
      srcDescRef.current = series.seriesDescription || "";

      let imageIds: string[];
      let c0 = 0;
      let t0 = 0;
      try {
        const layout = await fetchSeriesLayout(ctx.study.studyInstanceUid, series.seriesInstanceUid);
        c0 = Math.min(Math.max(0, ctx.c ?? 0), Math.max(0, layout.nC - 1));
        t0 = Math.min(Math.max(0, ctx.t ?? 0), Math.max(0, layout.nT - 1));
        setDimInfo({ nC: layout.nC, nT: layout.nT, c: c0, t: t0 });
        imageIds = imageIdsForCT(layout, mode, c0, t0, ctx.study.studyInstanceUid, series.seriesInstanceUid);
        if (imageIds.length < 3 && layout.nC <= 1 && layout.nT <= 1) {
          const instances = await fetchInstances(ctx.study.studyInstanceUid, series.seriesInstanceUid);
          imageIds = instances.map((i) =>
            imageIdForInstance(mode, i.sopInstanceUid, ctx.study.studyInstanceUid, series.seriesInstanceUid),
          );
        }
      } catch {
        const instances = await fetchInstances(ctx.study.studyInstanceUid, series.seriesInstanceUid);
        imageIds = instances.map((i) =>
          imageIdForInstance(mode, i.sopInstanceUid, ctx.study.studyInstanceUid, series.seriesInstanceUid),
        );
      }
      if (imageIds.length < 3) {
        setPhase("error");
        setMessage(t("curvedMpr.needVolume"));
        return;
      }

      // web: 全スライスを 1 リクエストで BFF キャッシュに載せてから volume 構築（個別 WADO-RS 往復を回避）。
      if (mode === "web") {
        try {
          await prefetchSeries(ctx.study.studyInstanceUid, series.seriesInstanceUid);
        } catch {
          /* prefetch は最適化。失敗しても個別取得で続行 */
        }
      }

      const vol = await buildDicomResliceVolume(imageIds);
      if (!vol) {
        setPhase("error");
        setMessage(t("curvedMpr.needVolume"));
        return;
      }
      volRef.current = vol;
      const inPlane = (vol.spacing[0] + vol.spacing[1]) / 2;
      outSpacingRef.current = Math.max(0.1, inPlane);
      const midZ = Math.floor(vol.dimensions[2] / 2);
      setSliceZ(midZ);
      sliceZRef.current = midZ;
      const wl0 = defaultWL(vol, series.modality);
      setWl(wl0);
      wlRef.current = wl0;
      // 第2軸の既定範囲 = 頭尾方向（積層）全長を中央対称に（旧実装 zExtent）。
      const zExtent = vol.spacing[2] * (vol.dimensions[2] - 1);
      const half = Math.max(10, zExtent / 2);
      setParams((p) => ({ ...p, secondAxisMinMm: -half, secondAxisMaxMm: half }));

      setPhase("ready");
      requestAnimationFrame(() => {
        redrawAll();
        recomputePreview();
      });
    } catch (e) {
      setPhase("error");
      setMessage(`${t("curvedMpr.error")}: ${String(e)}`);
    }
  }, [mode, t, redrawAll, recomputePreview]);

  useEffect(() => {
    if (startedRef.current || !status) return;
    startedRef.current = true;
    void start();
  }, [status, start]);

  // sliceZ / W/L 変更 → スライス再構築＋再描画。
  useEffect(() => {
    if (phase === "ready") redrawAll();
  }, [phase, sliceZ, wl, redrawAll]);

  // 曲線変更 → 参照再描画（軽量）。
  useEffect(() => {
    if (phase === "ready") drawReference();
  }, [phase, curveVersion, drawReference]);

  // パラメータ変更 → プレビュー再計算。
  useEffect(() => {
    if (phase === "ready") recomputePreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, phase]);

  // W/L 変更 → プレビュー階調も更新。
  useEffect(() => {
    if (phase === "ready") recomputePreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wl]);

  // リサイズ → 再描画（scale/offset 再計算）。
  useEffect(() => {
    const onResize = () => {
      if (phase === "ready") drawReference();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [phase, drawReference]);

  // ── マウス操作 ──
  const findPointAt = useCallback((sx: number, sy: number): number => {
    const vol = volRef.current;
    if (!vol) return -1;
    const { scale, offsetX, offsetY } = viewRef.current;
    const curve = curveRef.current;
    for (let i = 0; i < curve.size(); i++) {
      const idx = toVoxelIndex(vol, curve.getControlPoint(i));
      const px = idx[0] * scale + offsetX;
      const py = idx[1] * scale + offsetY;
      if ((px - sx) * (px - sx) + (py - sy) * (py - sy) <= 100) return i; // 10px
    }
    return -1;
  }, []);

  const onCanvasDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const vol = volRef.current;
      const canvas = refCanvasRef.current;
      if (!vol || !canvas || e.button !== 0) return;
      const rect = canvas.getBoundingClientRect();
      const [i, j] = screenToImage(e.clientX - rect.left, e.clientY - rect.top);
      const w = toPhysical(vol, i, j, sliceZRef.current);
      curveRef.current.addControlPoint(w);
      setCurveVersion((v) => v + 1);
      recomputePreview();
    },
    [screenToImage, recomputePreview],
  );

  const onCanvasPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const canvas = refCanvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const idx = findPointAt(sx, sy);
      if (e.button === 2) {
        // 右クリック: 点上なら削除、そうでなければ W/L ドラッグ開始。
        if (idx >= 0) {
          curveRef.current.removeControlPoint(idx);
          setCurveVersion((v) => v + 1);
          recomputePreview();
        } else {
          wlDragRef.current = { x: e.clientX, y: e.clientY, center: wlRef.current.center, width: wlRef.current.width };
        }
        return;
      }
      if (e.button !== 0) return;
      if (idx >= 0) dragRef.current = { index: idx };
    },
    [findPointAt, recomputePreview],
  );

  // ドラッグ移動 / W/L / ホバー HU（window で追跡）。
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const canvas = refCanvasRef.current;
      const vol = volRef.current;
      if (!canvas || !vol) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      // 点ドラッグ（面内のみ移動＝スライス深さを保持）。
      const drag = dragRef.current;
      if (drag) {
        const [i, j] = screenToImage(sx, sy);
        const old = toVoxelIndex(vol, curveRef.current.getControlPoint(drag.index));
        const w = toPhysical(vol, i, j, old[2]); // 深さ(k)は元の値を保持
        curveRef.current.setControlPoint(drag.index, w);
        setCurveVersion((v) => v + 1);
        return;
      }
      // W/L ドラッグ。
      const wld = wlDragRef.current;
      if (wld) {
        const dx = e.clientX - wld.x;
        const dy = e.clientY - wld.y;
        setWl({ width: Math.max(1, wld.width + dx), center: wld.center - dy });
        return;
      }
      // ホバー HU（実座標＋値）。
      if (sx >= 0 && sy >= 0 && sx <= rect.width && sy <= rect.height) {
        const [i, j] = screenToImage(sx, sy);
        const w = toPhysical(vol, i, j, sliceZRef.current);
        const iv = clampInt(i, 0, vol.dimensions[0] - 1);
        const jv = clampInt(j, 0, vol.dimensions[1] - 1);
        const kv = clampInt(sliceZRef.current, 0, vol.dimensions[2] - 1);
        if (i >= 0 && i < vol.dimensions[0] && j >= 0 && j < vol.dimensions[1]) {
          const hu = vol.data[kv * vol.dimensions[0] * vol.dimensions[1] + jv * vol.dimensions[0] + iv];
          setHover({ world: w, hu });
        } else {
          setHover(null);
        }
      }
    };
    const onUp = () => {
      const wasDrag = dragRef.current;
      dragRef.current = null;
      wlDragRef.current = null;
      if (wasDrag) recomputePreview();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [screenToImage, recomputePreview]);

  const onCanvasWheel = useCallback((e: React.WheelEvent) => {
    const vol = volRef.current;
    if (!vol) return;
    const d = e.deltaY > 0 ? 1 : -1;
    setSliceZ((z) => clampInt(z + d, 0, vol.dimensions[2] - 1));
  }, []);

  const resetCurve = useCallback(() => {
    curveRef.current.clear();
    setCurveVersion((v) => v + 1);
    recomputePreview();
  }, [recomputePreview]);

  // ── 保存（派生セカンダリシリーズ・単一フレーム） ──
  const onSave = useCallback(async () => {
    const result = resultRef.current;
    if (!result || saving) return;
    setSaving(true);
    setSaveMsg("");
    try {
      const n = result.width * result.height;
      const frame = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        let v = Math.round(result.pixels[i]);
        if (v < -32768) v = -32768;
        else if (v > 32767) v = 32767;
        frame[i] = v;
      }
      const p = paramsRef.current;
      const desc = `${srcDescRef.current || "Series"} Curved MPR`;
      const res = await httpSend<{ seriesInstanceUid: string; sopInstanceUids: string[] }>(
        "/api/series/derived",
        "POST",
        {
          studyInstanceUid: srcStudyRef.current,
          seriesInstanceUid: srcSeriesRef.current,
          seriesDescription: desc,
          seriesNumber: null,
          rows: result.height,
          columns: result.width,
          pixelSpacing: [result.pixelSpacingY, result.pixelSpacingX],
          sliceThickness: p.bandHalfWidthMm > 0 ? 2 * p.bandHalfWidthMm : 0,
          spacingBetweenSlices: 0,
          imageOrientationPatient: null,
          derivationDescription: `Curved MPR (${p.frameMode}, ${p.projectionMode}, band=${p.bandHalfWidthMm}mm)`,
          frames: [{ instanceNumber: 1, imagePositionPatient: null, pixels: framePixelsBase64(frame) }],
        },
      );
      emitDbChanged({ reason: "series-create", studyUids: [srcStudyRef.current] });
      setSaveMsg(t("curvedMpr.saved", { n: String(res.sopInstanceUids.length) }));
    } catch (e) {
      setSaveMsg(`${t("curvedMpr.saveFailed")}: ${String(e)}`);
      // eslint-disable-next-line no-console
      console.error("[curvedmpr] save failed:", e);
    } finally {
      setSaving(false);
    }
  }, [saving, t]);

  const busy = phase === "loading" || phase === "idle";
  const hasResult = !!resultRef.current;
  const nPoints = useMemo(() => {
    void curveVersion;
    return curveRef.current.size();
  }, [curveVersion]);
  const setP = <K extends keyof CurveParamsUi>(key: K, v: CurveParamsUi[K]) => setParams((s) => ({ ...s, [key]: v }));
  const nSlices = volRef.current?.dimensions[2] ?? 0;

  return (
    <div style={root}>
      <div style={header}>
        <span style={hTitle}>{t("curvedMpr.title")}</span>
        {title && <span style={hSeries}>{title}</span>}
        {dimInfo && (dimInfo.nC > 1 || dimInfo.nT > 1) && (
          <span style={dimChip}>{t("curvedMpr.dimUsed", { c: String(dimInfo.c), tt: String(dimInfo.t) })}</span>
        )}
      </div>

      {phase === "ready" && (
        <div style={ctrlBar}>
          <span style={hint}>{t("curvedMpr.hint")}</span>
          <div style={{ flex: 1 }} />
          <label style={selWrap}>
            <span style={fieldLabel}>{t("curvedMpr.secondAxis")}</span>
            <select style={select} value={params.frameMode} onChange={(e) => setP("frameMode", e.target.value as FrameMode)}>
              {FRAME_MODES.map((m) => (
                <option key={m} value={m}>{t(`curvedMpr.frame.${m}`)}</option>
              ))}
            </select>
          </label>
          <label style={selWrap}>
            <span style={fieldLabel}>{t("curvedMpr.projection")}</span>
            <select style={select} value={params.projectionMode} onChange={(e) => setP("projectionMode", e.target.value as ProjectionMode)}>
              {PROJECTION_MODES.map((m) => (
                <option key={m} value={m}>{t(`curvedMpr.proj.${m}`)}</option>
              ))}
            </select>
          </label>
          <Field label={t("curvedMpr.band")} value={params.bandHalfWidthMm} min={0} step={0.5} onCommit={(v) => setP("bandHalfWidthMm", v)} unit="mm" />
          <Field label={t("curvedMpr.axisMin")} value={params.secondAxisMinMm} min={-2000} step={1} onCommit={(v) => setP("secondAxisMinMm", v)} unit="mm" />
          <Field label={t("curvedMpr.axisMax")} value={params.secondAxisMaxMm} min={-2000} step={1} onCommit={(v) => setP("secondAxisMaxMm", v)} unit="mm" />
        </div>
      )}

      <div style={grid}>
        <div style={cell}>
          <div ref={containerRef} style={vpEl}>
            <canvas
              ref={refCanvasRef}
              style={canvasStyle}
              onDoubleClick={onCanvasDoubleClick}
              onPointerDown={onCanvasPointerDown}
              onWheel={onCanvasWheel}
              onContextMenu={(e) => e.preventDefault()}
              onPointerLeave={() => setHover(null)}
            />
          </div>
          <span style={{ ...cellLabel, color: "#00dc00" }}>{t("curvedMpr.reference")}</span>
          {nSlices > 0 && <span style={sliceChip}>{sliceZ + 1} / {nSlices}</span>}
          {hover && (
            <span style={probeStyle}>
              HU {Math.round(hover.hu)} @ ({hover.world[0].toFixed(1)}, {hover.world[1].toFixed(1)}, {hover.world[2].toFixed(1)}) mm
            </span>
          )}
          {phase === "ready" && nPoints < 2 && (
            <div style={drawPromptWrap}><span style={drawPromptBox}>{t("curvedMpr.drawPrompt")}</span></div>
          )}
        </div>
        <div style={cell}>
          <div style={previewWrap}>
            <canvas ref={previewCanvasRef} style={previewCanvas} />
          </div>
          <span style={{ ...cellLabel, color: "#ff9a5a" }}>{t("curvedMpr.preview")}</span>
          {previewInfo && <span style={previewInfoStyle}>{previewInfo}</span>}
        </div>
        {phase !== "ready" && (
          <div style={overlayBoxWrap}>
            <div style={overlayBox}>{busy ? t("curvedMpr.loading") : message}</div>
          </div>
        )}
      </div>

      {phase === "ready" && (
        <div style={panel}>
          <button style={btn} onClick={resetCurve}>{t("curvedMpr.resetCurve")}</button>
          <div style={{ flex: 1 }} />
          {saveMsg && <span style={saveMsgStyle}>{saveMsg}</span>}
          <button
            style={hasResult && !saving ? genBtn : genBtnDisabled}
            onClick={onSave}
            disabled={!hasResult || saving}
            title={hasResult ? "" : t("curvedMpr.saveNeedResult")}
          >
            {saving ? t("curvedMpr.saving") : t("curvedMpr.save")}
          </button>
          <button style={btn} onClick={() => window.close()}>{t("common.close")}</button>
        </div>
      )}
    </div>
  );
}

/** 手入力の数値フィールド。 */
function Field({
  label,
  value,
  min,
  step,
  unit,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  step?: number;
  unit?: string;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) setText(String(value));
  }, [value]);
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const tt = e.target.value;
    setText(tt);
    const v = parseFloat(tt);
    if (Number.isFinite(v)) onCommit(v);
  };
  const onBlur = () => {
    focusedRef.current = false;
    let v = parseFloat(text);
    if (!Number.isFinite(v)) v = value;
    v = Math.max(min, v);
    onCommit(v);
    setText(String(v));
  };
  return (
    <label style={selWrap}>
      <span style={fieldLabel}>{label}</span>
      <input
        type="number"
        style={input}
        value={text}
        step={step ?? 1}
        min={min}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onChange={onChange}
        onBlur={onBlur}
      />
      {unit && <span style={fieldUnit}>{unit}</span>}
    </label>
  );
}

// ── styles ────────────────────────────────────────────────────
const root: React.CSSProperties = { position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "#000", color: "#e6eaee", fontFamily: "system-ui, sans-serif" };
const header: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, padding: "6px 12px", background: "#14181c", borderBottom: "1px solid #23292f", fontSize: 13 };
const hTitle: React.CSSProperties = { fontWeight: 600 };
const hSeries: React.CSSProperties = { color: "#9aa6b2" };
const dimChip: React.CSSProperties = { fontSize: 11, color: "#9fd3ff", border: "1px solid #2a465a", background: "#0f1e2a", borderRadius: 4, padding: "1px 7px" };
const ctrlBar: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "5px 12px", background: "#0d1013", borderBottom: "1px solid #23292f", fontSize: 12, flexWrap: "wrap" };
const grid: React.CSSProperties = { position: "relative", flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr", minHeight: 0 };
const cell: React.CSSProperties = { position: "relative", minWidth: 0, minHeight: 0, border: "1px solid #23292f", overflow: "hidden" };
const vpEl: React.CSSProperties = { position: "absolute", inset: 0 };
const canvasStyle: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", touchAction: "none", cursor: "crosshair" };
const cellLabel: React.CSSProperties = { position: "absolute", top: 6, left: 8, fontSize: 12, fontWeight: 600, textShadow: "0 0 3px #000", pointerEvents: "none" };
const sliceChip: React.CSSProperties = { position: "absolute", bottom: 6, left: 8, fontSize: 11, color: "#9aa6b2", textShadow: "0 0 3px #000", pointerEvents: "none", fontVariantNumeric: "tabular-nums" };
const probeStyle: React.CSSProperties = { position: "absolute", top: 6, right: 8, fontSize: 11, color: "#ffe08a", textShadow: "0 0 3px #000", pointerEvents: "none", fontVariantNumeric: "tabular-nums" };
const previewWrap: React.CSSProperties = { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto", background: "#000" };
const previewCanvas: React.CSSProperties = { imageRendering: "pixelated", maxWidth: "100%", maxHeight: "100%", objectFit: "contain" };
const previewInfoStyle: React.CSSProperties = { position: "absolute", bottom: 6, left: 8, fontSize: 11, color: "#9aa6b2", textShadow: "0 0 3px #000", pointerEvents: "none" };
const overlayBoxWrap: React.CSSProperties = { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.55)" };
const overlayBox: React.CSSProperties = { padding: "10px 18px", background: "#1b2126", border: "1px solid #2c343b", borderRadius: 8, fontSize: 13, maxWidth: "80%", textAlign: "center" };
const panel: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", background: "#14181c", borderTop: "1px solid #23292f", fontSize: 12, flexWrap: "wrap" };
const selWrap: React.CSSProperties = { display: "flex", alignItems: "center", gap: 5 };
const fieldLabel: React.CSSProperties = { color: "#9aa6b2" };
const fieldUnit: React.CSSProperties = { color: "#7f8b96" };
const hint: React.CSSProperties = { color: "#8b96a0", fontSize: 11 };
const input: React.CSSProperties = { width: 68, background: "#1b2126", color: "#e6eaee", border: "1px solid #2c343b", borderRadius: 5, fontSize: 12, padding: "2px 6px" };
const select: React.CSSProperties = { background: "#1b2126", color: "#e6eaee", border: "1px solid #2c343b", borderRadius: 5, fontSize: 12, padding: "2px 6px" };
const saveMsgStyle: React.CSSProperties = { color: "#8fe08f", fontSize: 12 };
const btn: React.CSSProperties = { background: "#26303a", color: "#e6eaee", border: "1px solid #33404b", borderRadius: 5, fontSize: 12, padding: "5px 12px", cursor: "pointer" };
const genBtn: React.CSSProperties = { background: "#0b5cad", color: "#fff", border: "none", borderRadius: 5, fontSize: 12, padding: "5px 12px", cursor: "pointer" };
const genBtnDisabled: React.CSSProperties = { ...genBtn, background: "#2c343b", color: "#7f8b96", cursor: "not-allowed" };
const drawPromptWrap: React.CSSProperties = { position: "absolute", top: 34, left: 0, right: 0, display: "flex", justifyContent: "center", pointerEvents: "none" };
const drawPromptBox: React.CSSProperties = { background: "rgba(11,92,173,0.85)", color: "#fff", fontSize: 12, padding: "5px 12px", borderRadius: 6, boxShadow: "0 2px 8px rgba(0,0,0,0.4)" };
