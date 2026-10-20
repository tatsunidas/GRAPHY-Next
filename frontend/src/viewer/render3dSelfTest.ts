/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 描画環境の自己診断（設計: fw/self-test-design.md）。
// 解析と判定（findBlobs / judge）は DOM も WebGL も使わない純関数。WebGL を使うのは runRender3dSelfTest だけ。
import vtkImageData from "@kitware/vtk.js/Common/DataModel/ImageData";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import { getMax3dTextureSize } from "./volumeMemory";
import type { RenderKind } from "./renderEnv";
import type { createVtkVolumeView as CreateVtkVolumeView } from "./vtkVolumeView";

export type SelfTestStatus = "pass" | "fail" | "pending";

export type SelfTestRowId =
  | "webgl2"
  | "max3dTex"
  | "render"
  | "orientation"
  | "spacing"
  | "distance"
  | "hardware";

export interface SelfTestRow {
  id: SelfTestRowId;
  status: SelfTestStatus;
  /** 理由コード（i18n キー `selftest.reason.<reason>`）。 */
  reason: string;
  /** 測定値（JSON にそのまま入る）。 */
  values?: Record<string, number | string | null>;
}

// ───────── 合成ボリューム（mm で定義。index への変換は buildSyntheticVolume 内だけ） ─────────

const DIMS: [number, number, number] = [128, 128, 64];
const SPACING: [number, number, number] = [1.0, 1.0, 2.5];
const VALUE = 1000;

interface BoxMm {
  x: [number, number];
  y: [number, number];
  z: [number, number];
}
const REF_BOX: BoxMm = { x: [20, 68], y: [40, 88], z: [50, 150] };
const MARK_BOX: BoxMm = { x: [96, 108], y: [52, 76], z: [65, 95] };

export interface Expected {
  /** 基準立方体の X 幅・Z 高さ（mm）。 */
  refWidthMm: number;
  refHeightMm: number;
  /** 目印と基準の中心間距離（mm、X 方向）。 */
  centerDistMm: number;
}

export interface SyntheticVolume {
  /** vtkImageData（LPS、単位 direction）。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  imageData: any;
  value: number;
  expected: Expected;
}

export function buildSyntheticVolume(): SyntheticVolume {
  const [nx, ny, nz] = DIMS;
  const data = new Float32Array(nx * ny * nz);
  const inside = (b: BoxMm, i: number, j: number, k: number) => {
    const x = i * SPACING[0];
    const y = j * SPACING[1];
    const z = k * SPACING[2];
    return x >= b.x[0] && x < b.x[1] && y >= b.y[0] && y < b.y[1] && z >= b.z[0] && z < b.z[1];
  };
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (inside(REF_BOX, i, j, k) || inside(MARK_BOX, i, j, k)) data[(k * ny + j) * nx + i] = VALUE;
      }
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const id: any = vtkImageData.newInstance();
  id.setDimensions(DIMS);
  id.setSpacing(SPACING);
  id.setOrigin([0, 0, 0]);
  id.setDirection(Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]));
  id.getPointData().setScalars(vtkDataArray.newInstance({ numberOfComponents: 1, values: data }));
  const cx = (b: BoxMm) => (b.x[0] + b.x[1]) / 2;
  return {
    imageData: id,
    value: VALUE,
    expected: {
      refWidthMm: REF_BOX.x[1] - REF_BOX.x[0],
      refHeightMm: REF_BOX.z[1] - REF_BOX.z[0],
      centerDistMm: cx(MARK_BOX) - cx(REF_BOX),
    },
  };
}

// ───────── 画素解析（純関数） ─────────

export interface Blob {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  cx: number;
  cy: number;
  area: number;
}

/** readPixelStats（vtkGeometryView）と同じ「どれかの成分が 60 を超える」を背景でないとみなす。 */
export const BACKGROUND_THRESHOLD = 60;

/** 背景でない画素を 4 近傍で連結成分に分ける。rgba は readPixels の順（左下原点、行は下から上）。面積の大きい順。 */
export function findBlobs(rgba: ArrayLike<number>, w: number, h: number): Blob[] {
  const on = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const o = p * 4;
    if (rgba[o] > BACKGROUND_THRESHOLD || rgba[o + 1] > BACKGROUND_THRESHOLD || rgba[o + 2] > BACKGROUND_THRESHOLD) on[p] = 1;
  }
  const seen = new Uint8Array(w * h);
  const blobs: Blob[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!on[start] || seen[start]) continue;
    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    let sx = 0;
    let sy = 0;
    let area = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop() as number;
      const x = p % w;
      const y = (p - x) / w;
      area++;
      sx += x;
      sy += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && on[p - 1] && !seen[p - 1]) (seen[p - 1] = 1), stack.push(p - 1);
      if (x < w - 1 && on[p + 1] && !seen[p + 1]) (seen[p + 1] = 1), stack.push(p + 1);
      if (y > 0 && on[p - w] && !seen[p - w]) (seen[p - w] = 1), stack.push(p - w);
      if (y < h - 1 && on[p + w] && !seen[p + w]) (seen[p + w] = 1), stack.push(p + w);
    }
    blobs.push({ minX, maxX, minY, maxY, cx: sx / area, cy: sy / area, area });
  }
  return blobs.sort((a, b) => b.area - a.area);
}

/** s がこれ未満だと許容幅 2/s が広すぎるため、画素間隔・距離比は判定しない。 */
export const MIN_REF_PX = 40;

const relDiff = (measured: number, expected: number) => Math.abs(measured - expected) / expected;

/** 読み返した画像（RGBA、行は readPixels の並び）。 */
export interface ReadbackImage {
  rgba: ArrayLike<number>;
  w: number;
  h: number;
}

/**
 * 1 本の輝度の並びで、`lo..hi` の像の両端が半値（像の中の最大の 1/2）を横切る位置を線形補間で返す。
 * 外接矩形の画素数は、補間でぼけた縁を背景の閾値まで含むので幅を広く測る（実測で約 2%）。
 * 縁のぼけが左右対称なら、半値の位置は箱の境界に一致する。
 */
export function edgeSpan(profile: ArrayLike<number>, lo: number, hi: number): { start: number; end: number; width: number } | null {
  let peak = 0;
  for (let i = lo; i <= hi; i++) peak = Math.max(peak, profile[i]);
  const half = peak / 2;
  if (!(half > 0)) return null;
  let i = lo;
  while (i <= hi && profile[i] < half) i++;
  if (i > hi) return null;
  let j = hi;
  while (j >= lo && profile[j] < half) j--;
  const before = i > 0 ? profile[i - 1] : 0;
  const after = j < profile.length - 1 ? profile[j + 1] : 0;
  const start = i - 1 + (half - before) / (profile[i] - before);
  const end = j + (profile[j] - half) / (profile[j] - after);
  return { start, end, width: end - start };
}

const luminance = (img: ReadbackImage, x: number, y: number) => {
  const o = (y * img.w + x) * 4;
  return Math.max(img.rgba[o], img.rgba[o + 1], img.rgba[o + 2]);
};

/** 像の中心を通る横 1 行・縦 1 列の半値幅（取れなければ外接矩形の画素数）。 */
function halfMaxSize(b: Blob, img: ReadbackImage): { w: number; h: number } {
  const y = Math.round(b.cy);
  const x = Math.round(b.cx);
  const row = Array.from({ length: img.w }, (_, i) => luminance(img, i, y));
  const col = Array.from({ length: img.h }, (_, i) => luminance(img, x, i));
  const sw = edgeSpan(row, Math.max(0, b.minX - 1), Math.min(img.w - 1, b.maxX + 1));
  const sh = edgeSpan(col, Math.max(0, b.minY - 1), Math.min(img.h - 1, b.maxY + 1));
  return { w: sw?.width ?? b.maxX - b.minX + 1, h: sh?.width ?? b.maxY - b.minY + 1 };
}

/** render 以降の 4 行を返す。成分が無ければ render は fail、後続は pending。 */
export function judge(blobs: Blob[], expected: Expected, img: ReadbackImage): SelfTestRow[] {
  if (blobs.length === 0) {
    const pend = (id: SelfTestRowId): SelfTestRow => ({ id, status: "pending", reason: "needsRender" });
    return [
      { id: "render", status: "fail", reason: "allBackground", values: { blobs: 0 } },
      pend("orientation"),
      pend("spacing"),
      pend("distance"),
    ];
  }
  const ref = blobs[0];
  const mark = blobs.length > 1 ? blobs[1] : null;
  // 基準と目印の 2 つより多いときは、どれが目印か決められない（合格にしない）。
  const extra = blobs.length > 2;
  const { w: refW, h: refH } = halfMaxSize(ref, img);
  const s = Math.min(refW, refH);
  const tol = 2 / s;
  const rows: SelfTestRow[] = [
    { id: "render", status: "pass", reason: "drawn", values: { blobs: blobs.length, refWidthPx: round(refW), refHeightPx: round(refH) } },
  ];

  // 向き
  if (!mark) {
    rows.push({ id: "orientation", status: "fail", reason: "markerMissing" });
  } else if (extra) {
    rows.push({ id: "orientation", status: "fail", reason: "extraBlobs", values: { blobs: blobs.length } });
  } else {
    const right = mark.cx > ref.cx;
    rows.push({
      id: "orientation",
      status: right ? "pass" : "fail",
      reason: right ? "markerRight" : "markerLeft",
      values: { markerCx: round(mark.cx), refCx: round(ref.cx) },
    });
  }

  // 画素間隔
  if (s < MIN_REF_PX) {
    rows.push({ id: "spacing", status: "pending", reason: "tooSmall", values: { shortSidePx: round(s) } });
  } else {
    const pxAspect = refW / refH;
    const mmAspect = expected.refWidthMm / expected.refHeightMm;
    const d = relDiff(pxAspect, mmAspect);
    rows.push({
      id: "spacing",
      status: d <= tol + 1e-9 ? "pass" : "fail",
      reason: d <= tol + 1e-9 ? "aspectMatch" : "aspectMismatch",
      values: { pxAspect: round(pxAspect), mmAspect: round(mmAspect), relDiff: round(d), tolerance: round(tol) },
    });
  }

  // 距離比
  if (s < MIN_REF_PX) {
    rows.push({ id: "distance", status: "pending", reason: "tooSmall", values: { shortSidePx: round(s) } });
  } else if (!mark) {
    rows.push({ id: "distance", status: "fail", reason: "markerMissing" });
  } else if (extra) {
    rows.push({ id: "distance", status: "fail", reason: "extraBlobs", values: { blobs: blobs.length } });
  } else {
    const pxRatio = Math.abs(mark.cx - ref.cx) / refW;
    const mmRatio = expected.centerDistMm / expected.refWidthMm;
    const d = relDiff(pxRatio, mmRatio);
    rows.push({
      id: "distance",
      status: d <= tol + 1e-9 ? "pass" : "fail",
      reason: d <= tol + 1e-9 ? "ratioMatch" : "ratioMismatch",
      values: { pxRatio: round(pxRatio), mmRatio: round(mmRatio), relDiff: round(d), tolerance: round(tol) },
    });
  }
  return rows;
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}

// ───────── WebGL を使う薄い層 ─────────

export interface SelfTestRun {
  rows: SelfTestRow[];
  gpu: string;
  /** 読み返した画像（縮小表示用）。取れなければ null。 */
  image: { rgba: Uint8ClampedArray<ArrayBuffer>; w: number; h: number } | null;
}

function gpuName(gl: WebGL2RenderingContext | WebGLRenderingContext | null): string {
  try {
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    const v = ext ? gl?.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
    return typeof v === "string" && v ? v : "unknown";
  } catch {
    return "unknown";
  }
}

const PENDING_REST: SelfTestRowId[] = ["render", "orientation", "spacing", "distance"];

/** ハードウェア支援の行は、描画環境の判定（`classifyRenderer`）をそのまま写す。 */
export function hardwareRow(kind: RenderKind): SelfTestRow {
  if (kind === "hardware") return { id: "hardware", status: "pass", reason: "hardwareYes" };
  if (kind === "software") return { id: "hardware", status: "fail", reason: "softwareRender" };
  return { id: "hardware", status: "pending", reason: "kindUnknown" };
}

export async function runRender3dSelfTest(container: HTMLDivElement, kind: RenderKind): Promise<SelfTestRun> {
  // vtk.js の描画系は import 時に window を要る。純関数のテスト（node）を妨げないよう遅延 import する。
  const { createVtkVolumeView } = await import("./vtkVolumeView");
  const max = getMax3dTextureSize();
  const hardware = hardwareRow(kind);
  if (max == null) {
    return {
      rows: [
        { id: "webgl2", status: "fail", reason: "noWebgl2" },
        { id: "max3dTex", status: "pending", reason: "needsWebgl2" },
        ...PENDING_REST.map((id): SelfTestRow => ({ id, status: "pending", reason: "needsWebgl2" })),
        hardware,
      ],
      gpu: "unknown",
      image: null,
    };
  }
  const head: SelfTestRow[] = [
    { id: "webgl2", status: "pass", reason: "available" },
    { id: "max3dTex", status: "pass", reason: "maxSize", values: { maxTextureSize3d: max } },
  ];
  const vol = buildSyntheticVolume();
  let view: ReturnType<typeof CreateVtkVolumeView> | null = null;
  try {
    view = createVtkVolumeView(container, vol.imageData, { mode: "MIP", center: vol.value / 2, width: vol.value });
    view.snapOrientation("COR");
    view.setAxesEnabled(false); // 向きのキューブも同じ canvas に描かれ、目印と取り違える
    // 透視では奥行きのある箱の前面が大きく写り、mm の比が崩れる。診断は mm の扱いだけを測る。
    view.setParallelProjection(true);
    view.render();
    // 描いた直後に、同じ実行単位で読み返す（描画バッファの保持設定に依らないため）。
    const canvas = container.querySelector("canvas") as HTMLCanvasElement | null;
    const gl = (canvas?.getContext("webgl2") ?? canvas?.getContext("webgl")) as WebGL2RenderingContext | null;
    if (!canvas || !gl || !(canvas.width > 0 && canvas.height > 0)) {
      return {
        rows: [...head, ...PENDING_REST.map((id): SelfTestRow => ({ id, status: "pending", reason: "noReadback" })), hardware],
        gpu: "unknown",
        image: null,
      };
    }
    const w = canvas.width;
    const h = canvas.height;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const rows = judge(findBlobs(buf, w, h), vol.expected, { rgba: buf, w, h });
    return { rows: [...head, ...rows, hardware], gpu: gpuName(gl), image: { rgba: new Uint8ClampedArray(buf), w, h } };
  } catch (e) {
    return {
      rows: [
        ...head,
        { id: "render", status: "fail", reason: "renderError", values: { message: String(e).slice(0, 200) } },
        ...PENDING_REST.slice(1).map((id): SelfTestRow => ({ id, status: "pending", reason: "needsRender" })),
        hardware,
      ],
      gpu: "unknown",
      image: null,
    };
  } finally {
    try {
      view?.destroy();
    } catch {
      /* ignore */
    }
  }
}
