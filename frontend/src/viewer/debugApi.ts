/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { cache, getRenderingEngine, metaData } from "@cornerstonejs/core";
import { ENGINE_ID } from "./Viewer2D";
import { readCamera, readColormapName, readInvert, readVoiWindow } from "./viewportRead";
import { annotation as csAnnotation } from "@cornerstonejs/tools";
import { getRoiStats, getRoiStatsByData } from "./roiStatsStore";
import {
  getVesselModel,
  listVesselModels,
  putVesselAnalysis,
} from "../plugins/pluginVesselApi";
import { calibrationForImageId } from "./xaCalibrationProvider";
import type { Geometry3DPixelStats } from "./vtkGeometryView";

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
  /**
   * 白黒反転が掛かっているか。
   * 🚨 **書き出し（PNG / MP4）が画面と同じ極性か**を automator が突き合わせるのに要る。
   * 実機で「MP4 が画面の完全な補色」という壊れ方を掴んだのがこの値（2026-08-23）。
   */
  invert: boolean | null;
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
      invert: readInvert(vp),
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
  /**
   * 径を何で測ったか（§16.5）。**検証側はこれを見て期待値を切り替える**——
   * 半値法と密度計測では真値との係数が違うので、方式を見ずに 1 つの期待値で
   * 突き合わせると、退避が起きた瞬間に嘘の失敗（または嘘の合格）になる。
   */
  diameterMethod: "half-max" | "densitometric";
  /** 密度計測に使った μ（半値法なら null）。 */
  muPerMm: number | null;
  /** 密度計測を使わなかった理由（使ったなら null）。 */
  densitometryFallback: string | null;
  points: number;
  /** 参照径の両端（1 区間指定なら定数になる＝両端が一致する、を確かめるため）。 */
  referenceFirst: number;
  referenceLast: number;
  unit: string;
  warnings: string[];
  /** 拡大パネルの座標変換（画面 px = (画像 px − c0) × scale）。パネル未表示なら null。 */
  view: { cx0: number; cy0: number; cw: number; ch: number; scale: number; dw: number; dh: number } | null;
  /**
   * ストレート像（§8.9）の座標系。出していなければ null。
   *
   * <p>🔴 **横が弧長で刻まれているか**は画面の見た目では分からない（添字で刻んでも
   * それらしい帯が出る）。列数を中心線の全長と突き合わせられるように数値で出す。
   */
  straight: {
    cols: number;
    rows: number;
    halfWidthPx: number;
    lengthPx: number;
    scale: number;
    dw: number;
    dh: number;
  } | null;
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
  /**
   * 合成した 2 方向の径が**何で測られたか**（§16.5）。半値法と密度計測では
   * 絶対値が 10% 以上違うので、断面積の期待値もこれで切り替える。
   * 2 方向で違っていたら `"mixed"`（そのまま数値を信じてはいけない状態）。
   */
  diameterMethod: "half-max" | "densitometric" | "mixed" | null;
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
  /** カリーナの出自（"geometry" ＝ 内接球・"endpoints" ＝ 旧方式への退避）。 */
  carinaSource: string;
  /** 内接球の半径 [mm]（"geometry" のときだけ）。 */
  inscribedRadiusMm: number | null;
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
  /** ワーキングアングルの候補（§21.4.4）。上位から。 */
  workingAngles: {
    primaryAngleDeg: number;
    secondaryAngleDeg: number;
    minVisibleFraction: number;
    overlapLengthMm: number;
    overlapPair: string[];
    edgeAware: boolean;
    score: number;
  }[];
  /** 角度補正が掛からなかった枝（出自）。 */
  unrefinedBranches: string[];
  /**
   * カリーナ付近の 2 方向それぞれの径（切り分け専用）。片方だけ太いなら**投影で重なっている**、
   * 両方太いなら**本当に太い**。
   */
  carinaProfile: {
    id: string;
    samples: { fromCarinaMm: number; dA: number; dB: number; equiv: number }[];
  }[];
  /** 3 枝が同じ視点ペアを見ていたか（違うとアンカーを束ねられない）。 */
  viewPairShared: boolean;
  /**
   * 3 枝ぶんのアンカーを束ねて視点ペアに 1 回だけ掛けた角度補正（§21.4 の段 3）。
   * 掛からなかったときは null。
   */
  refinement: {
    /** 門を通って**実際に適用した**か。false なら候補は出したが幾何はタグのまま。 */
    applied: boolean;
    beforePx: number;
    afterPx: number;
    primaryDeg: number;
    secondaryDeg: number;
    anchorCount: number;
  } | null;
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
let geometry3dProbe: (() => Geometry3DPixelStats | null) | null = null;

export function publishGeometry3dProbe(fn: (() => Geometry3DPixelStats | null) | null): void {
  if (!import.meta.env.DEV) return;
  geometry3dProbe = fn;
}

function getGeometry3dStats(): Geometry3DPixelStats | null {
  return geometry3dProbe ? geometry3dProbe() : null;
}

/**
 * いま選択（ハイライト）されている注釈の UID。
 *
 * <p>🚨 「画像で示す」（§8.7.1）が効いたことは、**画面の色だけでは機械で確かめられない**
 * ——線が 1 本色を変えるだけなので、画素の統計にはほとんど出ない。選択の実体
 * （Cornerstone の annotation selection）を読む。
 */
function getSelectedAnnotations(): string[] {
  try {
    return [...(csAnnotation.selection.getAnnotationsSelected() ?? [])];
  } catch {
    return [];
  }
}

/**
 * ROI 統計の**同じ ROI に対する 2 つの読み口**を並べて返す（automator の切り分け用）。
 *
 * <p>表示（`annotation.data` をキーにした WeakMap）と問い合わせ（annotationUID の Map）が
 * 食い違うと「画面の値とプラグインの値が違う」になる。どちらが古いのかを機械的に見る口。
 */
function getRoiStatsPair(): Array<{
  uid: string;
  tool: string;
  refImageId: string | null;
  byUidMean: number | null;
  byDataMean: number | null;
  byUidSamples: number | null;
  byDataSamples: number | null;
  sameEntry: boolean;
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anns = ((csAnnotation.state as any).getAllAnnotations?.() ?? []) as any[];
  return anns.map((a) => {
    const uid = (a?.annotationUID as string) ?? "";
    const byUid = getRoiStats(uid);
    const byData = getRoiStatsByData(a?.data);
    return {
      uid,
      tool: (a?.metadata?.toolName as string) ?? "",
      refImageId: (a?.metadata?.referencedImageId as string) ?? null,
      byUidMean: byUid?.values?.mean ?? null,
      byDataMean: byData?.values?.mean ?? null,
      byUidSamples: byUid?.geometry.sampleCount ?? null,
      byDataSamples: byData?.geometry.sampleCount ?? null,
      sameEntry: !!byUid && byUid === byData,
    };
  });
}

declare global {
  interface Window {
    __graphyDebug?: {
      getRoiStatsPair: typeof getRoiStatsPair;
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
      getXaCalibration: typeof getXaCalibration;
      getVesselModels: typeof getVesselModels;
      getVesselModel: typeof getVesselModelBody;
      getSelectedAnnotations: typeof getSelectedAnnotations;
      putVesselAnalysis: typeof putVesselAnalysisDebug;
      seedVesselAnalysis: typeof seedVesselAnalysis;
    };
  }
}


/**
 * A7（H11 / H12）を**プラグイン無しで動かすための口**。DEV 限定。
 *
 * <p>🚨 FFR モジュールは外部（プラグイン）なので、本体だけでは「モデルを渡して値を受け取る」
 * 経路を一度も通せない。実機検証で**血管に色が乗るところまで**を見るために、
 * host API と同じ関数を叩く口を出す。
 *
 * <p>⚠️ **本番には出ない**（`import.meta.env.DEV` ガード）。ここから入れた値も
 * 出自は "debug" として記録されるので、画面の凡例で本物と区別できる。
 */
function getVesselModels(): ReturnType<typeof listVesselModels> {
  return listVesselModels();
}

/**
 * H11 の**モデル本体**（`runId` 省略で最も新しいもの）。
 *
 * <p>🔴 一覧（{@link getVesselModels}）は**要約**で、点数と校正の区分しか持たない。
 * 中心線・径・校正の出自を確かめるには本体が要る——実機検証で一覧を本体と取り違え、
 * 「モデルに中心線が入っていない」という**偽の不具合**を作った（2026-08-29）。
 */
function getVesselModelBody(runId?: string): ReturnType<typeof getVesselModel> {
  return getVesselModel(runId);
}

function putVesselAnalysisDebug(
  runId: string,
  result: Parameters<typeof putVesselAnalysis>[1],
): ReturnType<typeof putVesselAnalysis> {
  return putVesselAnalysis(runId, result, { id: "debug", name: "debug", version: "0" });
}

/**
 * いちばん新しいモデルへ、**径から作った合成値**を乗せる（色マップの目視確認用）。
 * 径が細いところほど値が小さくなるので、狭窄の位置と色が合っているかを見られる。
 * 径が無い点は**値を入れない**（グレーのまま＝「埋めない」の確認も兼ねる）。
 */
function seedVesselAnalysis(label = "DEBUG"): { ok: boolean; error?: string; runId?: string } {
  const m = getVesselModel();
  if (!m) return { ok: false, error: "no vessel model" };
  const seg = m.segments[0];
  const ds = seg.diameterMm.filter((d): d is number => d != null);
  if (ds.length === 0) return { ok: false, error: "no diameters" };
  const max = Math.max(...ds);
  const perPoint = seg.diameterMm
    .map((d, index) => (d == null ? null : { segmentId: seg.id, index, value: d / max }))
    .filter((p): p is { segmentId: string; index: number; value: number } => p != null);
  const r = putVesselAnalysisDebug(m.runId, {
    kind: "custom",
    label,
    range: [0.5, 1],
    perPoint,
    disclaimer: "DEBUG: 径の比を色にしただけの合成値です。臨床的な意味はありません。",
  });
  return { ...r, runId: m.runId };
}


/**
 * 表示中タイルの**空間校正の解決結果**（`fw/angio-design.md` §7.2 の P0〜P7）。DEV 限定。
 *
 * <h3>🚨 なぜ要るのか</h3>
 * 校正の分岐は**タグの書かれ方**で決まるが、実データ（Rubo の XA 5 本）は空間校正タグを
 * **1 つも持たない**ので、P1〜P5 は**実 DICOM で一度も通っていなかった**（§20-7）。
 * ファントム GNBP-XA-4 はタグの書かれ方を 5 変種で書き分けてあるが、
 * **画面から数値で読む口が無い**と「どの枝に落ちたか」を検証できない。
 *
 * <p>⚠️ スケールバーの文字（"20 mm" / "100 px"）だけでは足りない。
 * **mm と出ていても値が間違っていることがある**し、P3'（降格）と P4（幾何近似）は
 * どちらも mm を出すので**表示だけでは区別が付かない**。出自まで読む。
 */
export interface XaCalibrationProbe {
  viewportId: string;
  imageId: string | null;
  mmPerPxRow: number | null;
  mmPerPxCol: number | null;
  source: string;
  confidence: string;
  tier: string;
  plane: string;
  provenance: string;
  warnings: string[];
  detectorMmPerPx: number | null;
}

function getXaCalibration(): XaCalibrationProbe[] {
  const engine = getRenderingEngine(ENGINE_ID);
  if (!engine) return [];
  const out: XaCalibrationProbe[] = [];
  for (const vp of engine.getViewports()) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imageId: string | null = (vp as any).getCurrentImageId?.() ?? null;
    // 🔴 校正は必ず単一入口（`xaCalibrationProvider`）から読む。ここで PixelSpacing を
    //    直接読むと、検証している当のものと別の答えを見ることになる。
    const c = imageId ? calibrationForImageId(imageId) : null;
    out.push({
      viewportId: vp.id,
      imageId,
      mmPerPxRow: c?.mmPerPxRow ?? null,
      mmPerPxCol: c?.mmPerPxCol ?? null,
      source: c?.source ?? "none",
      confidence: c?.confidence ?? "none",
      tier: c?.tier ?? "uncalibrated",
      plane: c?.plane ?? "unknown",
      provenance: c?.provenance ?? "",
      warnings: c?.warnings ?? [],
      detectorMmPerPx: c?.detectorMmPerPx ?? null,
    });
  }
  return out;
}

let installed = false;

/** 冪等: 何度呼んでも安全（SeriesViewer マウントの都度呼ばれる想定）。 */
export function installDebugApi(): void {
  if (installed || !import.meta.env.DEV) return;
  window.__graphyDebug = {
    getRoiStatsPair,
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
    getXaCalibration,
    getVesselModels,
    getVesselModel: getVesselModelBody,
    getSelectedAnnotations,
    putVesselAnalysis: putVesselAnalysisDebug,
    seedVesselAnalysis,
  };
  installed = true;
}
