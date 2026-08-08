/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * レジストレーションの変換モデル（設計: `fw/registration-design.md` §4.1）。
 *
 * <p>本ファイルは**純関数のみ**で構成し、DOM も cornerstone も import しない
 * （`levelSetsCore.ts` と同じ方針。node 環境の vitest からブラウザ無しでテストできる状態を保つ）。
 *
 * <h3>座標系と変換の向き ★ここを間違えると全部おかしくなる</h3>
 * <ul>
 *   <li>座標はすべて<b>患者 LPS mm</b>（`fw/cornerstone-3d-geometry-caveat.md` の方針どおり、
 *       確定計算は自前の単一幾何で完結させる）。X=左, Y=後, Z=頭側。</li>
 *   <li>{@link WorldTransform#mapPoint} の向きは <b>fixed(背景) world → moving(前景) world</b>
 *       （pull-back）。「moving をこう動かす」というユーザーの直感の<b>逆</b>である。</li>
 * </ul>
 *
 * <p>なぜ pull-back なのか: リサンプルは「fixed の格子を走査し、対応する moving の値を引いてくる」
 * という形でしか書けない（push-forward にすると出力に穴が空いて穴埋めが要る）。
 * {@link ../viewer/fusionEngine} の `computeFusionSlice` も元々この形なので、
 * 変換を 1 つ挟むだけで位置合わせに対応できる。
 *
 * <p>R1 の範囲は恒等・線形（剛体/相似/アフィン）・合成まで。
 * 変位場（DVF）・B-spline・定常速度場（SVF）は R4 で本ファイルに追加する。
 */

/** 患者 LPS mm の 3 次元点／ベクトル。 */
export type Vec3 = [number, number, number];

/** 変換の種別。R4 で "dvf" / "bspline" / "svf" が加わる。 */
export type TransformKind = "identity" | "linear" | "composite";

/**
 * fixed world → moving world の写像。すべての変換種はこれを実装する。
 *
 * <p>{@link mapPoint} はリサンプルのホットループから**毎ボクセル**呼ばれる。
 * 割り付けを避けるため戻り値ではなく `out` に書く契約にしてある。
 */
export interface WorldTransform {
  readonly kind: TransformKind;
  /** (x,y,z) を写して `out` に書く。`out` は呼び出し側が使い回す。 */
  mapPoint(x: number, y: number, z: number, out: Vec3): void;
}

/** 剛体・相似・アフィン。4×4 同次行列（row-major, 最終行 [0,0,0,1]）。 */
export interface LinearTransform extends WorldTransform {
  readonly kind: "linear";
  /** length 16、row-major。fixed world → moving world。 */
  readonly matrix: Float64Array;
  /** 自由度（表示・記録用。行列そのものには影響しない）。 */
  readonly dof: 6 | 7 | 9 | 12;
  /** 回転中心（world）。UI の数値表示はこの点まわりの量として解釈する。 */
  readonly center: Vec3;
}

/** 合成。`chain` の**先頭から順に**適用する（fixed 側から moving 側へ向かう順）。 */
export interface CompositeTransform extends WorldTransform {
  readonly kind: "composite";
  readonly chain: readonly WorldTransform[];
}

/** 手動微調整の 6 パラメータ。UI が持つのはこれだけ（幾何は計算層に閉じる）。 */
export interface ManualAdjust {
  /** moving を動かす平行移動 [mm]（患者 LPS）。 */
  tx: number;
  ty: number;
  tz: number;
  /** moving を回す回転 [度]（患者 LPS の各軸まわり）。 */
  rx: number;
  ry: number;
  rz: number;
}

/** 何も動かさない手動微調整。 */
export const ZERO_ADJUST: Readonly<ManualAdjust> = Object.freeze({
  tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0,
});

/** 手動微調整が実質ゼロか（全成分が 0）。 */
export function isZeroAdjust(a: ManualAdjust | null | undefined): boolean {
  if (!a) return true;
  return a.tx === 0 && a.ty === 0 && a.tz === 0 && a.rx === 0 && a.ry === 0 && a.rz === 0;
}

// ── 4×4 行列ユーティリティ（row-major） ──────────────────────────

/** 単位行列。 */
export function mat4Identity(): Float64Array {
  const m = new Float64Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  return m;
}

/** 行列積 a·b（どちらも row-major 4×4）。 */
export function mat4Multiply(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
      out[r * 4 + c] = s;
    }
  }
  return out;
}

/**
 * アフィン行列（最終行 [0,0,0,1]）の逆行列。
 *
 * <p>左上 3×3 を余因子で反転し、平行移動は `-R⁻¹t` で求める。
 * 特異（|det| が極小）なら `null` を返す — **例外にしない**のは、
 * 呼び出し側（プレビュー）が黙って恒等に落ちて描画を続けられるようにするため。
 */
export function mat4InvertAffine(m: Float64Array): Float64Array | null {
  const a = m[0], b = m[1], c = m[2];
  const d = m[4], e = m[5], f = m[6];
  const g = m[8], h = m[9], i = m[10];

  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;

  const r00 = A * inv;
  const r01 = -(b * i - c * h) * inv;
  const r02 = (b * f - c * e) * inv;
  const r10 = B * inv;
  const r11 = (a * i - c * g) * inv;
  const r12 = -(a * f - c * d) * inv;
  const r20 = C * inv;
  const r21 = -(a * h - b * g) * inv;
  const r22 = (a * e - b * d) * inv;

  const tx = m[3], ty = m[7], tz = m[11];
  const out = new Float64Array(16);
  out[0] = r00; out[1] = r01; out[2] = r02; out[3] = -(r00 * tx + r01 * ty + r02 * tz);
  out[4] = r10; out[5] = r11; out[6] = r12; out[7] = -(r10 * tx + r11 * ty + r12 * tz);
  out[8] = r20; out[9] = r21; out[10] = r22; out[11] = -(r20 * tx + r21 * ty + r22 * tz);
  out[15] = 1;
  return out;
}

/**
 * オイラー角から回転行列を作る。
 *
 * <p><b>規約</b>: `R = Rz(rz) · Ry(ry) · Rx(rx)`（＝ X 軸まわりを最初に適用）。
 * 角度は**度**、患者 LPS の各軸まわりの右手系。
 * 規約は一度決めたら変えないこと（記録した数値の意味が変わる）。
 */
export function mat4FromEulerDeg(rxDeg: number, ryDeg: number, rzDeg: number): Float64Array {
  const toRad = Math.PI / 180;
  const cx = Math.cos(rxDeg * toRad), sx = Math.sin(rxDeg * toRad);
  const cy = Math.cos(ryDeg * toRad), sy = Math.sin(ryDeg * toRad);
  const cz = Math.cos(rzDeg * toRad), sz = Math.sin(rzDeg * toRad);

  const m = mat4Identity();
  // Rz·Ry·Rx を展開したもの。
  m[0] = cz * cy;
  m[1] = cz * sy * sx - sz * cx;
  m[2] = cz * sy * cx + sz * sx;
  m[4] = sz * cy;
  m[5] = sz * sy * sx + cz * cx;
  m[6] = sz * sy * cx - cz * sx;
  m[8] = -sy;
  m[9] = cy * sx;
  m[10] = cy * cx;
  return m;
}

// ── 変換の生成 ────────────────────────────────────────────────

const IDENTITY_TRANSFORM: WorldTransform = {
  kind: "identity",
  mapPoint(x, y, z, out) { out[0] = x; out[1] = y; out[2] = z; },
};

/** 恒等変換（シングルトン）。 */
export function identityTransform(): WorldTransform {
  return IDENTITY_TRANSFORM;
}

/** 4×4 行列（fixed→moving）から線形変換を作る。 */
export function linearTransform(
  matrix: Float64Array,
  opts?: { dof?: 6 | 7 | 9 | 12; center?: Vec3 },
): LinearTransform {
  const m = matrix;
  return {
    kind: "linear",
    matrix: m,
    dof: opts?.dof ?? 12,
    center: opts?.center ?? [0, 0, 0],
    mapPoint(x, y, z, out) {
      out[0] = m[0] * x + m[1] * y + m[2] * z + m[3];
      out[1] = m[4] * x + m[5] * y + m[6] * z + m[7];
      out[2] = m[8] * x + m[9] * y + m[10] * z + m[11];
    },
  };
}

/**
 * 手動微調整（moving をどう動かすか）から **fixed→moving の pull-back 変換**を作る。
 *
 * <p>ユーザーの意図は「moving を center まわりに R だけ回し、t だけ平行移動する」:
 * <pre>P_new = C + R·(P_old − C) + t</pre>
 * リサンプルに必要なのはその逆写像なので
 * <pre>P_old = C + R⁻¹·(P_new − C − t)</pre>
 * を返す（R は正規直交なので R⁻¹ = Rᵀ だが、ここでは一般の逆行列で組んで
 * 将来スケール付きに拡張しても壊れないようにしてある）。
 *
 * @param adjust 手動微調整。null / 全ゼロなら恒等変換を返す（`===` で恒等判定できる）。
 * @param center 回転中心（world）。通常は moving ボリュームの中心。
 */
export function manualAdjustToTransform(
  adjust: ManualAdjust | null | undefined,
  center: Vec3,
): WorldTransform {
  if (isZeroAdjust(adjust)) return IDENTITY_TRANSFORM;
  const a = adjust!;

  const R = mat4FromEulerDeg(a.rx, a.ry, a.rz);
  // forward = T(C) · T(t) · R · T(−C)
  const forward = mat4Identity();
  // 回転部
  forward[0] = R[0]; forward[1] = R[1]; forward[2] = R[2];
  forward[4] = R[4]; forward[5] = R[5]; forward[6] = R[6];
  forward[8] = R[8]; forward[9] = R[9]; forward[10] = R[10];
  // 平行移動部: C + t − R·C
  const cx = center[0], cy = center[1], cz = center[2];
  forward[3] = cx + a.tx - (R[0] * cx + R[1] * cy + R[2] * cz);
  forward[7] = cy + a.ty - (R[4] * cx + R[5] * cy + R[6] * cz);
  forward[11] = cz + a.tz - (R[8] * cx + R[9] * cy + R[10] * cz);

  const inv = mat4InvertAffine(forward);
  // 回転行列は常に可逆なので通常ここには来ない。来たら恒等に落として描画を止めない。
  if (!inv) return IDENTITY_TRANSFORM;
  return linearTransform(inv, { dof: 6, center });
}

/**
 * 複数の変換を合成する。適用順は**配列順**（fixed 側から moving 側へ）。
 *
 * <p>恒等は取り除き、残りが 0 個なら恒等、1 個ならそれ自身を返す
 * （無駄な間接呼び出しをホットループに残さないため）。
 * 線形どうしが連続する場合は行列を畳んで 1 つにする。
 */
export function composeTransforms(...parts: (WorldTransform | null | undefined)[]): WorldTransform {
  const flat: WorldTransform[] = [];
  const push = (t: WorldTransform) => {
    if (t.kind === "identity") return;
    if (t.kind === "composite") {
      for (const c of (t as CompositeTransform).chain) push(c);
      return;
    }
    const prev = flat[flat.length - 1];
    if (prev && prev.kind === "linear" && t.kind === "linear") {
      // fixed→A→moving と fixed→B→moving を「A のあと B」に畳む = B·A。
      const a = prev as LinearTransform;
      const b = t as LinearTransform;
      flat[flat.length - 1] = linearTransform(mat4Multiply(b.matrix, a.matrix), {
        dof: Math.max(a.dof, b.dof) as 6 | 7 | 9 | 12,
        center: a.center,
      });
      return;
    }
    flat.push(t);
  };
  for (const p of parts) if (p) push(p);

  if (flat.length === 0) return IDENTITY_TRANSFORM;
  if (flat.length === 1) return flat[0];

  const chain = flat.slice();
  const tmp: Vec3 = [0, 0, 0];
  return {
    kind: "composite",
    chain,
    mapPoint(x, y, z, out) {
      tmp[0] = x; tmp[1] = y; tmp[2] = z;
      for (let i = 0; i < chain.length; i++) {
        chain[i].mapPoint(tmp[0], tmp[1], tmp[2], tmp);
      }
      out[0] = tmp[0]; out[1] = tmp[1]; out[2] = tmp[2];
    },
  } as CompositeTransform;
}

/** 恒等変換か（`computeFusionSlice` を素通りさせてよいかの判定）。 */
export function isIdentityTransform(t: WorldTransform | null | undefined): boolean {
  return !t || t.kind === "identity";
}

/**
 * 変換を 1 点に適用して新しい配列で返す（テスト・単発計算用の便宜関数）。
 * ホットループでは使わないこと（毎回割り付けるため）。
 */
export function applyTransform(t: WorldTransform, p: Vec3): Vec3 {
  const out: Vec3 = [0, 0, 0];
  t.mapPoint(p[0], p[1], p[2], out);
  return out;
}
