import { describe, expect, it } from "vitest";
import { referenceFromEnds, runQca, type QcaResult } from "./qca";
import {
  analyzeDilation,
  normalizeAneurysmRatio,
  summarizeDiameters,
  DEFAULT_ANEURYSM_RATIO,
  ANEURYSM_RATIO_MIN,
  ANEURYSM_RATIO_MAX,
} from "./qva";

/**
 * QVA（`fw/angio-design.md` §9.1 / A5a）の数値検証。
 *
 * <p>ここも**真値が既知の合成ファントム**でしか判定しない（qca.test.ts と同じ方針）。
 * ただし箱型断面なので**半値法が厳密に正しく**なる点に注意 —— 実際の円柱では径が 13% 過小に
 * 出る（§16.4）。**比（拡張率）はその系統誤差が打ち消される**ので、判定基準に使うのは比のほう。
 */
const BG = 200;
const VESSEL = 60;
const mmPerPx = 0.2;

/** 半径 r(x)・中心 cy(x) の水平血管（中心をずらせるので嚢状の瘤も作れる）。 */
function makeVessel(
  width: number,
  height: number,
  radiusAt: (x: number) => number,
  centerAt: (x: number) => number,
): { pixels: Float32Array; width: number; height: number } {
  const pixels = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = Math.max(0, Math.min(1, radiusAt(x) + 0.5 - Math.abs(y - centerAt(x))));
      pixels[y * width + x] = BG - (BG - VESSEL) * inside;
    }
  }
  return { pixels, width, height };
}

/** 余弦の膨らみ（狭窄と同じ形の裏返し）。中心 60px・半幅 20px。 */
function bulge(x: number, peak: number): number {
  const d = Math.abs(x - 60);
  if (d >= 20) return 0;
  return peak * 0.5 * (1 + Math.cos((Math.PI * d) / 20));
}

function analyze(pixels: Float32Array, width: number, height: number, cy: number): QcaResult {
  return runQca({
    pixels,
    width,
    height,
    start: [10, cy],
    end: [width - 11, cy],
    mmPerPxRow: mmPerPx,
    mmPerPxCol: mmPerPx,
    vesselIsDark: true,
    profileRadiusPx: 30,
    edits: { reference: { kind: "ends" } },
    // 🚨 ここのファントムは**箱型（スラブ）で透過画像ではない**ので、密度計測（§16.5）は
    //    使えない（−ln に物理的な意味が無い）。`qca.test.ts` の `SLAB` と同じ理由。
    //    密度計測の正しさはビール則で作った断面と bench の GNBP-XA-7 で測る。
    densitometry: false,
  })!;
}

describe("referenceFromEnds — 両端を健常と見なす参照径", () => {
  it("中央が膨らんでいても参照径は健常部の径のまま", () => {
    const pos = Array.from({ length: 40 }, (_, i) => i * 0.5);
    // 中央 20 点（＝全体の半分）が 6.0 に膨らんでいる。
    const dia = pos.map((_, i) => (i >= 10 && i < 30 ? 6 : 3));
    const ref = referenceFromEnds(pos, dia);
    for (const r of ref) expect(Math.abs(r - 3)).toBeLessThan(0.01);
  });

  it("テーパーを線形で追う", () => {
    const pos = Array.from({ length: 40 }, (_, i) => i);
    const dia = pos.map((p) => 5 - 0.05 * p);
    const ref = referenceFromEnds(pos, dia);
    expect(ref[0]).toBeCloseTo(5, 1);
    expect(ref[39]).toBeCloseTo(3.05, 1);
  });

  it("端が数点だけ太くても中央値なので引かれない", () => {
    const pos = Array.from({ length: 40 }, (_, i) => i);
    const dia = pos.map((_, i) => (i < 2 || i >= 38 ? 4.2 : 3));
    const ref = referenceFromEnds(pos, dia);
    for (const r of ref) expect(Math.abs(r - 3)).toBeLessThan(0.05);
  });

  it("点が少なくても壊れない", () => {
    expect(referenceFromEnds([], [])).toEqual([]);
    expect(referenceFromEnds([0, 1, 2], [3, 3, 3])).toEqual([3, 3, 3]);
  });
});

describe("★analyzeDilation — 瘤の計測（真値既知ファントム）", () => {
  it("紡錘状: 最大径・拡張率・長さ・偏心度が真値どおり", () => {
    // 参照径 3.0mm（r=7.5px）→ 最大径 6.0mm（r=15px）。膨らみの全長は 40px = 8.0mm。
    const p = makeVessel(120, 80, (x) => 7.5 + bulge(x, 7.5), () => 40);
    const r = analyze(p.pixels, p.width, p.height, 40);
    const d = analyzeDilation(r)!;
    expect(d).not.toBeNull();
    expect(Math.abs(d.referenceAtMax - 3.0)).toBeLessThan(0.1);
    expect(Math.abs(d.maxDiameter - 6.0)).toBeLessThan(0.15);
    // ★ 比は系統誤差が打ち消される量。真値 2.0。
    expect(Math.abs(d.ratio - 2.0)).toBeLessThan(0.1);
    expect(d.percentDilation).toBeGreaterThan(90);
    expect(d.aneurysmal).toBe(true);
    expect(Math.abs(d.length - 8.0)).toBeLessThan(1.0);
    // 全周性なので偏心度はほぼ 0。
    expect(d.eccentricity!).toBeLessThan(0.15);
    // ネックは参照径に戻っている。
    expect(Math.abs(d.proximalNeck - 3.0)).toBeLessThan(0.2);
    expect(Math.abs(d.distalNeck - 3.0)).toBeLessThan(0.2);
  });

  it("★嚢状: 同じ最大径でも偏心度で紡錘状と区別できる", () => {
    // 片側の壁だけを押し出す。内腔は [−7.5, +7.5+膨らみ] なので、
    // 最大径 6.0mm（30px）にするには**片側で 15px** 押し出す（紡錘状の 2 倍）。
    const half = (x: number) => 7.5 + bulge(x, 15) / 2;
    const center = (x: number) => 40 + bulge(x, 15) / 2;
    const p = makeVessel(120, 80, half, center);
    const r = analyze(p.pixels, p.width, p.height, 40);
    const d = analyzeDilation(r)!;
    expect(Math.abs(d.maxDiameter - 6.0)).toBeLessThan(0.2);
    expect(d.aneurysmal).toBe(true);
    // ★ 片側だけの張り出し。中心線が瘤へ引き込まれるぶん 1.0 にはならないが、
    //    紡錘状（< 0.15）とは明確に分かれる。
    expect(d.eccentricity!).toBeGreaterThan(0.5);
  });

  it("軽い拡張は「瘤」と呼ばない（1.5 倍の基準）", () => {
    // 3.0mm → 3.6mm（比 1.2）。
    const p = makeVessel(120, 60, (x) => 7.5 + bulge(x, 1.5), () => 30);
    const r = analyze(p.pixels, p.width, p.height, 30);
    const d = analyzeDilation(r)!;
    expect(d.ratio).toBeLessThan(DEFAULT_ANEURYSM_RATIO);
    expect(d.aneurysmal).toBe(false);
    expect(d.ectatic).toBe(true);
  });

  it("拡張が無ければ null（参照径のすぐ上の揺れで瘤を作らない）", () => {
    const p = makeVessel(120, 60, () => 7.5, () => 30);
    const r = analyze(p.pixels, p.width, p.height, 30);
    expect(analyzeDilation(r)).toBeNull();
  });

  // 🔴 実機で踏んだ壊れ方（GNBP-XA-5 のフレーム 6）。解析区間の端は径が太く出るので、
  //    そのまま最大径を採ると**拡張の無い血管に瘤が生える**。
  it("★解析区間の端の膨らみを瘤として報告しない", () => {
    const flat: QcaResult = {
      ...({} as QcaResult),
      positions: Array.from({ length: 20 }, (_, i) => i * 0.5),
      // 端の 2 点だけ太い（実測と同じ 2.61 → 2.82）。
      diameters: Array.from({ length: 20 }, (_, i) => (i < 2 || i >= 18 ? 2.82 : 2.61)),
      reference: Array.from({ length: 20 }, () => 2.61),
      edgeOffsets: Array.from({ length: 20 }, () => ({ left: -1.3, right: 1.3 })),
      centerline: Array.from({ length: 20 }, (_, i) => [i, 0] as [number, number]),
      normals: Array.from({ length: 20 }, () => [0, 1] as [number, number]),
    };
    expect(analyzeDilation(flat)).toBeNull();
  });

  it("★端が太くても、内側に本物の瘤があればそちらを測る", () => {
    const n = 20;
    const withSac: QcaResult = {
      ...({} as QcaResult),
      positions: Array.from({ length: n }, (_, i) => i * 0.5),
      diameters: Array.from({ length: n }, (_, i) =>
        i < 2 || i >= n - 2 ? 2.82 : i >= 9 && i <= 11 ? 5.2 : 2.61,
      ),
      reference: Array.from({ length: n }, () => 2.61),
      edgeOffsets: Array.from({ length: n }, () => ({ left: -1.3, right: 1.3 })),
      centerline: Array.from({ length: n }, (_, i) => [i, 0] as [number, number]),
      normals: Array.from({ length: n }, () => [0, 1] as [number, number]),
    };
    const d = analyzeDilation(withSac)!;
    expect(d).not.toBeNull();
    expect(d.maxDiameter).toBeCloseTo(5.2, 6);
    expect(d.aneurysmal).toBe(true);
  });

  it("径をすべて k 倍しても比・拡張率・偏心度は変わらない（系統誤差に依らない量）", () => {
    const base: QcaResult = {
      ...({} as QcaResult),
      positions: [0, 1, 2, 3, 4, 5, 6],
      diameters: [3, 3, 4.5, 6, 4.5, 3, 3],
      reference: [3, 3, 3, 3, 3, 3, 3],
      edgeOffsets: [3, 3, 4.5, 6, 4.5, 3, 3].map((d) => ({ left: -d / 2, right: d / 2 })),
      // 偏心度はネック間の直線を基準に測るので、中心線と法線が要る。
      centerline: Array.from({ length: 7 }, (_, i) => [i, 0] as [number, number]),
      normals: Array.from({ length: 7 }, () => [0, 1] as [number, number]),
    };
    const k = 0.87; // §16.4 の系統誤差そのもの
    const scaled: QcaResult = {
      ...base,
      diameters: base.diameters.map((d) => d * k),
      reference: base.reference.map((d) => d * k),
      edgeOffsets: base.edgeOffsets.map((o) => ({ left: o.left * k, right: o.right * k })),
    };
    const a = analyzeDilation(base)!;
    const b = analyzeDilation(scaled)!;
    expect(b.ratio).toBeCloseTo(a.ratio, 9);
    expect(b.percentDilation).toBeCloseTo(a.percentDilation, 9);
    expect(b.eccentricity!).toBeCloseTo(a.eccentricity!, 9);
    // 絶対値のほうは k 倍される（打ち消されないことも固定しておく）。
    expect(b.maxDiameter).toBeCloseTo(a.maxDiameter * k, 9);
  });
});

/**
 * 「動脈瘤と呼ぶ比」は**設定で変えられる**（2026-08-31・利用者の要望）。
 * 判定・画面・SR が同じ値を使うこと、壊れた設定で判定が消えないことを固定する。
 */
describe("動脈瘤の基準（設定可能）", () => {
  const profile: QcaResult = {
    ...({} as QcaResult),
    positions: [0, 1, 2, 3, 4, 5, 6],
    diameters: [3, 3, 3.6, 4.2, 3.6, 3, 3],
    reference: [3, 3, 3, 3, 3, 3, 3],
    edgeOffsets: [3, 3, 3.6, 4.2, 3.6, 3, 3].map((d) => ({ left: -d / 2, right: d / 2 })),
    centerline: Array.from({ length: 7 }, (_, i) => [i, 0] as [number, number]),
    normals: Array.from({ length: 7 }, () => [0, 1] as [number, number]),
  };

  it("既定（1.5 倍）では比 1.4 は瘤にならない", () => {
    const d = analyzeDilation(profile)!;
    expect(d.ratio).toBeCloseTo(1.4, 9);
    expect(d.aneurysmal).toBe(false);
    expect(d.aneurysmRatio).toBe(DEFAULT_ANEURYSM_RATIO);
  });

  it("基準を 1.3 に下げると同じ形が瘤になる（判定に使った比も一緒に返る）", () => {
    const d = analyzeDilation(profile, { aneurysmRatio: 1.3 })!;
    expect(d.aneurysmal).toBe(true);
    // 🔴 画面と SR に出すのはこの値。ここが返らないと「基準 1.5」と書かれた保存物ができる。
    expect(d.aneurysmRatio).toBe(1.3);
  });

  it("基準を上げると瘤でなくなる（境界はちょうどで含む）", () => {
    expect(analyzeDilation(profile, { aneurysmRatio: 1.4 })!.aneurysmal).toBe(true);
    expect(analyzeDilation(profile, { aneurysmRatio: 1.41 })!.aneurysmal).toBe(false);
  });

  it("壊れた設定は範囲に丸めるか既定へ落とす（解析そのものは止めない）", () => {
    expect(normalizeAneurysmRatio("1.3")).toBe(1.3);
    expect(normalizeAneurysmRatio("")).toBe(DEFAULT_ANEURYSM_RATIO);
    expect(normalizeAneurysmRatio(undefined)).toBe(DEFAULT_ANEURYSM_RATIO);
    expect(normalizeAneurysmRatio(Number.NaN)).toBe(DEFAULT_ANEURYSM_RATIO);
    // 1.0 以下は「常に瘤」になるので許さない。
    expect(normalizeAneurysmRatio(0.5)).toBe(ANEURYSM_RATIO_MIN);
    expect(normalizeAneurysmRatio(99)).toBe(ANEURYSM_RATIO_MAX);
    // 丸めた値がそのまま判定に使われる（画面の基準文と食い違わない）。
    expect(analyzeDilation(profile, { aneurysmRatio: 0.5 })!.aneurysmRatio).toBe(ANEURYSM_RATIO_MIN);
  });
});

/**
 * 拡張が無くても最大径・参照径は出す（2026-08-31・利用者の要望）。
 * 「拡張なし」とだけ出すと、**測れなかったのか拡張が無かったのか**が区別できない。
 */
describe("最大径・参照径は常に出せる", () => {
  const flat: QcaResult = {
    ...({} as QcaResult),
    positions: Array.from({ length: 20 }, (_, i) => i),
    // 端 2 点だけが太い（実データで見えている「区間の端は太く出る」現象）。
    diameters: Array.from({ length: 20 }, (_, i) => (i < 2 || i >= 18 ? 3.4 : 3.0)),
    reference: Array.from({ length: 20 }, () => 3.0),
    edgeOffsets: Array.from({ length: 20 }, () => ({ left: -1.5, right: 1.5 })),
    centerline: Array.from({ length: 20 }, (_, i) => [i, 0] as [number, number]),
    normals: Array.from({ length: 20 }, () => [0, 1] as [number, number]),
  };

  it("拡張が無い（＝瘤として報告しない）ときでも最大径と参照径が取れる", () => {
    expect(analyzeDilation(flat)).toBeNull();
    const s = summarizeDiameters(flat)!;
    // 🔴 端の膨らみは拾わない（拾うと「拡張なし」なのに比 1.13 が出て矛盾して見える）。
    expect(s.maxDiameter).toBeCloseTo(3.0, 9);
    expect(s.referenceAtMax).toBeCloseTo(3.0, 9);
    expect(s.ratio).toBeCloseTo(1.0, 9);
  });

  it("点が少なすぎるときは null（無い数字を作らない）", () => {
    expect(summarizeDiameters({ ...flat, diameters: [3], reference: [3], positions: [0] })).toBeNull();
  });
});
