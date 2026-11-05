/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { buildFragmentShader, fnv1a, pixelKindOf, shaderFingerprint, type PixelKind } from "./gpuShader";
import { OP_COUNTS } from "./resamplePlan";

/**
 * 誤差の上界（resamplePlan.ts の OP_COUNTS）はシェーダの式から数えた値。シェーダを変えたのに数え直していないと
 * ここで落ちる（落ちたら gpuShader.ts 冒頭の数え方で OP_COUNTS を見直し、この値を更新する）。
 */
const SHADER_FINGERPRINT = "c1a78a2d";
/** シェーダの式から数えた、補間の演算の連鎖の段数（gpuShader.ts の冒頭）。OP_COUNTS.interp はこれ以上でなければならない。 */
const COUNTED_INTERP_DEPTH = 11;

describe("シェーダ", () => {
  it("要約値が記録と一致する（変えたら OP_COUNTS を数え直して、この値を更新する）", () => {
    expect(shaderFingerprint()).toBe(SHADER_FINGERPRINT);
  });
  it("負例: 1 文字でも変わると要約値が変わる（照合に検出力がある）", () => {
    expect(fnv1a(buildFragmentShader("int16") + " ")).not.toBe(fnv1a(buildFragmentShader("int16")));
    expect(fnv1a(buildFragmentShader("int16", "halfVoxel"))).not.toBe(fnv1a(buildFragmentShader("int16")));
  });
  it("誤差の上界に使う演算数が、数えた段数以上", () => {
    expect(OP_COUNTS.interp).toBeGreaterThanOrEqual(COUNTED_INTERP_DEPTH);
    expect(OP_COUNTS.affine).toBeGreaterThanOrEqual(4); // 3 項の積和 + 係数を float32 にする丸め
  });
  it("保存値の型ごとに、対応するサンプラーを使う。誤りは dev 用の分岐で、誤りなしには入らない", () => {
    const want: Record<PixelKind, string> = { int16: "isampler3D", uint16: "usampler3D", uint8: "usampler3D", float32: "sampler3D" };
    for (const k of Object.keys(want) as PixelKind[]) {
      expect(buildFragmentShader(k)).toContain(`uniform ${want[k]} uVol;`);
    }
    const clean = buildFragmentShader("int16");
    expect(clean).not.toContain("u += 0.5");
    expect(clean).not.toContain("float t = u");
    expect(clean).not.toContain("min(iw + 1");
    expect(buildFragmentShader("int16", "halfVoxel")).toContain("u += 0.5");
    expect(buildFragmentShader("int16", "swapUV")).toContain("float t = u");
    expect(buildFragmentShader("int16", "zOffByOne")).toContain("min(iw + 1");
  });
  it("NaN に頼らず、範囲外は有効フラグ 0 で返す", () => {
    expect(buildFragmentShader("int16")).toContain("outColor = vec4(0.0);");
  });
});

describe("pixelKindOf（保存値の型 → テクスチャの型。扱えない型は null＝CPU）", () => {
  it("対応する型", () => {
    expect(pixelKindOf(new Int16Array(1))).toBe("int16");
    expect(pixelKindOf(new Uint16Array(1))).toBe("uint16");
    expect(pixelKindOf(new Uint8Array(1))).toBe("uint8");
    expect(pixelKindOf(new Float32Array(1))).toBe("float32");
  });
  it("負例: 対応しない型・配列は null", () => {
    expect(pixelKindOf(new Float64Array(1))).toBeNull();
    expect(pixelKindOf(new Int32Array(1))).toBeNull();
    expect(pixelKindOf(new Uint32Array(1))).toBeNull();
    expect(pixelKindOf([1, 2, 3])).toBeNull();
  });
});
