/**
 * H41 の中心線・フレーム生成が、参照実装（4D-Flow-PC-MRA の Python）の断面配置と
 * **どれだけ違うか**を実データで測る。
 *
 * <p>🔴 これは「合っていること」を要求するテストではない。
 * 参照実装は FITPACK の平滑化スプライン（`splprep(s = n·smooth_mm²)`）＋
 * 局所 PCA の接線で断面を並べる。H41 は **centripetal Catmull-Rom ＋ 弧長パラメータ化**で、
 * **別のアルゴリズム**。差が出るのは当たり前なので、
 * **どれだけ違うかを数字にして残す**のが目的。
 *
 * <p>参照実装側の断面の位置と法線（`flow_results.json` の `planes[]`）を真値ではなく
 * 「比較対象」として使う。判定は緩い上限だけにしてある。
 *
 * <p>🔴 患者データが要るので CI には乗らない。`PCMRA_GOLDEN_DIR` があるときだけ走る。
 * 症例 ID はコードに書かず、`manifest.json` にあるものを回す。
 *
 * <pre>
 *   PCMRA_GOLDEN_DIR=.../graphy-next-plugin-4dflow/bench/golden \
 *     npx vitest run src/plugins/pluginCenterlineApi.golden.test.ts
 * </pre>
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Vec3 } from "../viewer/reslice";
import { extractCenterline, sampleCenterlineFrames } from "./pluginCenterlineApi";
import type { PluginCenterlineBranch } from "./pluginCenterlineApi";
import type { PluginMaskInput } from "./pluginMeshApi";

const dir = process.env.PCMRA_GOLDEN_DIR ?? "";
const enabled = dir !== "" && existsSync(join(dir, "manifest.json"));

interface ArrayMeta { file: string; dtype: string; shape: number[] }
interface GoldPlane {
  k: number;
  is_center: boolean;
  center_patient: [number, number, number];
  normal: [number, number, number];
}

function readArray(caseId: string, key: string): { data: Uint8Array | Float64Array; shape: number[] } {
  const meta = JSON.parse(readFileSync(join(dir, caseId, "meta.json"), "utf8")) as {
    arrays: Record<string, ArrayMeta>;
  };
  const a = meta.arrays[key];
  const buf = readFileSync(join(dir, caseId, a.file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { data: a.dtype === "uint8" ? new Uint8Array(ab) : new Float64Array(ab), shape: a.shape };
}

function dist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** 2 本の単位ベクトルのなす角 [度]。**向きの反転は同一とみなす**（流量計算で符号がそろえられるため）。 */
function angleDeg(a: readonly number[], b: readonly number[]): number {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
  return (Math.acos(Math.min(1, d)) * 180) / Math.PI;
}

/** 折れ線上で `p` にいちばん近い点までの距離。 */
function distToPolyline(pts: readonly Vec3[], p: readonly number[]): number {
  let best = Infinity;
  for (const q of pts) {
    const d = dist(q, p);
    if (d < best) best = d;
  }
  return best;
}

describe.skipIf(!enabled)("H41 のフレーム vs 参照実装の断面配置（実データ）", () => {
  const manifest = enabled
    ? (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
      cases: Record<string, string[]>;
    })
    : { cases: {} };
  const flow = enabled && existsSync(join(dir, "flow_results.json"))
    ? (JSON.parse(readFileSync(join(dir, "flow_results.json"), "utf8")) as {
      cases: Record<string, { planes: Record<string, GoldPlane[]> }>;
    })
    : null;

  for (const caseId of Object.keys(manifest.cases).sort()) {
    it(`${caseId}: 中心のずれと法線の角度差を測る`, () => {
      expect(flow, "flow_results.json が無い").toBeTruthy();
      const gold = flow!.cases[caseId];
      expect(gold, `flow_results.json に ${caseId} が無い`).toBeTruthy();

      const vessel = readArray(caseId, "vessel_mask");
      const [nz, ny, nx] = vessel.shape;
      const affine = readArray(caseId, "affine").data as Float64Array;

      const mask: PluginMaskInput = {
        data: vessel.data as Uint8Array,
        // golden は C 順 [Z,Y,X]（X が最速）。dims は [nx,ny,nz] で同じメモリ配置
        dims: [nx, ny, nz],
        indexToWorld: Array.from(affine),
      };

      const t0 = Date.now();
      const graph = extractCenterline(mask, {});
      const extractSec = (Date.now() - t0) / 1000;
      expect(graph, "中心線グラフが作れなかった").not.toBeNull();

      const lines: string[] = [
        `\n  ${caseId}  中心線グラフ: 節点 ${graph!.nodes.length} / 枝 ${graph!.branches.length}` +
        `  (${extractSec.toFixed(1)}s)`,
      ];

      for (const [vesselName, planes] of Object.entries(gold.planes)) {
        const center = planes.find((p) => p.is_center) ?? planes[Math.floor(planes.length / 2)];
        const anchor = center.center_patient;

        // 参照実装の断面間隔（実測）。H41 には等間隔を要求するので平均を使う
        const steps: number[] = [];
        for (let k = 1; k < planes.length; k++) {
          steps.push(dist(planes[k].center_patient, planes[k - 1].center_patient));
        }
        const spacingMm = steps.reduce((a, b) => a + b, 0) / steps.length;

        // アンカーにいちばん近い枝を選ぶ（どの枝がどの血管かは本体は知らない）
        let branch: PluginCenterlineBranch | null = null;
        let bestD = Infinity;
        for (const b of graph!.branches) {
          const d = distToPolyline(b.pointsWorld, anchor);
          if (d < bestD) { bestD = d; branch = b; }
        }
        expect(branch, `${vesselName}: 枝が選べなかった`).toBeTruthy();

        const frames = sampleCenterlineFrames(branch!.pointsWorld, {
          spacingMm,
          count: planes.length,
          anchorWorld: anchor as Vec3,
          frameMode: "ROTATION_MINIMIZING",
        });

        // 参照側と向きが逆のこともあるので、両方の並びで見て良いほうを採る
        const score = (rev: boolean): { pos: number[]; ang: number[] } => {
          const pos: number[] = [];
          const ang: number[] = [];
          const m = Math.min(frames.length, planes.length);
          for (let i = 0; i < m; i++) {
            const f = frames[rev ? frames.length - 1 - i : i];
            const g = planes[i];
            pos.push(dist(f.positionWorld, g.center_patient));
            ang.push(angleDeg(f.tangent, g.normal));
          }
          return { pos, ang };
        };
        const a = score(false);
        const b = score(true);
        const meanOf = (v: number[]) => v.reduce((x, y) => x + y, 0) / Math.max(v.length, 1);
        const chosen = meanOf(a.pos) <= meanOf(b.pos) ? a : b;

        lines.push(
          `    ${vesselName.padEnd(6)} 枝 ${branch!.id}（長さ ${branch!.lengthMm.toFixed(1)} mm・` +
          `制御点 ${branch!.pointsWorld.length}）  アンカーまで ${bestD.toFixed(3)} mm\n` +
          `           要求 ${planes.length} 本・間隔 ${spacingMm.toFixed(3)} mm → 返った ${frames.length} 本\n` +
          `           中心のずれ  平均 ${meanOf(chosen.pos).toFixed(3)} / ` +
          `最大 ${Math.max(...chosen.pos).toFixed(3)} mm\n` +
          `           法線の角度差 平均 ${meanOf(chosen.ang).toFixed(2)} / ` +
          `最大 ${Math.max(...chosen.ang).toFixed(2)} 度`,
        );

        // 🔴 ここは「差を測る」テスト。上限は緩く置く。
        // 参照実装と別のアルゴリズムなので、一致を強制するのは目的が違う
        expect(frames.length, `${vesselName}: フレームが 1 本も返らない`).toBeGreaterThan(0);
        expect(meanOf(chosen.pos), `${vesselName}: 中心のずれが大きすぎる`).toBeLessThan(10);
      }

      console.log(lines.join("\n"));
    }, 15 * 60 * 1000);
    it(`${caseId}: 血管マスクを局所に切ってから骨格化すると枝が長くなるか`, () => {
      // 全脳の血管マスクをそのまま骨格化すると、枝が「分岐から分岐までの短い区間」に
      // 砕けてしまう。断面 9 枚（約 10 mm）を並べるには足りない。
      // 参照実装も中心点の周り ±4 点しか使わないので、**アンカーの周りだけ**
      // 切ってから骨格化すれば枝が長くなるはず、という仮説を測る。
      expect(flow, "flow_results.json が無い").toBeTruthy();
      const gold = flow!.cases[caseId];

      const vessel = readArray(caseId, "vessel_mask");
      const [nz, ny, nx] = vessel.shape;
      const affine = readArray(caseId, "affine").data as Float64Array;
      const full = vessel.data as Uint8Array;

      /** index (i,j,k) から患者 LPS mm へ。affine は row-major 4x4。 */
      const toWorld = (i: number, j: number, k: number): [number, number, number] => [
        affine[0] * i + affine[1] * j + affine[2] * k + affine[3],
        affine[4] * i + affine[5] * j + affine[6] * k + affine[7],
        affine[8] * i + affine[9] * j + affine[10] * k + affine[11],
      ];

      const lines: string[] = [`
  ${caseId}  局所クロップの効果`];
      for (const [vesselName, planes] of Object.entries(gold.planes)) {
        const center = planes.find((p) => p.is_center) ?? planes[Math.floor(planes.length / 2)];
        const anchor = center.center_patient;

        for (const radiusMm of [10, 15, 25]) {
          const local = new Uint8Array(full.length);
          let kept = 0;
          for (let k = 0; k < nz; k++) {
            for (let j = 0; j < ny; j++) {
              for (let i = 0; i < nx; i++) {
                const idx = (k * ny + j) * nx + i;
                if (!full[idx]) continue;
                if (dist(toWorld(i, j, k), anchor) <= radiusMm) { local[idx] = 1; kept++; }
              }
            }
          }
          const g = extractCenterline(
            { data: local, dims: [nx, ny, nz], indexToWorld: Array.from(affine) }, {},
          );
          if (!g) { lines.push(`    ${vesselName} r=${radiusMm}mm: 前景なし`); continue; }
          let best: PluginCenterlineBranch | null = null;
          let bestD = Infinity;
          for (const b of g.branches) {
            const d = distToPolyline(b.pointsWorld, anchor);
            if (d < bestD) { bestD = d; best = b; }
          }
          const lens = g.branches.map((b) => b.lengthMm).sort((x, y) => y - x);
          lines.push(
            `    ${vesselName.padEnd(6)} r=${String(radiusMm).padStart(2)}mm  ` +
            `マスク ${kept} 画素 → 枝 ${g.branches.length} 本  ` +
            `最長 ${lens[0]?.toFixed(1)} mm  ` +
            `アンカーの枝 ${best!.lengthMm.toFixed(1)} mm（制御点 ${best!.pointsWorld.length}）`,
          );
        }
      }
      console.log(lines.join("\n"));
    }, 15 * 60 * 1000);

    it(`${caseId}: 実運用の形（局所クロップ＋簡略化なし＋枝刈り）で差を測る`, () => {
      // 上の 2 つで分かったことを組み合わせる:
      //   - 全脳マスクをそのまま骨格化すると枝が短く砕ける → アンカーの周りだけ切る
      //   - simplifyEpsilonMm の既定 0.5 mm で制御点が間引かれる → 0 にして生の骨格を使う
      //   - 骨格は表面のこぶから短いひげを生やす → pruneMinLengthMm で落とす
      expect(flow, "flow_results.json が無い").toBeTruthy();
      const gold = flow!.cases[caseId];

      const vessel = readArray(caseId, "vessel_mask");
      const [nz, ny, nx] = vessel.shape;
      const affine = readArray(caseId, "affine").data as Float64Array;
      const full = vessel.data as Uint8Array;
      const toWorld = (i: number, j: number, k: number): [number, number, number] => [
        affine[0] * i + affine[1] * j + affine[2] * k + affine[3],
        affine[4] * i + affine[5] * j + affine[6] * k + affine[7],
        affine[8] * i + affine[9] * j + affine[10] * k + affine[11],
      ];

      const out: string[] = [`\n  ${caseId}  実運用の形`];
      for (const [vesselName, planes] of Object.entries(gold.planes)) {
        const center = planes.find((p) => p.is_center) ?? planes[Math.floor(planes.length / 2)];
        const anchor = center.center_patient;
        const steps: number[] = [];
        for (let k = 1; k < planes.length; k++) {
          steps.push(dist(planes[k].center_patient, planes[k - 1].center_patient));
        }
        const spacingMm = steps.reduce((a, b) => a + b, 0) / steps.length;

        const local = new Uint8Array(full.length);
        for (let k = 0; k < nz; k++) {
          for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
              const idx = (k * ny + j) * nx + i;
              if (full[idx] && dist(toWorld(i, j, k), anchor) <= 15) local[idx] = 1;
            }
          }
        }

        for (const [eps, prune] of [[0.5, 0], [0, 0], [0, 2]] as const) {
          const g = extractCenterline(
            { data: local, dims: [nx, ny, nz], indexToWorld: Array.from(affine) },
            { simplifyEpsilonMm: eps, pruneMinLengthMm: prune },
          );
          if (!g) { out.push(`    ${vesselName} eps=${eps} prune=${prune}: 前景なし`); continue; }
          let branch: PluginCenterlineBranch | null = null;
          let bestD = Infinity;
          for (const b of g.branches) {
            const d = distToPolyline(b.pointsWorld, anchor);
            if (d < bestD) { bestD = d; branch = b; }
          }
          const frames = sampleCenterlineFrames(branch!.pointsWorld, {
            spacingMm, count: planes.length,
            anchorWorld: anchor as Vec3, frameMode: "ROTATION_MINIMIZING",
          });
          const score = (rev: boolean) => {
            const pos: number[] = [];
            const ang: number[] = [];
            const m = Math.min(frames.length, planes.length);
            for (let i = 0; i < m; i++) {
              const f = frames[rev ? frames.length - 1 - i : i];
              pos.push(dist(f.positionWorld, planes[i].center_patient));
              ang.push(angleDeg(f.tangent, planes[i].normal));
            }
            return { pos, ang };
          };
          const meanOf = (v: number[]) =>
            v.length === 0 ? NaN : v.reduce((x, y) => x + y, 0) / v.length;
          const a = score(false);
          const b = score(true);
          const ch = meanOf(a.pos) <= meanOf(b.pos) ? a : b;
          out.push(
            `    ${vesselName.padEnd(6)} eps=${eps} prune=${prune}  ` +
            `枝 ${g.branches.length} 本・採用枝 ${branch!.lengthMm.toFixed(1)} mm` +
            `（制御点 ${branch!.pointsWorld.length}）  ` +
            `${frames.length}/${planes.length} 本  ` +
            `ずれ 平均 ${meanOf(ch.pos).toFixed(3)} 最大 ${Math.max(...ch.pos).toFixed(3)} mm  ` +
            `角度 平均 ${meanOf(ch.ang).toFixed(2)} 最大 ${Math.max(...ch.ang).toFixed(2)} 度`,
          );
        }
      }
      console.log(out.join("\n"));
    }, 15 * 60 * 1000);
  }
});
