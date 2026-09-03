/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * IVUS / OCT のプルバックとアンギオの対応づけ（`fw/angio-design.md` §12 / A8）。
 *
 * <h3>対応づけの規則</h3>
 * <pre>
 *   d(f) = (f − startFrame) / frameRate × pullbackRate        [mm]
 * </pre>
 * カテーテルは一定速度で引き抜かれるので、**フレーム番号は引き抜き距離に比例する**。
 * 距離が決まれば、アンギオ上に引いた**プルバック経路の始点から d mm 進んだ位置**が決まる。
 *
 * <h3>🔴 これは近似である（§12.3）</h3>
 * 心拍ごとに血管は縦方向へ 1 心拍あたり数 mm 動くが、この式はそれを**無視している**。
 * したがって対応づけの精度は **±1〜2mm** 程度で、**ステント端の位置決めに単独で使えない**。
 * 画面に必ず出すこと（数値だけ出すと精度が保証されているように読める）。
 *
 * <h3>ランドマークによる区分線形</h3>
 * 分岐やステント端など「両方の画像で同じ場所と分かる点」を対で与えると、その間を
 * **線形に引き伸ばす**。一定速度からのずれ（引き抜きの滑り・心拍による前後動）を
 * 部分的に吸収できる。**実装は同じ関数**で、ランドマークが 0 個なら上の式そのものになる。
 *
 * <h3>🚨 出せないときに出さない</h3>
 * `IVUSPullbackRate` が無ければ**距離は出せない**。フレーム番号だけを見せて
 * 「mm が出せない理由」を画面に書く。既定値（例えば 0.5mm/s）を勝手に使うと、
 * **装置が違うだけで全部ずれた数字**が、正しい顔をして出る。
 */

import { readXaCineSource, resolveXaFps, xaDataSetOf } from "./xaCine";

/** プルバックのタグ（`0018,3101`〜`0018,3104`）から読んだ値。 */
export interface PullbackSource {
  /** 総フレーム数。 */
  numberOfFrames: number;
  /** `IVUSPullbackRate (0018,3101)` [mm/s]。無ければ距離を出さない。 */
  pullbackRateMmPerS?: number | null;
  /** フレームレート [fps]。`IVUSGatedRate (0018,3102)` か FrameTime 由来。 */
  frameRate?: number | null;
  /** `IVUSPullbackStartFrameNumber (0018,3103)`。**1 origin**（DICOM の規約）。 */
  startFrameNumber?: number | null;
  /** `IVUSPullbackStopFrameNumber (0018,3104)`。**1 origin**。 */
  stopFrameNumber?: number | null;
}

export type PullbackUnavailable =
  /** 引き抜き速度が無い＝距離に換算できない。 */
  | "noPullbackRate"
  /** フレームレートが無い＝時間が出せない。 */
  | "noFrameRate";

export interface PullbackGeometry {
  /** 0 origin。この手前のフレームは「引き抜き前」なので距離が負になる。 */
  startFrame: number;
  /** 0 origin（含む）。 */
  stopFrame: number;
  frameRate: number;
  pullbackRateMmPerS: number;
  /** 引き抜き区間の全長 [mm]。 */
  lengthMm: number;
}

/**
 * タグからプルバックの幾何を作る。出せなければ理由を返す。
 *
 * <p>⚠️ **開始・停止フレームは 1 origin** で書かれる（DICOM の規約）。ここで 0 origin へ
 * 直す。直し忘れると**全体が 1 フレームぶん（この装置なら 0.017mm）ずれる**——小さいので
 * 目視では気付けない。
 */
export function pullbackGeometry(
  src: PullbackSource,
): { geometry: PullbackGeometry } | { unavailable: PullbackUnavailable } {
  const rate = src.pullbackRateMmPerS;
  if (!(typeof rate === "number" && Number.isFinite(rate) && rate > 0)) {
    return { unavailable: "noPullbackRate" };
  }
  const fps = src.frameRate;
  if (!(typeof fps === "number" && Number.isFinite(fps) && fps > 0)) {
    return { unavailable: "noFrameRate" };
  }
  const n = Math.max(1, Math.floor(src.numberOfFrames));
  const start = clampFrame((src.startFrameNumber ?? 1) - 1, n);
  const stop = clampFrame((src.stopFrameNumber ?? n) - 1, n);
  const lengthMm = Math.max(0, (stop - start) / fps) * rate;
  return {
    geometry: {
      startFrame: Math.min(start, stop),
      stopFrame: Math.max(start, stop),
      frameRate: fps,
      pullbackRateMmPerS: rate,
      lengthMm,
    },
  };
}

function clampFrame(v: number, n: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(n - 1, Math.round(v)));
}

/**
 * 「両方の画像で同じ場所と分かる点」の対。
 *
 * @property frame 断層のフレーム（0 origin）
 * @property distanceMm アンギオ上の経路の**始点からの弧長** [mm]
 */
export interface PullbackLandmark {
  frame: number;
  distanceMm: number;
}

/**
 * フレーム → 経路上の距離 [mm]。
 *
 * <p>ランドマークが 0 個なら一定速度の式そのもの。1 個以上あるとその点を**通るように**
 * 区分線形で引き伸ばす（区間の外は最も近い区間の傾きで外挿する）。
 *
 * <p>🔴 **引き抜き開始より前のフレームは負の距離**を返す。0 に丸めない——
 * 「まだ引き抜いていない」ことと「始点にいる」ことは別で、丸めると
 * **静止区間の全フレームが始点に対応づく**（数十フレームが同じ位置を指す）。
 */
export function distanceForFrame(
  geometry: PullbackGeometry,
  frame: number,
  landmarks: readonly PullbackLandmark[] = [],
): number {
  const base = (f: number) =>
    ((f - geometry.startFrame) / geometry.frameRate) * geometry.pullbackRateMmPerS;
  const pts = normaliseLandmarks(landmarks);
  if (pts.length === 0) return base(frame);

  // 区間を探す。ランドマークはフレーム昇順に整列済み。
  if (frame <= pts[0].frame) {
    // 手前は、最初のランドマークと「開始点（フレーム=startFrame・距離 0）」で決まる傾き。
    const anchorFrame = geometry.startFrame;
    const anchorDist = 0;
    if (pts[0].frame === anchorFrame) return pts[0].distanceMm;
    const slope = (pts[0].distanceMm - anchorDist) / (pts[0].frame - anchorFrame);
    return anchorDist + (frame - anchorFrame) * slope;
  }
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (frame <= b.frame) {
      const t = (frame - a.frame) / (b.frame - a.frame);
      return a.distanceMm + (b.distanceMm - a.distanceMm) * t;
    }
  }
  // 最後のランドマークより先は、直前の区間の傾き（1 個しか無ければ一定速度）で外挿。
  const last = pts[pts.length - 1];
  if (pts.length >= 2) {
    const prev = pts[pts.length - 2];
    const slope = (last.distanceMm - prev.distanceMm) / (last.frame - prev.frame);
    return last.distanceMm + (frame - last.frame) * slope;
  }
  return last.distanceMm + (base(frame) - base(last.frame));
}

/**
 * 経路上の距離 [mm] → フレーム（0 origin・丸めた整数）。{@link distanceForFrame} の逆。
 *
 * <p>アンギオ側を動かしたときに断層を追従させるのに使う（§12 の「どちらを動かしても
 * 他方が追従」）。単調増加なので二分探索でよいが、フレーム数が高々数千なので線形で足りる。
 */
export function frameForDistance(
  geometry: PullbackGeometry,
  distanceMm: number,
  frameCount: number,
  landmarks: readonly PullbackLandmark[] = [],
): number {
  const n = Math.max(1, Math.floor(frameCount));
  if (normaliseLandmarks(landmarks).length === 0) {
    const f =
      geometry.startFrame + (distanceMm / geometry.pullbackRateMmPerS) * geometry.frameRate;
    return clampFrame(f, n);
  }
  // 区分線形なので、距離が単調なら最も近いフレームを探せばよい。
  let best = 0;
  let bestErr = Infinity;
  for (let f = 0; f < n; f++) {
    const err = Math.abs(distanceForFrame(geometry, f, landmarks) - distanceMm);
    if (err < bestErr) {
      bestErr = err;
      best = f;
    }
  }
  return best;
}

/**
 * ランドマークを整える。
 *
 * <p>🚨 **フレームが同じ対が 2 つあると区間の幅が 0 になり、傾きが無限大になる**
 * （同じフレームに違う距離を割り当てた＝矛盾）。**後から入れたほうを採る**のではなく
 * **落とす**——利用者がどちらを意図したか分からないので、黙って片方を選ぶより
 * 一定速度へ戻るほうが説明できる。
 */
function normaliseLandmarks(landmarks: readonly PullbackLandmark[]): PullbackLandmark[] {
  const usable = landmarks.filter(
    (l) => Number.isFinite(l.frame) && Number.isFinite(l.distanceMm) && l.frame >= 0,
  );
  const byFrame = new Map<number, PullbackLandmark[]>();
  for (const l of usable) {
    const key = Math.round(l.frame);
    const list = byFrame.get(key);
    if (list) list.push(l);
    else byFrame.set(key, [l]);
  }
  const out: PullbackLandmark[] = [];
  for (const [frame, list] of byFrame) {
    if (list.length !== 1) continue; // 矛盾している対は使わない
    out.push({ frame, distanceMm: list[0].distanceMm });
  }
  out.sort((a, b) => a.frame - b.frame);
  // 距離も単調でなければ使えない（逆行する対応づけは意味を成さない）。
  for (let i = 1; i < out.length; i++) {
    if (!(out[i].distanceMm > out[i - 1].distanceMm)) return [];
  }
  return out;
}

/**
 * アンギオ上のプルバック経路。始点＝カテーテル先端の初期位置、終点＝引き抜き終わり。
 *
 * <p>点列は画像 px。`mmPerPx` は空間校正（§7）から来る。
 * 🔴 **未校正なら距離を出さない**（px の長さを mm と呼ばない）。
 */
export interface PullbackPath {
  pointsPx: readonly (readonly [number, number])[];
  mmPerPx: number | null;
}

/**
 * 経路上で距離 `d` [mm] にあたる画像 px 座標。
 *
 * <p>未校正（`mmPerPx` が無い）なら null。経路の外へ出る距離は**端で止める**
 * （外挿すると血管の外を指すので、そこに印を出すほうが有害）。
 */
export function pointAtDistance(
  path: PullbackPath,
  distanceMm: number,
): { x: number; y: number; clamped: boolean } | null {
  const { pointsPx, mmPerPx } = path;
  if (!mmPerPx || !(mmPerPx > 0) || pointsPx.length < 2) return null;
  const targetPx = distanceMm / mmPerPx;

  let acc = 0;
  if (targetPx <= 0) {
    return { x: pointsPx[0][0], y: pointsPx[0][1], clamped: targetPx < 0 };
  }
  for (let i = 1; i < pointsPx.length; i++) {
    const dx = pointsPx[i][0] - pointsPx[i - 1][0];
    const dy = pointsPx[i][1] - pointsPx[i - 1][1];
    const seg = Math.hypot(dx, dy);
    if (acc + seg >= targetPx) {
      const t = seg > 0 ? (targetPx - acc) / seg : 0;
      return { x: pointsPx[i - 1][0] + dx * t, y: pointsPx[i - 1][1] + dy * t, clamped: false };
    }
    acc += seg;
  }
  const last = pointsPx[pointsPx.length - 1];
  return { x: last[0], y: last[1], clamped: true };
}

/** 経路の全長 [mm]（未校正なら null）。 */
export function pathLengthMm(path: PullbackPath): number | null {
  const { pointsPx, mmPerPx } = path;
  if (!mmPerPx || !(mmPerPx > 0) || pointsPx.length < 2) return null;
  let acc = 0;
  for (let i = 1; i < pointsPx.length; i++) {
    acc += Math.hypot(pointsPx[i][0] - pointsPx[i - 1][0], pointsPx[i][1] - pointsPx[i - 1][1]);
  }
  return acc * mmPerPx;
}

/**
 * 経路の長さと引き抜きの長さが食い違っていないか。
 *
 * <p>🔑 **食い違いは「経路を引き間違えた」ことの唯一の手掛かり**である。カテーテルが
 * 9mm 引き抜かれたのに経路が 30mm あるなら、経路が長すぎる（別の枝まで引いた等）。
 * どちらが正しいかは決められないので、**差を出して人に判断させる**。
 *
 * @returns 差の比（経路長 / 引き抜き長）。出せなければ null。
 */
export function pathLengthRatio(path: PullbackPath, geometry: PullbackGeometry): number | null {
  const len = pathLengthMm(path);
  if (len == null || !(geometry.lengthMm > 0)) return null;
  return len / geometry.lengthMm;
}

/** 対応づけの精度の目安 [mm]（§12.3）。**心拍による縦方向運動を無視した近似**。 */
export const PULLBACK_ACCURACY_MM = 2;

/* ------------------------------------------------------------------ */
/* DICOM タグの読み取り                                                */
/* ------------------------------------------------------------------ */

/**
 * プルバックのタグを読む。プリウォーム前（dataSet が未キャッシュ）は null。
 *
 * <p>🔑 **`xaCine.ts` と同じ「生タグを直読み」の作法**を使う（Cornerstone の metaData
 * プロバイダはこれらのタグを供給しない）。`prewarmXaDataset(imageId)` を先に呼ぶこと。
 *
 * <p>⚠️ **フレームレートは `IVUSGatedRate` を優先し、無ければ FrameTime 系へ落ちる。**
 * 心電同期して間引いた収集では「表示 fps」と「引き抜きに対応する fps」が違うので、
 * 装置が明示している `IVUSGatedRate` のほうが正しい。
 */
export function readPullbackSource(imageId: string): PullbackSource | null {
  const ds = xaDataSetOf(imageId);
  if (!ds) return null;
  const cine = readXaCineSource(imageId);
  const gated = ds.floatString("x00183102");
  const frameRate =
    typeof gated === "number" && Number.isFinite(gated) && gated > 0
      ? gated
      : cine
        ? resolveXaFps(cine).fps
        : null;
  return {
    numberOfFrames: cine?.numberOfFrames ?? 1,
    pullbackRateMmPerS: ds.floatString("x00183101") ?? null,
    frameRate,
    startFrameNumber: ds.intString("x00183103") ?? null,
    stopFrameNumber: ds.intString("x00183104") ?? null,
  };
}
