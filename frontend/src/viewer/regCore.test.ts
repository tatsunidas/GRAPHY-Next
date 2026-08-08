/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * `regCore.ts` のテスト。
 *
 * <p>合成ボリュームで「既知のズレを入れて、それを取り戻せるか」を見る。
 * 実データ相当の検証は `bench/` の GNBP-2R（真値つき）で行う — こちらは
 * **ブラウザも DICOM も無しで回る速い網**であり、向き・決定性・中止のような
 * 壊れ方の分かりやすい性質を固定するためのもの。
 */
import { describe, it, expect } from "vitest";
import { makeVolume, sampleWorld, type RegVolume } from "./regGeometry";
import { registerRigid } from "./regCore";
import type { Vec3 } from "./regTransform";

/**
 * 合成ボリューム（等方 2mm・64mm 立方）。
 *
 * <p>設計上、この 2 点がどちらも必要だった。両方とも一度ずつ実際に踏んでいる:
 *
 * <ol>
 *   <li><b>外形を異方な楕円体にする</b>。最初は球殻＋小さな結節で書いたが、
 *       支配的な構造が回転対称だと 8° 回しても内容が 0.1% しか変わらず、
 *       「回転を推定できるか」を確かめられなかった。</li>
 *   <li><b>スーパーサンプリングで部分体積を作る</b>。境界を 2mm 格子へ二値で
 *       焼き込むと、8° 回した内容のラスタは「ラスタを 8° 回したもの」と一致せず、
 *       <b>データ上の真値が 7.5° になる</b>（全ボクセルで指標を測って確認した）。
 *       エイリアスした真値に対して最適化の精度を語っても意味がない。
 *       GNBP-2R が `SUPERSAMPLE` を入れているのと同じ理由。</li>
 * </ol>
 */
function phantom(shift: Vec3 = [0, 0, 0], rotDeg = 0): RegVolume {
  const n = 32;
  const spacing = 2;
  const ss = 3; // 軸あたりの副標本数（27 点/ボクセル）
  const data = new Float32Array(n * n * n);
  const half = ((n - 1) / 2) * spacing;

  const c = Math.cos((rotDeg * Math.PI) / 180);
  const s = Math.sin((rotDeg * Math.PI) / 180);
  const offs: number[] = [];
  for (let t = 0; t < ss; t++) offs.push(((t - (ss - 1) / 2) / ss) * spacing);

  const valueAt = (wx: number, wy: number, wz: number): number => {
    // 「動かした」ボリュームを作るので、内容は逆変換した位置で評価する
    const ux = wx - shift[0], uy = wy - shift[1], uz = wz - shift[2];
    const x = c * ux + s * uy;
    const y = -s * ux + c * uy;
    const z = uz;

    const e = (x / 30) ** 2 + (y / 20) ** 2 + (z / 24) ** 2;
    let v = -1000;                                        // 空気
    if (e < 1) v = 40;                                    // 実質
    if (e > 0.72 && e < 1) v = 900;                       // 殻（高吸収・異方）
    if (Math.hypot(x - 12, y - 5, z + 8) < 6) v = 300;    // 非対称な結節 1
    if (Math.hypot(x + 10, y + 11, z - 9) < 5) v = 600;   // 非対称な結節 2
    return v;
  };

  let o = 0;
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (const oz of offs) {
          for (const oy of offs) {
            for (const ox of offs) {
              acc += valueAt(-half + i * spacing + ox, -half + j * spacing + oy, -half + k * spacing + oz);
            }
          }
        }
        data[o++] = acc / (ss * ss * ss);
      }
    }
  }
  const ipp0: Vec3 = [-half, -half, -half];
  return makeVolume(data, [n, n, n], [1, 0, 0, 0, 1, 0], ipp0, spacing, spacing, [0, 0, spacing]);
}

/** 精度を見るテストは既定どおり 3 段（最細 2mm ＝ ファントムの原寸）。 */
const PYR_FULL = [8, 4, 2] as const;
/** 契約（決定性・中止・範囲制限）だけを見るテストは粗い 2 段で足りる（速さのため）。 */
const PYR = [8, 4] as const;

describe("regCore — 既知のズレを取り戻せる", () => {
  it("平行移動を推定する", () => {
    const fixed = phantom();
    const moving = phantom([6, -4, 5]);
    const r = registerRigid(fixed, moving, {
      metric: "ncc",
      sameFrameOfReference: true,
      pyramidMm: PYR_FULL,
      samplesPerIteration: 1500,
      maxIterationsPerLevel: 60,
    });
    const t = r.parameters.translationMm;
    expect(t[0]).toBeCloseTo(6, 0);
    expect(t[1]).toBeCloseTo(-4, 0);
    expect(t[2]).toBeCloseTo(5, 0);
  });

  it("回転を推定する", () => {
    const fixed = phantom();
    const moving = phantom([0, 0, 0], 8);
    const r = registerRigid(fixed, moving, {
      metric: "ncc",
      sameFrameOfReference: true,
      pyramidMm: PYR_FULL,
      samplesPerIteration: 1500,
      maxIterationsPerLevel: 60,
    });
    // 生成側は world +z まわりに rotDeg 回した内容 → 推定は rz ≈ 8 度
    expect(r.parameters.eulerDeg[2]).toBeCloseTo(8, 0);
  });

  it("★推定した変換で moving を引くと fixed に一致する（向きの確認）", () => {
    const fixed = phantom();
    const moving = phantom([6, -4, 5]);
    const r = registerRigid(fixed, moving, {
      metric: "ncc",
      sameFrameOfReference: true,
      pyramidMm: PYR_FULL,
      samplesPerIteration: 1500,
      maxIterationsPerLevel: 60,
    });
    // fixed の特徴点（結節 1 の中心 world (10,4,-6)）で、変換先の moving の値が
    // fixed と同じになるはず。向きを取り違えていると別の値になる。
    const out: Vec3 = [0, 0, 0];
    r.transform.mapPoint(10, 4, -6, out);
    const vFixed = sampleWorld(fixed, 10, 4, -6);
    const vMoved = sampleWorld(moving, out[0], out[1], out[2]);
    expect(vFixed).toBe(300);
    expect(vMoved).toBeCloseTo(300, -1);
  });
});

describe("regCore — 契約", () => {
  it("同じシードなら同じ結果（決定的）", () => {
    const fixed = phantom();
    const moving = phantom([3, 3, -3]);
    const opts = {
      metric: "ncc" as const,
      sameFrameOfReference: true,
      pyramidMm: PYR,
      samplesPerIteration: 800,
      maxIterationsPerLevel: 20,
      seed: 12345,
    };
    const a = registerRigid(fixed, moving, opts);
    const b = registerRigid(fixed, moving, opts);
    expect(a.parameters).toEqual(b.parameters);
    expect(a.metricValue).toBe(b.metricValue);
  });

  it("シードが違えば（わずかに）違う結果になりうる — 確率的であることの確認", () => {
    const fixed = phantom();
    const moving = phantom([3, 3, -3]);
    const base = { metric: "ncc" as const, sameFrameOfReference: true, pyramidMm: PYR,
      samplesPerIteration: 400, maxIterationsPerLevel: 12 };
    const a = registerRigid(fixed, moving, { ...base, seed: 1 });
    const b = registerRigid(fixed, moving, { ...base, seed: 2 });
    // 同じ真値に向かうので近いが、同一である必要はない。
    expect(Math.abs(a.parameters.translationMm[0] - b.parameters.translationMm[0])).toBeLessThan(3);
  });

  it("FoR 一致なら探索範囲が ±30mm / ±10° に制限される", () => {
    const fixed = phantom();
    // 探索範囲より大きくずらす（実データではありえない量）
    const moving = phantom([50, 0, 0]);
    const r = registerRigid(fixed, moving, {
      metric: "ncc",
      sameFrameOfReference: true,
      pyramidMm: PYR,
      samplesPerIteration: 800,
      maxIterationsPerLevel: 30,
    });
    expect(Math.abs(r.parameters.translationMm[0])).toBeLessThanOrEqual(30 + 1e-9);
    expect(r.initialization).toBe("identity-same-for");
  });

  it("FoR 不一致なら重心合わせから始まる", () => {
    const fixed = phantom();
    const moving = phantom([40, 0, 0]);
    const r = registerRigid(fixed, moving, {
      metric: "ncc",
      sameFrameOfReference: false,
      pyramidMm: PYR,
      samplesPerIteration: 800,
      maxIterationsPerLevel: 30,
    });
    expect(r.initialization).toBe("centroid");
    // 重心合わせだけで大半が取れているはず
    expect(r.parameters.translationMm[0]).toBeGreaterThan(30);
  });

  it("中止要求で止まり、その時点の結果を返す", () => {
    const fixed = phantom();
    const moving = phantom([5, 0, 0]);
    let calls = 0;
    const r = registerRigid(fixed, moving, {
      metric: "ncc",
      sameFrameOfReference: true,
      pyramidMm: PYR,
      samplesPerIteration: 400,
      maxIterationsPerLevel: 50,
      shouldAbort: () => ++calls > 5,
    });
    expect(r.aborted).toBe(true);
    expect(r.levels.length).toBeGreaterThan(0);
  });

  it("進捗が 0..1 で単調に増える", () => {
    const fixed = phantom();
    const moving = phantom([2, 2, 2]);
    const seen: number[] = [];
    registerRigid(fixed, moving, {
      metric: "ncc",
      sameFrameOfReference: true,
      pyramidMm: PYR,
      samplesPerIteration: 400,
      maxIterationsPerLevel: 10,
      onProgress: (p) => seen.push(p.fraction),
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const v of seen) { expect(v).toBeGreaterThan(0); expect(v).toBeLessThanOrEqual(1); }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });
});
