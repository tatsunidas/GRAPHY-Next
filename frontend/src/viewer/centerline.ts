/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Curved MPR 用の 3D 中心線（センターライン）。旧 GRAPHY
 * `com.vis.core.slicer.Centerline3D` の TS 移植（純関数・Cornerstone 非依存）。
 *
 * 患者座標系（LPS, mm。DICOM の ImagePositionPatient/ImageOrientationPatient と同一系）で完結する
 * 順序付き制御点列で空間曲線を定義する。Curved MPR（曲面平面再構成）のセンターライン入力に使う。
 *
 * - 補間は **Centripetal Catmull-Rom**（旧 `EndoPath3D` と同流儀。ただし実 mm 座標で評価）。
 * - 弧長パラメータ化（サンプル表）と、弧長位置ごとの**正規直交フレーム**（tangent/normal/binormal）を提供する。
 *   これにより曲線に沿った帯（バンド）サンプリングが可能。
 * - 第2軸（normal）の取り方は 2 通り:
 *   - `FIXED_Z`: 常に world Z（頭尾）軸を接線直交面へ投影（歯科パノラマ等。曲線が 1 断面内に収まる用途）。
 *   - `ROTATION_MINIMIZING`: 二重反射法（Wang et al. 2008）で捩れ最小フレームを伝播（血管 CPR 等、曲線が
 *     面外へ出て world 軸が接線と縮退し得る用途）。
 *
 * 設計: `fw/slicer-design.md` §P4（Curved MPR）。旧 Java 実装と数値一致することを scratchpad で検証する。
 */
import type { Vec3 } from "./reslice";

/** 第2軸（曲線ローカルの "up"）の規約。 */
export type FrameMode = "FIXED_Z" | "ROTATION_MINIMIZING";

/** 弧長位置での 位置 + 正規直交フレーム。 */
export interface CurveFrame {
  position: Vec3;
  tangent: Vec3; // 単位
  normal: Vec3; // 単位、接線に直交（＝出力の第2軸方向）
  binormal: Vec3; // 単位、tangent × normal（帯サンプリング方向）
}

const CATMULL_ROM_ALPHA = 0.5; // centripetal
const MIN_CHORD = 1e-6;
const SAMPLES_PER_SEGMENT = 20; // 弧長サンプル表の密度

// ── ベクトル小道具（新規配列を返す純関数） ─────────────────────────
const v = (a = 0, b = 0, c = 0): Vec3 => [a, b, c];
const clone = (a: Vec3): Vec3 => [a[0], a[1], a[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const lenSq = (a: Vec3): number => a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const normalizeInPlace = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  a[0] /= n;
  a[1] /= n;
  a[2] /= n;
  return a;
};
const lerp = (a: Vec3, b: Vec3, f: number): Vec3 => [
  a[0] + (b[0] - a[0]) * f,
  a[1] + (b[1] - a[1]) * f,
  a[2] + (b[2] - a[2]) * f,
];
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

/**
 * 接線に直交する単位ベクトルを 1 本作る（FIXED_Z の第2軸の素）。接線が world Z にほぼ平行なときは
 * 別の参照軸へフォールバックする（旧実装 `perpendicularOf` と同一）。
 */
function perpendicularOf(tangent: Vec3): Vec3 {
  const worldUp: Vec3 = [0, 0, 1];
  const alignment = Math.abs(dot(tangent, worldUp));
  let reference: Vec3 = alignment > 0.95 ? [1, 0, 0] : worldUp;
  let normal = sub(reference, mul(tangent, dot(tangent, reference)));
  if (lenSq(normal) < 1e-12) {
    // 極めて稀な相殺: もう一方のフォールバック軸を使う。
    reference = reference[0] !== 0 ? [0, 1, 0] : [1, 0, 0];
    normal = sub(reference, mul(tangent, dot(tangent, reference)));
  }
  return normalizeInPlace(normal);
}

export class Centerline3D {
  private points: Vec3[] = [];

  private dirty = true;
  private sampleArcLength: number[] = [0];
  private samplePosition: Vec3[] = [v()];
  private sampleTangent: Vec3[] = [v(0, 0, 1)];
  private sampleNormalFixedZ: Vec3[] = [v(1, 0, 0)];
  private sampleNormalRmf: Vec3[] = [v(1, 0, 0)];
  private totalLength = 0;

  // ===================== CRUD =====================

  size(): number {
    return this.points.length;
  }

  isEmpty(): boolean {
    return this.points.length === 0;
  }

  getControlPoint(index: number): Vec3 {
    return clone(this.points[index]);
  }

  getControlPointsSnapshot(): Vec3[] {
    return this.points.map(clone);
  }

  addControlPoint(position: Vec3): number {
    this.points.push(clone(position));
    this.markDirty();
    return this.points.length - 1;
  }

  insertControlPoint(index: number, position: Vec3): void {
    this.points.splice(index, 0, clone(position));
    this.markDirty();
  }

  setControlPoint(index: number, position: Vec3): void {
    this.points[index] = clone(position);
    this.markDirty();
  }

  removeControlPoint(index: number): void {
    this.points.splice(index, 1);
    this.markDirty();
  }

  clear(): void {
    this.points = [];
    this.markDirty();
  }

  // ===================== spline evaluation (segment space) =====================

  /** 曲線上の位置。t はセグメント空間（0=先頭点, segmentCount=末尾点）でクランプ。 */
  evaluatePosition(t: number): Vec3 {
    if (this.points.length === 0) throw new Error("Centerline3D has no points");
    if (this.points.length === 1) return clone(this.points[0]);

    const segmentCount = this.points.length - 1;
    const ct = clamp(t, 0, segmentCount);
    let segIndex = Math.floor(ct);
    if (segIndex >= segmentCount) segIndex = segmentCount - 1;
    const s = ct - segIndex;

    if (this.points.length === 2) return lerp(this.points[0], this.points[1], s);

    const p0 = this.getPhantomControlPoint(segIndex - 1);
    const p1 = this.getPhantomControlPoint(segIndex);
    const p2 = this.getPhantomControlPoint(segIndex + 1);
    const p3 = this.getPhantomControlPoint(segIndex + 2);
    return catmullRom(p0, p1, p2, p3, s);
  }

  // index<0 / index>=size は外挿したファントム点を返す。
  private getPhantomControlPoint(index: number): Vec3 {
    const n = this.points.length;
    if (index < 0) {
      const p0 = this.points[0];
      const p1 = this.points[1];
      return sub(mul(p0, 2), p1);
    }
    if (index >= n) {
      const pLast = this.points[n - 1];
      const pPrev = this.points[n - 2];
      return sub(mul(pLast, 2), pPrev);
    }
    return clone(this.points[index]);
  }

  // ===================== arc-length parameterization =====================

  getTotalLength(): number {
    this.ensureFresh();
    return this.totalLength;
  }

  /** 弧長位置 mm での 位置 + フレーム。[0, length] にクランプ。 */
  frameAt(arcLengthMm: number, mode: FrameMode): CurveFrame {
    this.ensureFresh();
    if (this.points.length === 1) {
      const pos = clone(this.points[0]);
      const tangent: Vec3 = [0, 0, 1];
      const normal = perpendicularOf(tangent);
      const binormal = cross(tangent, normal);
      return { position: pos, tangent, normal, binormal };
    }

    const arr = this.sampleArcLength;
    const n = arr.length;
    const d = clamp(arcLengthMm, 0, this.totalLength);
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= d) lo = mid;
      else hi = mid;
    }

    const segLen = arr[hi] - arr[lo];
    const f = segLen > 1e-9 ? (d - arr[lo]) / segLen : 0;

    const pos = lerp(this.samplePosition[lo], this.samplePosition[hi], f);
    const tangent = lerp(this.sampleTangent[lo], this.sampleTangent[hi], f);
    if (lenSq(tangent) > 1e-12) normalizeInPlace(tangent);
    else {
      tangent[0] = 0;
      tangent[1] = 0;
      tangent[2] = 1;
    }

    const normalTable = mode === "FIXED_Z" ? this.sampleNormalFixedZ : this.sampleNormalRmf;
    let normal = lerp(normalTable[lo], normalTable[hi], f);
    // 補間した接線に対して再直交化（独立 lerp はわずかにドリフトする）。
    normal = sub(normal, mul(tangent, dot(normal, tangent)));
    if (lenSq(normal) > 1e-12) normalizeInPlace(normal);
    else normal = perpendicularOf(tangent);

    const binormal = cross(tangent, normal);
    return { position: pos, tangent, normal, binormal };
  }

  // ===================== 内部: 弧長サンプル表 =====================

  private markDirty(): void {
    this.dirty = true;
  }

  private ensureFresh(): void {
    if (this.dirty) {
      this.rebuildArcLengthTable();
      this.dirty = false;
    }
  }

  private rebuildArcLengthTable(): void {
    const n = this.points.length;
    if (n < 2) {
      const pos = n === 1 ? clone(this.points[0]) : v();
      this.sampleArcLength = [0];
      this.samplePosition = [pos];
      this.sampleTangent = [v(0, 0, 1)];
      this.sampleNormalFixedZ = [perpendicularOf(this.sampleTangent[0])];
      this.sampleNormalRmf = [clone(this.sampleNormalFixedZ[0])];
      this.totalLength = 0;
      return;
    }

    const segmentCount = n - 1;
    const sampleCount = segmentCount * SAMPLES_PER_SEGMENT + 1;
    const arcLength = new Array<number>(sampleCount);
    const position = new Array<Vec3>(sampleCount);
    const tangent = new Array<Vec3>(sampleCount);

    let idx = 0;
    for (let seg = 0; seg < segmentCount; seg++) {
      for (let k = 0; k < SAMPLES_PER_SEGMENT; k++) {
        const t = seg + k / SAMPLES_PER_SEGMENT;
        position[idx] = this.evaluatePosition(t);
        idx++;
      }
    }
    position[idx] = this.evaluatePosition(segmentCount); // 末尾点
    idx++;

    arcLength[0] = 0;
    for (let i = 1; i < sampleCount; i++) {
      arcLength[i] = arcLength[i - 1] + distance(position[i], position[i - 1]);
    }
    this.totalLength = arcLength[sampleCount - 1];

    for (let i = 0; i < sampleCount; i++) {
      const prev = position[Math.max(i - 1, 0)];
      const next = position[Math.min(i + 1, sampleCount - 1)];
      const diff = sub(next, prev);
      tangent[i] = lenSq(diff) < 1e-12 ? v(0, 0, 1) : normalizeInPlace(diff);
    }

    this.sampleArcLength = arcLength;
    this.samplePosition = position;
    this.sampleTangent = tangent;
    this.buildFixedZNormals(sampleCount);
    this.buildRmfNormals(sampleCount);
  }

  // 第2軸 = world Z を接線直交面へ投影（接線が Z にほぼ平行なら別軸へフォールバック）。
  private buildFixedZNormals(sampleCount: number): void {
    const out = new Array<Vec3>(sampleCount);
    for (let i = 0; i < sampleCount; i++) out[i] = perpendicularOf(this.sampleTangent[i]);
    this.sampleNormalFixedZ = out;
  }

  // 捩れ最小フレーム: 二重反射法（Wang et al. 2008）を弧長サンプル表に沿って伝播。
  private buildRmfNormals(sampleCount: number): void {
    const rmf = new Array<Vec3>(sampleCount);
    rmf[0] = perpendicularOf(this.sampleTangent[0]);

    for (let i = 0; i + 1 < sampleCount; i++) {
      const p0 = this.samplePosition[i];
      const p1 = this.samplePosition[i + 1];
      const t0 = this.sampleTangent[i];
      const t1 = this.sampleTangent[i + 1];
      const r0 = rmf[i];

      const v1 = sub(p1, p0);
      const c1 = dot(v1, v1);
      let rL: Vec3;
      let tL: Vec3;
      if (c1 < 1e-12) {
        rL = clone(r0);
        tL = clone(t0);
      } else {
        rL = sub(r0, mul(v1, (2 * dot(v1, r0)) / c1));
        tL = sub(t0, mul(v1, (2 * dot(v1, t0)) / c1));
      }

      const v2 = sub(t1, tL);
      const c2 = dot(v2, v2);
      let r1: Vec3 = c2 < 1e-12 ? clone(rL) : sub(rL, mul(v2, (2 * dot(v2, rL)) / c2));
      // t1 に再直交化して正規化（数値ドリフト抑制）。
      r1 = sub(r1, mul(t1, dot(r1, t1)));
      if (lenSq(r1) < 1e-12) r1 = perpendicularOf(t1);
      else normalizeInPlace(r1);
      rmf[i + 1] = r1;
    }
    this.sampleNormalRmf = rmf;
  }
}

// Centripetal Catmull-Rom（Barry-Goldman 混合）。P1-P2 区間を s∈[0,1] で評価。
function catmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, s: number): Vec3 {
  const d0 = Math.max(distance(p1, p0), MIN_CHORD);
  const d1 = Math.max(distance(p2, p1), MIN_CHORD);
  const d2 = Math.max(distance(p3, p2), MIN_CHORD);

  const t0 = 0;
  const t1 = t0 + Math.pow(d0, CATMULL_ROM_ALPHA);
  const t2 = t1 + Math.pow(d1, CATMULL_ROM_ALPHA);
  const t3 = t2 + Math.pow(d2, CATMULL_ROM_ALPHA);

  const t = t1 + s * (t2 - t1);

  const a1 = lerp(p0, p1, (t - t0) / (t1 - t0));
  const a2 = lerp(p1, p2, (t - t1) / (t2 - t1));
  const a3 = lerp(p2, p3, (t - t2) / (t3 - t2));

  const b1 = lerp(a1, a2, (t - t0) / (t2 - t0));
  const b2 = lerp(a2, a3, (t - t1) / (t3 - t1));

  return lerp(b1, b2, (t - t1) / (t2 - t1));
}
