/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * Fusion のリサンプルの GLSL ES 3.00 のシェーダ（文字列の生成だけ。WebGL には触らない）。
 *
 * <p>`fusionEngine.ts` の `computeFusionPixel` と**同じ順序・同じ分岐**で書く:
 * `(bx, by)` → `first·[bx, by, 1]`（局所座標のアフィン。`resamplePlan.ts`）→ (u, v, w_mm) → 面内の境界判定
 * → `wPos` の二分探索 → 端のスライスへのクランプ → スライスごとに「保存値の bilinear × slope + intercept」→ z の線形補間。
 *
 * <p>補間はハードウェアの線形フィルタを使わず `texelFetch` で 4 点（×2 スライス）を読んで計算する（整数テクスチャは
 * フィルタできない・スライスごとの slope を CPU と同じ順序で当てる・誤差の上界を式から書けるようにするため）。
 * 出力は `(値, 有効フラグ)`。GLSL ES 3.00 は NaN の生成・伝播を保証しないので、範囲外は有効フラグ 0 で返し、JS 側で NaN にする。
 *
 * <p>⚠ このファイルのシェーダを変えたら、`OP_COUNTS`（resamplePlan.ts。誤差の上界に使う演算数）を数え直して
 * `SHADER_FINGERPRINT` を更新すること（gpuShader.test.ts が、変えたのに数え直していないと落ちる）。
 *   演算数の数え方（interp）: bilinear は (1−uu)・(1−vv) の引き算 1 段、重み 4 つの積 1 段、保存値との積 1 段、和 3 段
 *   （深さ 6）＋ slope・intercept の 2 段 ＝ 8 段、z の線形補間は (1−wf)・積・和の 3 段 ＝ 計 11 段。FMA で減ることはあっても増えない。
 *   上界に使う `OP_COUNTS.interp = 16` は、この 11 に余裕を持たせた値（座標と wf の丸めは別に δ・γ₃ で数える）。
 */

/** 前景の保存値の型（テクスチャの内部形式を決める）。 */
export type PixelKind = "int16" | "uint16" | "uint8" | "float32";

/** 開発（dev）ビルドでだけ使う、検査用の誤りの注入（シェーダに誤りを入れて、カナリアが落とすことを確かめる）。 */
export type ShaderFault = "halfVoxel" | "swapUV" | "zOffByOne";

const SAMPLER: Record<PixelKind, string> = {
  int16: "isampler3D",
  uint16: "usampler3D",
  uint8: "usampler3D",
  float32: "sampler3D",
};

export const VERTEX_SHADER = `#version 300 es
// 画面いっぱいの 1 枚の三角形（頂点バッファなし）
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export function buildFragmentShader(kind: PixelKind, fault: ShaderFault | null = null): string {
  const sampler = SAMPLER[kind];
  const faultU = fault === "halfVoxel" ? "  u += 0.5; v += 0.5;\n" : fault === "swapUV" ? "  { float t = u; u = v; v = t; }\n" : "";
  const faultZ = fault === "zOffByOne" ? "    iw = min(iw + 1, D - 1);\n" : "";
  return `#version 300 es
precision highp float;
precision highp int;
precision highp isampler3D;
precision highp usampler3D;
precision highp sampler3D;
precision highp sampler2D;

uniform ${sampler} uVol;   // 前景（保存値のまま）。x=列, y=行, z=スライス
uniform sampler2D uParams; // スライスごとに 1 texel: (slope, intercept, wPos, 未使用)
uniform mat3 uA;           // [bx, by, 1] → [u, v, w_mm]（列優先。局所座標。resamplePlan の first）
uniform ivec3 uDims;       // 前景の (列数, 行数, スライス数)
out vec4 outColor;

float pix(int x, int y, int z) {
  return float(texelFetch(uVol, ivec3(x, y, z), 0).r);
}

// 1 スライス内の bilinear（保存値）。範囲外は端の画素へ寄せる（CPU の bilinear と同じ）。
float bil(int z, float u, float v) {
  int W = uDims.x;
  int H = uDims.y;
  float fu = floor(u);
  float fv = floor(v);
  int iu = int(fu);
  int iv = int(fv);
  int iu1 = min(iu + 1, W - 1);
  int iv1 = min(iv + 1, H - 1);
  int iu0 = max(0, iu);
  int iv0 = max(0, iv);
  float uu = clamp(u - fu, 0.0, 1.0);
  float vv = clamp(v - fv, 0.0, 1.0);
  float c00 = pix(iu0, iv0, z);
  float c10 = pix(iu1, iv0, z);
  float c01 = pix(iu0, iv1, z);
  float c11 = pix(iu1, iv1, z);
  return c00 * (1.0 - uu) * (1.0 - vv) + c10 * uu * (1.0 - vv) + c01 * (1.0 - uu) * vv + c11 * uu * vv;
}

vec4 prm(int k) {
  return texelFetch(uParams, ivec2(k, 0), 0);
}

void main() {
  int W = uDims.x;
  int H = uDims.y;
  int D = uDims.z;
  // 出力の格子の画素 (bx, by)。gl_FragCoord は画素の中心（添字 + 0.5）
  vec3 q = uA * vec3(gl_FragCoord.xy - 0.5, 1.0);
  float u = q.x;
  float v = q.y;
  float w = q.z;
${faultU}  if (u < -0.5 || u > float(W) - 0.5 || v < -0.5 || v > float(H) - 0.5) {
    outColor = vec4(0.0);
    return;
  }
  // wPos[iw] <= w < wPos[iw+1] となる最大の iw（境界の外: <0 または >= D-1）。CPU の lowerBound と同じ
  int iw;
  if (w < prm(0).z) {
    iw = -1;
  } else if (w >= prm(D - 1).z) {
    iw = D - 1;
  } else {
    int lo = 0;
    int hi = D - 1;
    for (int it = 0; it < 24; it++) {
      if (lo >= hi - 1) break;
      int mid = (lo + hi) / 2;
      if (prm(mid).z <= w) lo = mid; else hi = mid;
    }
    iw = lo;
${faultZ}  }
  float val;
  if (iw < 0) {
    vec4 s = prm(0);
    val = bil(0, u, v) * s.x + s.y;
  } else if (iw >= D - 1) {
    vec4 s = prm(D - 1);
    val = bil(D - 1, u, v) * s.x + s.y;
  } else {
    vec4 s0 = prm(iw);
    vec4 s1 = prm(iw + 1);
    float dw = s1.z - s0.z;
    float wf = dw > 0.0 ? (w - s0.z) / dw : 0.0;
    float vlo = bil(iw, u, v) * s0.x + s0.y;
    float vhi = bil(iw + 1, u, v) * s1.x + s1.y;
    val = vlo * (1.0 - wf) + vhi * wf;
  }
  outColor = vec4(val, 1.0, 0.0, 0.0);
}
`;
}

/** 文字列の FNV-1a（32 ビット）。シェーダの要約値（SHADER_FINGERPRINT との照合用）。 */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 4 種の保存値の型のシェーダ（誤りなし）をつないだ文字列の要約値。 */
export function shaderFingerprint(): string {
  const kinds: PixelKind[] = ["int16", "uint16", "uint8", "float32"];
  return fnv1a(VERTEX_SHADER + kinds.map((k) => buildFragmentShader(k)).join("\n"));
}

/** 保存値の配列からテクスチャの型を決める。扱えない型（Float64Array・Int32Array など）は null。 */
export function pixelKindOf(pixels: ArrayLike<number>): PixelKind | null {
  if (pixels instanceof Int16Array) return "int16";
  if (pixels instanceof Uint16Array) return "uint16";
  if (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) return "uint8";
  if (pixels instanceof Float32Array) return "float32";
  return null;
}
