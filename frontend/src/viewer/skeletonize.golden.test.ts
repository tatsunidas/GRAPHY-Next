/**
 * 本体の 3D 細線化（Lee-Kashyap-Chu 1994）が、**scikit-image の `skeletonize`（3D）と
 * 同じ答えを出すか**を実データで測る。
 *
 * <p>`skeletonize.ts` の冒頭は Fiji Skeletonize3D との数値一致を根拠にしているが、
 * **scikit-image との一致は誰も測っていない**。H41（`extractCenterline`）を
 * 使うプラグインは、参照実装が scikit-image で出した中心線と自分の結果を
 * 比べることになるので、ここが H41 の契約そのものになる。
 *
 * <p>🔴 **患者データが要るテスト**なので、CI には乗らない。
 * 環境変数 `PCMRA_GOLDEN_DIR` が指す場所に golden があるときだけ走る。
 * 症例 ID はここに書かない（`manifest.json` にあるものを全部回す）。
 *
 * <pre>
 *   PCMRA_GOLDEN_DIR=C:/Users/t_kob/graphy-workspace/graphy-next-plugin-4dflow/bench/golden \
 *     npx vitest run src/viewer/skeletonize.golden.test.ts
 * </pre>
 *
 * <p>golden の作り方はプラグイン側 `bench/export_golden.py` を参照。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { LabelVolume, VolumeGeom } from "./labelVolume";
import { skeletonizeLabelVolume } from "./skeletonize";

interface ArrayMeta {
  file: string;
  dtype: string;
  shape: number[];
  order: string;
}
interface CaseMeta {
  arrays: Record<string, ArrayMeta>;
}

const dir = process.env.PCMRA_GOLDEN_DIR ?? "";
const enabled = dir !== "" && existsSync(join(dir, "manifest.json"));

function cases(): string[] {
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    cases: Record<string, string[]>;
  };
  return Object.keys(m.cases)
    .filter((c) => m.cases[c].includes("vessel_mask") && m.cases[c].includes("centerline_mask"))
    .sort();
}

function readMask(caseId: string, key: string): { data: Uint8Array; shape: number[] } {
  const meta = JSON.parse(readFileSync(join(dir, caseId, "meta.json"), "utf8")) as CaseMeta;
  const a = meta.arrays[key];
  const buf = readFileSync(join(dir, caseId, a.file));
  // Buffer はプールから切り出されるので、必ずコピーしてから TypedArray にする
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { data: new Uint8Array(ab), shape: a.shape };
}

function dice(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let inter = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ? 1 : 0;
    const y = b[i] ? 1 : 0;
    na += x;
    nb += y;
    inter += x & y;
  }
  return na + nb === 0 ? 1 : (2 * inter) / (na + nb);
}

describe.skipIf(!enabled)("skeletonizeLabelVolume × scikit-image（実データ）", () => {
  for (const caseId of enabled ? cases() : []) {
    for (const margin of [0, 2]) {
      it(`${caseId}: margin=${margin} で scikit-image の骨格と比べる`, () => {
        // golden は C 順 [Z, Y, X]（X が最速）。VolumeGeom の dims は [nx, ny, nz] で
        // 同じく x が最速なので、**メモリ配置は同じ**。並べ方を逆にするだけでよい
        const vessel = readMask(caseId, "vessel_mask");
        const [nz, ny, nx] = vessel.shape;

        // Dice はボクセル同士の比較なので、実寸は要らない。index = mm の格子にする
        const geom: VolumeGeom = {
          dims: [nx, ny, nz],
          spacing: [1, 1, 1],
          origin: [0, 0, 0],
          direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        };
        const lv: LabelVolume = { geom, data: vessel.data, voxelMm3: 1 };

        const skel = skeletonizeLabelVolume(lv, margin);
        expect(skel, "前景があるのに null が返った").not.toBeNull();

        // クロップされて返るので、元の格子へ戻す（origin が bbox 先頭ボクセル）
        const full = new Uint8Array(nx * ny * nz);
        const [cw, ch, cd] = skel!.geom.dims;
        const [ox, oy, oz] = skel!.geom.origin.map(Math.round);
        for (let k = 0; k < cd; k++) {
          for (let j = 0; j < ch; j++) {
            const src = k * cw * ch + j * cw;
            const dst = (k + oz) * nx * ny + (j + oy) * nx + ox;
            for (let i = 0; i < cw; i++) full[dst + i] = skel!.data[src + i];
          }
        }

        const gold = readMask(caseId, "centerline_mask");
        const d = dice(full, gold.data);

        let nTs = 0;
        for (const v of full) nTs += v ? 1 : 0;
        let nGold = 0;
        for (const v of gold.data) nGold += v ? 1 : 0;

        // z ごとの差の分布（差が偏っているかを見る）
        const perZ: number[] = [];
        for (let k = 0; k < nz; k++) {
          let diff = 0;
          for (let i = 0; i < nx * ny; i++) {
            const p = k * nx * ny + i;
            if ((full[p] ? 1 : 0) !== (gold.data[p] ? 1 : 0)) diff += 1;
          }
          perZ.push(diff);
        }
        const worstZ = perZ.indexOf(Math.max(...perZ));

        console.log(
          `\n  ${caseId} margin=${margin}\n` +
          `    Dice ${d.toFixed(6)}   本体 ${nTs} / scikit-image ${nGold} ボクセル\n` +
          `    差の総数 ${perZ.reduce((a, b) => a + b, 0)}` +
          `（最大は z=${worstZ} の ${perZ[worstZ]} ボクセル）`,
        );

        // 🔴 下限は緩くしてある。上位計画は「差が出る前提で実測する」であって、
        // 0.99 を強制して赤にするのは目的が違う。数値はマニュアルへ転記して判断材料にする
        expect(d, `Dice ${d.toFixed(6)}`).toBeGreaterThan(0.9);
      }, 10 * 60 * 1000);
    }
  }
});
