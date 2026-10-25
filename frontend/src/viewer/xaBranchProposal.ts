/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 利用者が引いた**主枝の中心線**から、側枝の候補を提案する純関数（GN-XA-001 P2.5c）。
 *
 * <p>画像全体にしきい値を掛ける方式（P2.5a）は、雑音が小さいほど悪化して不合格だった
 * （`fw/xa-confirm-ui-design.md` §14）。ここでは**主枝自身のコントラストを基準**にする（自己正規化）ので、
 * 雑音の大小に依存しない。流れ: 主枝の局所径・コントラストを測る → 主枝を囲む円周で、主枝コントラストの
 * 一定割合以上の山を側枝の候補とする → 候補ごとに脊線を追う → 主枝への再合流・重複を除く。
 * **候補を出すだけで、採否は人が決める。**
 *
 * <h3>固定した定数（測定の前に決めたもの）</h3>
 * <ul>
 *   <li>{@link CONTRAST_FRACTION}: 主枝の 25% 未満のコントラストの線は側枝としない。暫定の運用基準で、
 *       動かして結果が変わらない範囲をテストで示す。最大化では選ばない。</li>
 *   <li>円周の半径は主枝の径の 1.5 倍（主枝の縁から径 1 本ぶん外）。主枝を除く角度は、中心線から径 1 本ぶん以内
 *       （asin(d/R)）。</li>
 *   <li>径の範囲は冠動脈の生理的範囲 {@link VESSEL_DIAMETER_RANGE_MM}。</li>
 * </ul>
 * 画素間隔が無ければ提案しない。カテーテル・ワイヤ・骨は区別しない（実画像は未検証）。
 */
import { findEdgesInProfile, sampleBilinear, smoothPath } from "./qca";

export const VESSEL_DIAMETER_RANGE_MM: readonly [number, number] = [1.0, 5.0];
/** 側枝として採る最小コントラスト（主枝のコントラストに対する割合）。暫定。 */
export const CONTRAST_FRACTION = 0.25;

const RING_RADIUS_PER_DIAMETER = 1.5;
/** 主枝の径・コントラストを平らにする窓 [mm]（主枝の径の変化より十分長く、局所の分岐の影響を薄める）。 */
const MAIN_MEDIAN_WINDOW_MM = 5;
/** 円周を調べる主枝上の間隔 [mm]。 */
const RING_STRIDE_MM = 0.5;
/** 追跡 1 歩あたりの方向の振れ幅 [rad]（±30°）と刻み。 */
const TURN_MAX = Math.PI / 6;
const TURN_STEPS = 3;

export type BranchStopReason = "faded" | "noEdge" | "diameterRange" | "border" | "maxLength";

export interface BranchProposal {
  /** 主枝に近い側から先へ。画像 px。 */
  pointsPx: [number, number][];
  /** 分岐点に最も近い主枝上の点の添字。 */
  originMainIndex: number;
  lengthMm: number;
  /** 追跡した区間の径の中央値 [mm]。 */
  diameterMm: number;
  /** 起点でのコントラスト / 主枝のコントラスト。 */
  contrastRatio: number;
  stopReason: BranchStopReason;
}

export type BranchProposalStatus = "ok" | "noScale" | "badMain";

export interface XaBranchProposals {
  status: BranchProposalStatus;
  proposals: BranchProposal[];
  warnings: string[];
}

export interface XaBranchProposalOptions {
  vesselIsDark: boolean;
  /** 患者面の画素間隔 [mm/px]。無いとき null。 */
  mmPerPx: number | null;
  /** 主枝の中心線（画像 px、約 1 px 間隔。`traceCenterline` の出力）。 */
  mainPath: readonly (readonly [number, number])[];
  /** コントラストの割合（テストで平坦さを示すための上書き）。 */
  contrastFraction?: number;
}

type P = [number, number];

const median = (v: number[]): number => {
  if (!v.length) return NaN;
  const s = v.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const wrapPi = (a: number): number => {
  let x = a % (2 * Math.PI);
  if (x > Math.PI) x -= 2 * Math.PI;
  if (x < -Math.PI) x += 2 * Math.PI;
  return x;
};

export function proposeBranches(
  pixels: Float32Array, width: number, height: number, opts: XaBranchProposalOptions,
): XaBranchProposals {
  const mm = opts.mmPerPx;
  if (!(typeof mm === "number" && mm > 0 && Number.isFinite(mm))) {
    return { status: "noScale", proposals: [], warnings: ["noPixelSpacing"] };
  }
  if (opts.mainPath.length < 8) return { status: "badMain", proposals: [], warnings: ["mainTooShort"] };

  const frac = opts.contrastFraction ?? CONTRAST_FRACTION;
  const dMinPx = VESSEL_DIAMETER_RANGE_MM[0] / mm;
  const dMaxPx = VESSEL_DIAMETER_RANGE_MM[1] / mm;
  // 血管が高い値になる信号 S（暗い血管なら符号を反転）。
  const S = (x: number, y: number): number => (opts.vesselIsDark ? -1 : 1) * sampleBilinear(pixels, width, height, x, y);
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x <= width - 1 && y <= height - 1;

  const main = smoothPath(opts.mainPath.map((p) => [p[0], p[1]] as P), 5);
  const n = main.length;
  const tangent = (i: number): P => {
    const a = main[Math.max(0, i - 3)], b = main[Math.min(n - 1, i + 3)];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  };

  // 断面プロファイル（中心 ±half、刻み step）。
  const profileAt = (c: P, dir: P, half: number, step: number): number[] => {
    const nx = -dir[1], ny = dir[0];
    const out: number[] = [];
    for (let t = -half; t <= half + 1e-9; t += step) out.push(S(c[0] + nx * t, c[1] + ny * t));
    return out;
  };
  /** 断面から径・コントラスト・中心のずれを測る。測れなければ null。 */
  const measure = (c: P, dir: P, half: number): { d: number; contrast: number; shift: number } | null => {
    const step = 0.5;
    const prof = profileAt(c, dir, half, step);
    const ci = Math.round(half / step);
    const e = findEdgesInProfile(prof, ci, step);
    if (!e) return null;
    const k = Math.max(2, Math.round(prof.length * 0.15));
    const outer = median([...prof.slice(0, k), ...prof.slice(prof.length - k)]);
    const inner = median(prof.slice(Math.max(0, ci - 1), ci + 2));
    return { d: e.right - e.left, contrast: inner - outer, shift: (e.left + e.right) / 2 };
  };

  // 1. 主枝の局所径・コントラスト（窓の中央値で平らにする）。
  const rawD: number[] = [], rawC: number[] = [];
  for (let i = 0; i < n; i++) {
    const m = measure(main[i], tangent(i), dMaxPx * 1.2);
    rawD.push(m ? m.d : NaN);
    rawC.push(m ? m.contrast : NaN);
  }
  const win = Math.max(3, Math.round(MAIN_MEDIAN_WINDOW_MM / mm));
  const flat = (raw: number[]): number[] =>
    raw.map((_, i) => median(raw.slice(Math.max(0, i - win), Math.min(n, i + win + 1)).filter(Number.isFinite)));
  const dMain = flat(rawD), cMain = flat(rawC);
  if (!dMain.every((v) => v > 0) || !cMain.every((v) => v > 0)) return { status: "badMain", proposals: [], warnings: ["mainNotMeasurable"] };

  const distToMain = (p: P): number => {
    let m = Infinity;
    for (let i = 1; i < n; i++) {
      const a = main[i - 1], b = main[i];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const L = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L));
      m = Math.min(m, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
    }
    return m;
  };
  const nearestMainIndex = (p: P): number => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < n; i++) { const d = Math.hypot(main[i][0] - p[0], main[i][1] - p[1]); if (d < bd) { bd = d; bi = i; } }
    return bi;
  };

  // 2. 主枝を囲む円周での候補。
  interface Cand { q: P; u: P; score: number; idx: number }
  const cands: Cand[] = [];
  const stride = Math.max(1, Math.round(RING_STRIDE_MM / mm));
  for (let i = 0; i < n; i += stride) {
    const d = dMain[i];
    const R = RING_RADIUS_PER_DIAMETER * d;
    const nAng = Math.max(36, Math.ceil((2 * Math.PI * R) / 0.5));
    const t = tangent(i);
    const phi = Math.atan2(t[1], t[0]);
    const alpha = Math.asin(Math.min(1, d / R));
    const vals: number[] = [];
    const ok: boolean[] = [];
    for (let a = 0; a < nAng; a++) {
      const th = (2 * Math.PI * a) / nAng;
      const ex = Math.abs(wrapPi(th - phi)) < alpha || Math.abs(wrapPi(th - phi - Math.PI)) < alpha;
      const x = main[i][0] + R * Math.cos(th), y = main[i][1] + R * Math.sin(th);
      ok.push(!ex && inside(x, y));
      vals.push(ok[a] ? S(x, y) : NaN);
    }
    const bg = median(vals.filter(Number.isFinite));
    if (!Number.isFinite(bg)) continue;
    // 円周上の弧長 d/4 ぶんの移動平均（雑音の低減）。除外角の値は使わない。
    const hw = Math.max(1, Math.round((0.25 * d) / (2 * (2 * Math.PI * R / nAng))));
    const sm = vals.map((_, a) => {
      if (!ok[a]) return NaN;
      let s = 0, c = 0;
      for (let k = -hw; k <= hw; k++) { const v = vals[(a + k + nAng) % nAng]; if (Number.isFinite(v)) { s += v; c++; } }
      return s / c - bg;
    });
    for (let a = 0; a < nAng; a++) {
      const v = sm[a];
      if (!(v >= frac * cMain[i])) continue;
      const pr = sm[(a - 1 + nAng) % nAng], nx = sm[(a + 1) % nAng];
      if ((Number.isFinite(pr) && pr > v) || (Number.isFinite(nx) && nx >= v)) continue;
      const th = (2 * Math.PI * a) / nAng;
      cands.push({ q: [main[i][0] + R * Math.cos(th), main[i][1] + R * Math.sin(th)], u: [Math.cos(th), Math.sin(th)], score: v / cMain[i], idx: i });
    }
  }

  // 3. 候補ごとに脊線を追う。
  const traceFrom = (c: Cand): { pts: P[]; dias: number[]; stop: BranchStopReason } => {
    const pts: P[] = [c.q.slice() as P];
    const dias: number[] = [];
    let u: P = c.u;
    let dB = Math.max(dMinPx, dMain[c.idx] * 0.7);
    let stop: BranchStopReason = "maxLength";
    const maxSteps = Math.ceil((Math.max(width, height) * 2) / 1.5);
    for (let s = 0; s < maxSteps; s++) {
      const p = pts[pts.length - 1];
      const h = Math.max(1.5, 0.5 * dB);
      // 方向の候補のうち、断面を横切って平均した信号が最大のもの。
      let best: P = u, bv = -Infinity;
      for (let k = -TURN_STEPS; k <= TURN_STEPS; k++) {
        const ang = Math.atan2(u[1], u[0]) + (TURN_MAX * k) / TURN_STEPS;
        const dir: P = [Math.cos(ang), Math.sin(ang)];
        const x = p[0] + dir[0] * h, y = p[1] + dir[1] * h;
        const nx = -dir[1], ny = dir[0];
        const v = (S(x, y) + 0.5 * S(x + nx * 0.25 * dB, y + ny * 0.25 * dB) + 0.5 * S(x - nx * 0.25 * dB, y - ny * 0.25 * dB)) / 2;
        if (v > bv) { bv = v; best = dir; }
      }
      const nu: P = [0.5 * u[0] + 0.5 * best[0], 0.5 * u[1] + 0.5 * best[1]];
      const L = Math.hypot(nu[0], nu[1]) || 1;
      u = [nu[0] / L, nu[1] / L];
      let np: P = [p[0] + u[0] * h, p[1] + u[1] * h];
      if (!inside(np[0], np[1])) { stop = "border"; break; }
      const m = measure(np, u, Math.max(2.5 * dB, 2 * dMinPx));
      if (!m) { stop = "noEdge"; break; }
      if (m.d < dMinPx || m.d > dMaxPx) { stop = "diameterRange"; break; }
      if (m.contrast < frac * cMain[c.idx]) { stop = "faded"; break; }
      // 断面の中心へ寄せる（1 歩で径の半分まで）。
      const sh = Math.max(-0.5 * dB, Math.min(0.5 * dB, m.shift));
      np = [np[0] - u[1] * sh, np[1] + u[0] * sh];
      dB = m.d;
      pts.push(np);
      dias.push(m.d);
      if (pts.length > 3 && distToMain(np) < 0.75 * dMain[nearestMainIndex(np)]) { stop = "rejoin"; break; }
    }
    return { pts, dias, stop };
  };

  const polyLen = (pl: P[]) => { let s = 0; for (let i = 1; i < pl.length; i++) s += Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]); return s; };
  const out: BranchProposal[] = [];
  const order = cands.slice().sort((a, b) => b.score - a.score);
  for (const c of order) {
    const { pts, dias, stop } = traceFrom(c);
    // 主枝へ戻ってきた線は、主枝の自己交差・急な曲がり・並走する別区間であって、側枝ではない。
    if (pts.length < 3 || stop === "rejoin") continue;
    const dMed = median(dias);
    if (polyLen(pts) < dMed) continue; // 自分の径より短い線は血管でない
    // 主枝の上をなぞっただけ（別の区間の交差や急な曲がり）は側枝ではない。
    const onMain = pts.filter((p) => distToMain(p) <= 2).length / pts.length;
    if (onMain > 0.5) continue;
    // すでに採った提案と大半が重なるものは同じ枝。
    const dup = out.some((o) => pts.filter((p) => o.pointsPx.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= 2)).length / pts.length > 0.5);
    if (dup) continue;
    // 主枝までの橋渡し: 起点の方向を逆にたどって主枝の中心線に着く。
    const back: P[] = [];
    const u0: P = [pts[0][0] - pts[Math.min(3, pts.length - 1)][0], pts[0][1] - pts[Math.min(3, pts.length - 1)][1]];
    const L0 = Math.hypot(u0[0], u0[1]) || 1;
    let cur: P = pts[0];
    // 起点は主枝から円周の半径ぶんしか離れていないので、その 2 倍で着かなければ主枝につながる枝ではない。
    const maxBack = Math.ceil(2 * RING_RADIUS_PER_DIAMETER * dMain[c.idx]);
    for (let k = 0; k < maxBack && distToMain(cur) > 1; k++) { cur = [cur[0] + u0[0] / L0, cur[1] + u0[1] / L0]; back.push(cur); }
    if (distToMain(cur) > 1) continue;
    const full: P[] = back.reverse().concat(pts).slice();
    // 主枝に近い側が先頭になるよう並べ替え済み（back は主枝側→起点の順）。
    out.push({
      pointsPx: full,
      originMainIndex: nearestMainIndex(full[0]),
      lengthMm: polyLen(full) * mm,
      diameterMm: dMed * mm,
      contrastRatio: c.score,
      stopReason: stop,
    });
  }
  return { status: "ok", proposals: out, warnings: [] };
}
