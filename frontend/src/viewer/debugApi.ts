/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { cache, getRenderingEngine, metaData } from "@cornerstonejs/core";
import { ENGINE_ID } from "./Viewer2D";
import { readCamera, readColormapName, readVoiWindow } from "./viewportRead";

/**
 * automator（自律検証ツール）専用のデバッグAPI。`window.__graphyDebug` として公開し、
 * Playwright から `page.evaluate(() => window.__graphyDebug.getPixelStats())` で
 * 「実際に画素が描画されたか」をDOM/スクリーンショットに頼らず機械的に判定できるようにする。
 *
 * <p>Viewer2D.tsx の内部実装（viewportId の生成規則等）には依存しない: cornerstone3D の
 * 公開APIである RenderingEngine.getViewports() で現在有効な全ビューポートを列挙し、
 * その canvas（WebGL）を一時的な 2D canvas へ drawImage して画素統計を取る。
 *
 * <p>{@link import.meta.env.DEV} でガードしており、`vite build`（本番/インストーラ配布物）には
 * 含まれない（automator は常に `vite dev` 経由でフロントを起動するため、開発ビルドのみで十分）。
 */
export interface PixelStats {
  viewportId: string;
  width: number;
  height: number;
  mean: number;
  min: number;
  max: number;
  /** ほぼ黒(輝度<=2)ではないピクセルの割合。0 に近い場合は「何も描画されていない」可能性が高い。 */
  nonBlackFraction: number;
}

function canvasStats(canvas: HTMLCanvasElement): Omit<PixelStats, "viewportId"> | null {
  const off = document.createElement("canvas");
  off.width = canvas.width;
  off.height = canvas.height;
  const ctx = off.getContext("2d");
  if (!ctx || off.width === 0 || off.height === 0) return null;
  // WebGL(cornerstone3D)キャンバスも drawImage のソースにできる（2D コンテキスト側の制約のみ）。
  ctx.drawImage(canvas, 0, 0);
  const { data } = ctx.getImageData(0, 0, off.width, off.height);
  let sum = 0;
  let min = 255;
  let max = 0;
  let nonBlack = 0;
  const pixelCount = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
    sum += lum;
    if (lum < min) min = lum;
    if (lum > max) max = lum;
    if (lum > 2) nonBlack++;
  }
  return {
    width: off.width,
    height: off.height,
    mean: pixelCount > 0 ? sum / pixelCount : 0,
    min,
    max,
    nonBlackFraction: pixelCount > 0 ? nonBlack / pixelCount : 0,
  };
}

function getPixelStats(): PixelStats[] {
  const engine = getRenderingEngine(ENGINE_ID);
  if (!engine) return [];
  const out: PixelStats[] = [];
  for (const vp of engine.getViewports()) {
    const canvas = vp.canvas as HTMLCanvasElement | undefined;
    if (!canvas) continue;
    const stats = canvasStats(canvas);
    if (stats) out.push({ viewportId: vp.id, ...stats });
  }
  return out;
}

/** 各ビューポートのカメラ/フィット幾何。フィット不良（極小/隅寄り）の原因切り分け用。 */
export interface ViewportGeometry {
  viewportId: string;
  imageId: string | null;
  canvas: { width: number; height: number; clientWidth: number; clientHeight: number };
  camera: {
    parallelScale: number | null;
    position: number[] | null;
    focalPoint: number[] | null;
  };
  image: {
    dimensions: number[] | null; // [cols, rows, 1]
    spacing: number[] | null; // [colSpacing, rowSpacing, sliceSpacing]
    origin: number[] | null;
    direction: number[] | null;
  } | null;
}

function getViewportGeometry(): ViewportGeometry[] {
  const engine = getRenderingEngine(ENGINE_ID);
  if (!engine) return [];
  const out: ViewportGeometry[] = [];
  for (const vp of engine.getViewports()) {
    const canvas = vp.canvas as HTMLCanvasElement | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyVp = vp as any;
    const cam = readCamera(anyVp);
    let image: ViewportGeometry["image"] = null;
    try {
      const d = anyVp.getImageData?.();
      if (d) {
        image = {
          dimensions: d.dimensions ?? null,
          spacing: d.spacing ?? null,
          origin: d.origin ?? null,
          direction: d.direction ? Array.from(d.direction as number[]) : null,
        };
      }
    } catch { /* ignore */ }
    out.push({
      viewportId: vp.id,
      imageId: (anyVp.getCurrentImageId?.() as string) ?? null,
      canvas: {
        width: canvas?.width ?? 0,
        height: canvas?.height ?? 0,
        clientWidth: canvas?.clientWidth ?? 0,
        clientHeight: canvas?.clientHeight ?? 0,
      },
      camera: cam,
      image,
    });
  }
  return out;
}

/** 各ビューポートの LUT(colormap)・W/L(voiRange) 適用状態。LUT/W-L系 checklist item の検証用。 */
export interface ViewportProperties {
  viewportId: string;
  /** 適用中の colormap 名。未適用（既定グレースケール）なら null。 */
  colormapName: string | null;
  /** 適用中の window/level（voiRange から算出）。取得不可なら null。 */
  windowLevel: { center: number; width: number } | null;
}

function getViewportProperties(): ViewportProperties[] {
  const engine = getRenderingEngine(ENGINE_ID);
  if (!engine) return [];
  const out: ViewportProperties[] = [];
  for (const vp of engine.getViewports()) {
    out.push({
      viewportId: vp.id,
      // checklist は「LUT を当てたか」を見るので、内部グレースケール名は畳まず生の名前を返す。
      colormapName: readColormapName(vp),
      windowLevel: readVoiWindow(vp),
    });
  }
  return out;
}

/**
 * XA シネ再生の実測値（automator の受け入れ条件 §5.8-2 / §5.8-7 用）。
 *
 * <p>`setStackCalls` は「フレーム送りのたびにスタックを組み直していないか」を数値で示すためのもの。
 * XA でここが増え続けるなら stackAxis の配線が壊れている（30fps に届かない）。
 */
export interface XaCineStats {
  /** 直近 1 秒で進んだフレーム数（実測 fps）。 */
  measuredFps: number;
  /** 公称 fps（DICOM タグ由来）と、その決定根拠。 */
  nominalFps: number;
  fpsSource: string;
  /** 再生中に描画したフレーム数の累計。 */
  framesRendered: number;
  /** Viewer2D に渡した imageIds が差し替わった回数（= setStack 相当）。 */
  setStackCalls: number;
}

const xaCineStats: XaCineStats = {
  measuredFps: 0,
  nominalFps: 0,
  fpsSource: "",
  framesRendered: 0,
  setStackCalls: 0,
};

/** シネ側から実測値を書き込む（DEV のみ意味を持つ。本番ビルドでも無害）。 */
export function reportXaCineStats(patch: Partial<XaCineStats>): void {
  Object.assign(xaCineStats, patch);
}

/** スタック差し替えを数える（XA でフレーム送りのたびに増えていたら配線ミス）。 */
export function countStackSwap(): void {
  xaCineStats.setStackCalls += 1;
}

function getXaCineStats(): XaCineStats {
  return { ...xaCineStats };
}

/**
 * 表示中画像の**実画素値**の範囲（キャンバスの見た目ではなくデータそのもの）。
 *
 * <p>「見た目が真っ白/真っ黒」なとき、原因が**データ**なのか **VOI の当て方**なのかを
 * 切り分けるための唯一の手段。合成画像（ThickSlab / DSA）で値空間が変わるときに要る。
 */
export interface ImagePixelRange {
  viewportId: string;
  imageId: string | null;
  min: number;
  max: number;
  mean: number;
  /** ビューポートに適用中の voiRange（[lower, upper]）。未設定なら null。 */
  voiRange: { lower: number; upper: number } | null;
  /** この imageId に対して metaData が返す voiLutModule（プロバイダの解決結果）。 */
  voiLutModule: unknown;
}

function getImagePixelRange(): ImagePixelRange[] {
  const engine = getRenderingEngine(ENGINE_ID);
  if (!engine) return [];
  const out: ImagePixelRange[] = [];
  for (const vp of engine.getViewports()) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyVp = vp as any;
    const imageId: string | null = anyVp.getCurrentImageId?.() ?? null;
    let min = NaN;
    let max = NaN;
    let mean = NaN;
    try {
      const img = imageId ? (cache.getImage(imageId) as unknown as { getPixelData?: () => ArrayLike<number> }) : null;
      const px = img?.getPixelData?.();
      if (px && px.length) {
        min = Number.POSITIVE_INFINITY;
        max = Number.NEGATIVE_INFINITY;
        let sum = 0;
        for (let i = 0; i < px.length; i++) {
          const v = px[i];
          if (v < min) min = v;
          if (v > max) max = v;
          sum += v;
        }
        mean = sum / px.length;
      }
    } catch {
      /* 取得できなければ NaN のまま */
    }
    const range = (anyVp.getProperties?.() ?? {}).voiRange ?? null;
    const voiLutModule = imageId ? (metaData.get("voiLutModule", imageId) ?? null) : null;
    out.push({ viewportId: vp.id, imageId, min, max, mean, voiRange: range, voiLutModule });
  }
  return out;
}

/**
 * QCA の現在の状態（手修正の実機検証用。`fw/angio-design.md` §8.6）。
 *
 * <p>エッジや中間点を掴むには**画像ピクセル座標と画面座標の対応**が要る。
 * 画面から推測すると「掴めていないのに操作した気になる」検証になるので、
 * 変換そのものを公開する。
 */
export interface QcaDebugSnapshot {
  /**
   * **どの画像を解析したか**（imageId）。
   *
   * <p>フレームを跨いで検証するとき、狙ったフレームを解析できているかは結果の数値からは
   * 判別できない（別フレームの値がもっともらしく出る）。実際にファントム検証で
   * 「1 フレーム目の結果が 2 フレーム目の値と一致する」形で踏んだ。
   */
  imageId: string;
  /** 計測点の中心線（画像 px）。 */
  centerline: [number, number][];
  /** 計測点のエッジ（画像 px）。 */
  edges: { left: [number, number]; right: [number, number] }[];
  pathIndices: number[];
  centerlineToken: string;
  provenance: { waypoints: number; editedEdges: number[]; trimmed: boolean; reference: string; edited: boolean };
  mld: number;
  rvd: number;
  percentDiameterStenosis: number;
  percentAreaStenosis: number;
  lesionLength: number;
  /** 径プロファイルの雑音尺度 σ̂（病変長の信用度の目安）。 */
  profileNoise: number;
  /** 拡張（瘤）の計測（QVA のときだけ。§9.1 / A5a）。 */
  qva: {
    maxDiameter: number;
    referenceAtMax: number;
    ratio: number;
    percentDilation: number;
    length: number;
    proximalNeck: number;
    distalNeck: number;
    eccentricity: number | null;
    aneurysmal: boolean;
  } | null;
  points: number;
  /** 参照径の両端（1 区間指定なら定数になる＝両端が一致する、を確かめるため）。 */
  referenceFirst: number;
  referenceLast: number;
  unit: string;
  warnings: string[];
  /** 拡大パネルの座標変換（画面 px = (画像 px − c0) × scale）。パネル未表示なら null。 */
  view: { cx0: number; cy0: number; cw: number; ch: number; scale: number; dw: number; dh: number } | null;
}

let qcaSnapshot: QcaDebugSnapshot | null = null;

/** QCA ダイアログ／拡大パネルから呼ぶ（DEV 以外では読まれない）。 */
export function publishQcaSnapshot(patch: Partial<QcaDebugSnapshot> | null): void {
  if (!import.meta.env.DEV) return;
  qcaSnapshot = patch ? ({ ...(qcaSnapshot ?? {}), ...patch } as QcaDebugSnapshot) : null;
}

function getQcaState(): QcaDebugSnapshot | null {
  return qcaSnapshot;
}

/** QLV（左室造影）の検証用スナップショット。`fw/angio-design.md` §9.2 / A5b。 */
export interface QlvDebugSnapshot {
  /** ED/ES に選んでいるフレーム（0 origin）。 */
  edFrame: number;
  esFrame: number;
  /** 提案のままか、人が選び直したか。 */
  framesManual: boolean;
  /** ED/ES 提案の警告。 */
  frameWarnings: string[];
  /** 造影面積の時系列（提案の根拠。**数値で突き合わせるために出す**）。 */
  areaCurve: number[];
  /** 輪郭の点数。 */
  edPoints: number;
  esPoints: number;
  /** 結果。未算出なら null。 */
  result: {
    ejectionFraction: number;
    edvMl: number | null;
    esvMl: number | null;
    edVolumePx3: number;
    esVolumePx3: number;
    edAreaPx2: number;
    esAreaPx2: number;
    edLongAxisPx: number;
    kennedyEf: number | null;
    unit: string;
    warnings: string[];
    /** 壁運動の弦（正規化済み）。 */
    wallMotion: number[] | null;
    wallMotionMethod: string | null;
  } | null;
  /** 輪郭パネルの座標変換（画面 px = (画像 px − c0) × scale）。 */
  view: { cx0: number; cy0: number; cw: number; ch: number; scale: number; dw: number; dh: number } | null;
}

let qlvSnapshot: QlvDebugSnapshot | null = null;

/** QLV ダイアログ／輪郭パネルから呼ぶ（DEV 以外では読まれない）。 */
export function publishQlvSnapshot(patch: Partial<QlvDebugSnapshot> | null): void {
  if (!import.meta.env.DEV) return;
  qlvSnapshot = patch ? ({ ...(qlvSnapshot ?? {}), ...patch } as QlvDebugSnapshot) : null;
}

function getQlvState(): QlvDebugSnapshot | null {
  return qlvSnapshot;
}

/** 3D QCA（A6a）の検証用スナップショット。`fw/angio-design.md` §10.2。 */
export interface Xa3dDebugSnapshot {
  /** 選べている方向の数と、その角度（**タグから読めているか**を数値で確かめる）。 */
  viewCount: number;
  anglesA: { primary: number; secondary: number } | null;
  anglesB: { primary: number; secondary: number } | null;
  separationDeg: number | null;
  /** 2 方向の中心線の点数（画像から抽出できているか）。 */
  pointsA: number;
  pointsB: number;
  anchorCount: number;
  result: {
    acceptable: boolean;
    lengthMm: number;
    anchorReprojectionPx: number;
    /** 🚨 参考値。品質判定に使ってはいけない（§10.2.2）。 */
    matchReprojectionPx: number;
    separationDeg: number;
    points: number;
    warnings: { code: string; value: number; threshold: number; blocking: boolean }[];
    /** 3D 中心線の端点と重心（真値と突き合わせるために出す）。 */
    firstPoint: [number, number, number];
    lastPoint: [number, number, number];
    /** 各方向で見えている長さの割合（短縮）。§10.3.1 の主因。 */
    visibleFractionA: number | null;
    visibleFractionB: number | null;
  } | null;
  /** 3D 断面。出せないときは `unavailable` に理由が入る。 */
  section: {
    unavailable: string | null;
    minAreaMm2: number | null;
    minEquivalentDiameterMm: number | null;
    medianMeasurementAngleDeg: number | null;
  } | null;
  /** 3D の狭窄率。断面が出せなければ null。 */
  stenosis: {
    percentDiameterStenosis: number;
    percentAreaStenosis: number;
    mldMm: number;
    rvdMm: number;
    lesionLengthMm: number;
    /** 径プロファイルの雑音尺度 σ̂ [mm]。3D は 2D より荒れるので病変長と一緒に見る。 */
    profileNoiseMm: number;
  } | null;
  /** 短縮の少ない撮影角度の候補。 */
  workingAngles: { primary: number; secondary: number; visibleFraction: number }[];
  refinement: { beforePx: number; afterPx: number; primary: number; secondary: number } | null;
  /** ステップ・レールの状態（id → state）。 */
  steps: Record<string, string>;
}

/** 分岐部 QCA（A6b）の検証用スナップショット。`fw/angio-design.md` §21.4。 */
export interface XaBifurcationDebugSnapshot {
  carina: [number, number, number];
  endpointSpreadMm: number;
  confluenceRadiusMm: number;
  branches: {
    id: string;
    measuredPoints: number;
    excludedLengthMm: number;
    mldMm: number | null;
    rvdMm: number | null;
    percentDiameterStenosis: number | null;
    lesionLengthMm: number | null;
    referenceAtCarinaMm: number | null;
  }[];
  angles: {
    proximalToDistalDeg: number | null;
    proximalToSideDeg: number | null;
    distalToSideDeg: number | null;
  };
  consistency: {
    finet: { expectedMm: number; measuredMm: number; deviationPercent: number } | null;
    murray: { expectedMm: number; measuredMm: number; deviationPercent: number } | null;
  };
  warnings: { code: string; branch: string | null; value: number; threshold: number }[];
  /** 角度補正が掛からなかった枝（出自）。 */
  unrefinedBranches: string[];
  /**
   * 再構成した 3D 中心線（患者 LPS mm・枝ごと）。
   *
   * <p>数値が合わないときに**どの段で狂ったか**を切り分けるために出す。角度だけを見ても
   * 「2D の追跡が汚染された」のか「再構成が歪んだ」のかは区別が付かない
   * （実機で分岐角が +10° ずれたとき、真値の 2D 点列から回した結果と突き合わせて
   * 初めて追跡側だと分かった）。
   */
  branchPoints: { id: string; points: [number, number, number][] }[];
}

let xaBifurcationSnapshot: XaBifurcationDebugSnapshot | null = null;

/** 分岐部ダイアログから呼ぶ（DEV 以外では何もしない）。 */
export function publishXaBifurcationSnapshot(s: XaBifurcationDebugSnapshot | null): void {
  if (!import.meta.env.DEV) return;
  xaBifurcationSnapshot = s;
}

function getXaBifurcationState(): XaBifurcationDebugSnapshot | null {
  return xaBifurcationSnapshot;
}

let xa3dSnapshot: Xa3dDebugSnapshot | null = null;

/** 3D QCA ダイアログから呼ぶ（DEV 以外では読まれない）。 */
export function publishXa3dSnapshot(patch: Partial<Xa3dDebugSnapshot> | null): void {
  if (!import.meta.env.DEV) return;
  xa3dSnapshot = patch ? ({ ...(xa3dSnapshot ?? {}), ...patch } as Xa3dDebugSnapshot) : null;
}

function getXa3dState(): Xa3dDebugSnapshot | null {
  return xa3dSnapshot;
}

/**
 * 画像ピクセル → キャンバス上の相対位置（0〜1）。
 *
 * <p>実機検証で「**この画素の上を**クリック/ドラッグする」ために要る。真値が画素で分かっている
 * ファントム（GNBP-XA-3 の `branchesPx`）に対して、画面中央からの決め打ちではなく
 * **狙った解剖位置**を指せるようになる。
 *
 * <p>変換は viewport の `worldToCanvas` に任せる（ズーム・パン・反転を自前で再現しない）。
 */
function imagePixelsToCanvasFraction(
  points: readonly (readonly [number, number])[],
): { fx: number; fy: number }[] | null {
  const engine = getRenderingEngine(ENGINE_ID);
  const vp = engine?.getViewports?.()[0] as unknown as {
    getImageData?: () => { origin?: number[]; direction?: number[]; spacing?: number[] } | undefined;
    worldToCanvas?: (w: number[]) => number[];
    canvas?: HTMLCanvasElement;
  } | undefined;
  const data = vp?.getImageData?.();
  const canvas = vp?.canvas;
  if (!vp?.worldToCanvas || !data?.origin || !data.direction || !data.spacing || !canvas) return null;
  const o = data.origin;
  const dir = data.direction;
  const sp = data.spacing;
  const out: { fx: number; fy: number }[] = [];
  for (const [col, row] of points) {
    const w = [0, 1, 2].map((k) => o[k] + col * sp[0] * dir[k] + row * sp[1] * dir[3 + k]);
    const c = vp.worldToCanvas(w);
    out.push({ fx: c[0] / canvas.clientWidth, fy: c[1] / canvas.clientHeight });
  }
  return out;
}

/**
 * 幾何 3D ウィンドウの画素統計を取るための口。
 *
 * <p>🚨 **DOM だけを見る検査は黒い画面を通す。** canvas の存在・WebGL コンテキスト・
 * シーンの物体数・表示中の数値がすべて合格したまま 3D が真っ黒だったことがある
 * （カメラの視線と view-up が平行になって退化していた）。**描かれた画素を数える**。
 */
let geometry3dProbe: (() => { total: number; nonBackground: number; fraction: number } | null) | null = null;

export function publishGeometry3dProbe(
  fn: (() => { total: number; nonBackground: number; fraction: number } | null) | null,
): void {
  if (!import.meta.env.DEV) return;
  geometry3dProbe = fn;
}

function getGeometry3dStats(): { total: number; nonBackground: number; fraction: number } | null {
  return geometry3dProbe ? geometry3dProbe() : null;
}

declare global {
  interface Window {
    __graphyDebug?: {
      getImagePixelRange: typeof getImagePixelRange;
      getPixelStats: typeof getPixelStats;
      getViewportGeometry: typeof getViewportGeometry;
      getViewportProperties: typeof getViewportProperties;
      getXaCineStats: typeof getXaCineStats;
      getQcaState: typeof getQcaState;
      getQlvState: typeof getQlvState;
      getXa3dState: typeof getXa3dState;
      getXaBifurcationState: typeof getXaBifurcationState;
      imagePixelsToCanvasFraction: typeof imagePixelsToCanvasFraction;
      getGeometry3dStats: typeof getGeometry3dStats;
    };
  }
}

let installed = false;

/** 冪等: 何度呼んでも安全（SeriesViewer マウントの都度呼ばれる想定）。 */
export function installDebugApi(): void {
  if (installed || !import.meta.env.DEV) return;
  window.__graphyDebug = {
    getImagePixelRange,
    getPixelStats,
    getViewportGeometry,
    getViewportProperties,
    getXaCineStats,
    getQcaState,
    getQlvState,
    getXa3dState,
    getXaBifurcationState,
    imagePixelsToCanvasFraction,
    getGeometry3dStats,
  };
  installed = true;
}
