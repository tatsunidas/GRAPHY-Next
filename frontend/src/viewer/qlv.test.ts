/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * QLV（左室造影の定量解析）の検査 — `fw/angio-design.md` §9.2 / A5b。
 *
 * <h3>🚨 このファイルのファントムは「楕円体」なので、測れるのは実装の正しさだけ</h3>
 * Area-Length（V = 8A²/3πL）は**長球の厳密解**なので、楕円体を入れれば必ず真値が出る。
 * つまりここで確かめられるのは「式を正しく実装したか」までで、**手法の誤差は測れない**。
 * 手法の誤差は非楕円体のファントム（`bench/` の GNBP-XA-5・未生成）でしか出ない。
 * §16.4 で踏んだ「箱型断面ファントムでは半値法が厳密に正しく出る」と**同じ構図**。
 */
import { describe, expect, it } from "vitest";
import {
  computeQlv,
  ejectionFraction,
  expandedBounds,
  opacifiedAreaInRect,
  kennedyCorrectedMl,
  lvMetrics,
  opacifiedAreaCount,
  polygonArea,
  polygonCentroid,
  resampleByArcLength,
  smoothContour,
  suggestEdEs,
  wallMotion,
  type Point,
} from "./qlv";

/**
 * 長球（prolate spheroid）の投影輪郭。半長軸 a（縦）・半短軸 b（横）。
 *
 * <p>点列は本番と同じ **「弁輪の一端 → 心尖 → 他端」** の順。θ を `cut` から `2π−cut` まで
 * 回すと、上端（弁面側）を `cut` ぶん切り落とした開曲線になる。
 * `cut = 0` なら弁面の幅が 0 ＝ 完全な楕円で、**Area-Length の厳密解と比べられる**。
 *
 * <p>⚠️ 最初に書いたときは θ を −π/2〜+π/2 で回して**半楕円**を作っており、
 * 弁面が長軸そのものになっていた（面積が半分・心尖が弁輪と同距離）。
 * ファントムの向きを間違えると、実装ではなくファントムを検算することになる。
 */
function ellipseContour(a: number, b: number, cut = 0, cx = 0, cy = 0, n = 720): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const th = cut + ((2 * Math.PI - 2 * cut) * i) / n;
    // θ=0 が上端（弁面）、θ=π が下端（心尖）。
    out.push([cx + b * Math.sin(th), cy - a * Math.cos(th)]);
  }
  return out;
}

describe("多角形の基本量", () => {
  it("正方形の面積", () => {
    expect(polygonArea([[0, 0], [10, 0], [10, 10], [0, 10]])).toBeCloseTo(100, 9);
  });

  it("楕円の面積 ≈ πab", () => {
    const pts: Point[] = [];
    for (let i = 0; i < 720; i++) {
      const th = (2 * Math.PI * i) / 720;
      pts.push([30 * Math.cos(th), 50 * Math.sin(th)]);
    }
    expect(polygonArea(pts)).toBeCloseTo(Math.PI * 30 * 50, 0);
  });

  it("図心は頂点の平均ではなく多角形の図心", () => {
    // 片側に頂点が密集した三角形。頂点平均だと密集側へ寄る。
    const tri: Point[] = [[0, 0], [1, 0], [2, 0], [3, 0], [0, 3]];
    const c = polygonCentroid(tri);
    expect(c[0]).toBeGreaterThan(0);
    expect(c[1]).toBeGreaterThan(0);
  });

  it("向き（時計回り / 反時計回り）で面積の符号が変わらない", () => {
    const sq: Point[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(polygonArea([...sq].reverse())).toBeCloseTo(polygonArea(sq), 9);
  });
});

describe("lvMetrics", () => {
  const px = { mmPerPxRow: 0.3, mmPerPxCol: 0.3 };

  it("★長球なら Area-Length が真の容積と一致する（式の検算）", () => {
    // 半長軸 a=150px, 半短軸 b=85px。弁面の幅 0 なので長軸長 L = 2a。
    const a = 150;
    const b = 85;
    const m = lvMetrics(ellipseContour(a, b), px)!;
    expect(m).not.toBeNull();
    expect(m.areaPx2).toBeCloseTo(Math.PI * a * b, -1);
    expect(m.longAxisPx).toBeCloseTo(2 * a, 0);
    // 真の容積 = 4/3 π a b²。**一致するのは楕円体だからで、手法の精度ではない**。
    const truePx3 = (4 / 3) * Math.PI * a * b * b;
    expect(m.volumePx3 / truePx3).toBeCloseTo(1, 3);
  });

  it("心尖は弁面の中点から最も遠い点として決まる", () => {
    const c = ellipseContour(150, 85, 0.35);
    const m = lvMetrics(c, px)!;
    const apex = c[m.apexIndex];
    expect(apex[1]).toBeGreaterThan(140); // 下端（心尖）付近
    expect(Math.abs(apex[0])).toBeLessThan(3); // 長軸上
  });

  it("弁面を切ると面積・長軸ともに小さくなる（弁面の位置が効いている）", () => {
    const full = lvMetrics(ellipseContour(150, 85, 0), px)!;
    const cut = lvMetrics(ellipseContour(150, 85, 0.5), px)!;
    expect(cut.areaPx2).toBeLessThan(full.areaPx2);
    expect(cut.longAxisPx).toBeLessThan(full.longAxisPx);
    expect(cut.valveWidthPx).toBeGreaterThan(10);
  });

  it("mm 換算が spacing の積・方向に従う", () => {
    const m = lvMetrics(ellipseContour(150, 85), { mmPerPxRow: 0.2, mmPerPxCol: 0.4 })!;
    expect(m.areaMm2).toBeCloseTo(m.areaPx2 * 0.2 * 0.4, 6);
    // 長軸は縦（行）方向なので row spacing が効く。
    expect(m.longAxisMm).toBeCloseTo(m.longAxisPx * 0.2, 6);
  });

  it("未校正なら mm 系の値は null（px³ を mL と偽らない）", () => {
    const m = lvMetrics(ellipseContour(150, 85), { mmPerPxRow: null, mmPerPxCol: null })!;
    expect(m.areaMm2).toBeNull();
    expect(m.longAxisMm).toBeNull();
    expect(m.volumeMl).toBeNull();
    expect(m.volumePx3).toBeGreaterThan(0);
  });

  it("点が少なすぎたら null", () => {
    expect(lvMetrics([[0, 0], [1, 1]], px)).toBeNull();
  });
});

describe("★EF のスケール不変性（§9.2.1 の根拠）", () => {
  // 実寸に近い左室（0.3mm/px で長軸 90mm・EDV ≈ 122mL）。小さすぎる心室にすると
  // Kennedy 補正後が負になり、補正の性質を確かめる前に「補正なし」になってしまう。
  const ed = ellipseContour(150, 85);
  const es = ellipseContour(120, 60);

  it("未校正でも EF が計算できる", () => {
    const r = computeQlv({
      edFrame: 10,
      esFrame: 20,
      edContour: ed,
      esContour: es,
      pixel: { mmPerPxRow: null, mmPerPxCol: null },
    })!;
    expect(r.unit).toBe("px³");
    expect(r.edvMl).toBeNull();
    expect(r.ejectionFraction).toBeGreaterThan(0);
    expect(r.warnings).toContain("uncalibrated");
  });

  it("★★校正の有無で EF が変わらない", () => {
    const uncal = computeQlv({
      edFrame: 0, esFrame: 1, edContour: ed, esContour: es,
      pixel: { mmPerPxRow: null, mmPerPxCol: null },
    })!;
    const cal = computeQlv({
      edFrame: 0, esFrame: 1, edContour: ed, esContour: es,
      pixel: { mmPerPxRow: 0.3, mmPerPxCol: 0.3 },
    })!;
    expect(cal.ejectionFraction).toBeCloseTo(uncal.ejectionFraction, 9);
  });

  it("★★輪郭を k 倍しても EF は完全に不変（体積 ∝ 長さ³ が比で消える）", () => {
    const scale = (pts: Point[], k: number): Point[] => pts.map((p) => [p[0] * k, p[1] * k] as Point);
    const base = computeQlv({
      edFrame: 0, esFrame: 1, edContour: ed, esContour: es,
      pixel: { mmPerPxRow: 0.3, mmPerPxCol: 0.3 },
    })!;
    for (const k of [0.5, 2, 7.3]) {
      const scaled = computeQlv({
        edFrame: 0, esFrame: 1, edContour: scale(ed, k), esContour: scale(es, k),
        pixel: { mmPerPxRow: 0.3, mmPerPxCol: 0.3 },
      })!;
      expect(scaled.ejectionFraction).toBeCloseTo(base.ejectionFraction, 9);
      // 容積のほうは k³ で変わる（不変なのは EF だけ、を固定する）。
      expect(scaled.edvMl! / base.edvMl!).toBeCloseTo(k ** 3, 5);
    }
  });

  it("🚨 Kennedy 補正はアフィンなのでスケール不変では **ない**", () => {
    // これが不変だと勘違いすると、未校正データで補正版 EF を出してしまう。
    const scale = (pts: Point[], k: number): Point[] => pts.map((p) => [p[0] * k, p[1] * k] as Point);
    const a = computeQlv({
      edFrame: 0, esFrame: 1, edContour: ed, esContour: es,
      pixel: { mmPerPxRow: 0.3, mmPerPxCol: 0.3 },
    })!;
    const b = computeQlv({
      edFrame: 0, esFrame: 1, edContour: scale(ed, 1.5), esContour: scale(es, 1.5),
      pixel: { mmPerPxRow: 0.3, mmPerPxCol: 0.3 },
    })!;
    expect(a.kennedy).not.toBeNull();
    expect(b.kennedy).not.toBeNull();
    // 補正なしの EF は一致するのに…
    expect(b.ejectionFraction).toBeCloseTo(a.ejectionFraction, 9);
    // …補正後は一致しない。
    expect(Math.abs(b.kennedy!.ejectionFraction - a.kennedy!.ejectionFraction)).toBeGreaterThan(0.1);
  });

  it("未校正なら Kennedy 補正は出さない", () => {
    const r = computeQlv({
      edFrame: 0, esFrame: 1, edContour: ed, esContour: es,
      pixel: { mmPerPxRow: null, mmPerPxCol: null },
    })!;
    expect(r.kennedy).toBeNull();
  });

  it("Kennedy の式そのもの", () => {
    expect(kennedyCorrectedMl(100)).toBeCloseTo(0.928 * 100 - 3.8, 9);
    // 小さい心室では補正後が負になりうる（そのときは出さない）。
    expect(kennedyCorrectedMl(3)).toBeLessThan(0);
  });

  it("ES が ED より大きければ警告する", () => {
    const r = computeQlv({
      edFrame: 0, esFrame: 1, edContour: es, esContour: ed,
      pixel: { mmPerPxRow: 0.3, mmPerPxCol: 0.3 },
    })!;
    expect(r.warnings).toContain("esLargerThanEd");
    expect(r.ejectionFraction).toBeLessThan(0);
  });

  it("EF の定義", () => {
    expect(ejectionFraction(100, 40)).toBeCloseTo(60, 9);
    expect(Number.isNaN(ejectionFraction(0, 0))).toBe(true);
  });
});

describe("ED/ES フレームの提案", () => {
  /** 造影の立ち上がり ＋ 正弦波の心拍。 */
  function curve(opts: { frames: number; arrival: number; period: number; amp?: number }): number[] {
    const out: number[] = [];
    for (let i = 0; i < opts.frames; i++) {
      const fill = i < opts.arrival ? i / Math.max(1, opts.arrival) : 1;
      const beat = 1 - (opts.amp ?? 0.35) * (1 - Math.cos((2 * Math.PI * (i - opts.arrival)) / opts.period)) / 2;
      out.push(100 * fill * (i < opts.arrival ? 1 : beat));
    }
    return out;
  }

  it("充満後の区間から ED（最大）と ES（最小）を選ぶ", () => {
    const c = curve({ frames: 120, arrival: 30, period: 24 });
    const s = suggestEdEs(c)!;
    expect(s.es).toBeGreaterThan(s.ed);
    expect(c[s.ed]).toBeGreaterThan(c[s.es]);
  });

  it("★★充満途中のフレームを ED / ES として拾わない", () => {
    // 立ち上がりの途中は心室が満たされておらず、面積が真のサイズを表さない。
    // 「最小と最大の中間を超えた所」を起点にすると**ここを拾う**（最初の実装がそうだった）。
    const c = curve({ frames: 120, arrival: 30, period: 24 });
    const s = suggestEdEs(c)!;
    expect(s.ed).toBeGreaterThanOrEqual(29);
    expect(s.es).toBeGreaterThanOrEqual(29);
    // ED はきちんと拡張末期（ほぼ最大値）である。
    expect(c[s.ed]).toBeGreaterThan(0.99 * Math.max(...c));
  });

  it("ES は必ず ED より後（心周期の順序）", () => {
    for (const period of [16, 20, 24, 30]) {
      const s = suggestEdEs(curve({ frames: 140, arrival: 20, period }))!;
      expect(s.es).toBeGreaterThan(s.ed);
    }
  });

  it("1 フレーム目から満量なら警告する（立ち上がりを観測できていない）", () => {
    // 前の注入が残っている場合など。ED/ES の選択自体は続けるが、根拠が弱いことを伝える。
    const already = [100, 90, 80, 70, 75, 85, 95, 88, 78, 70, 80, 92];
    const s = suggestEdEs(already)!;
    expect(s.warnings).toContain("fillingNotDetected");
    expect(s.window[0]).toBe(0);
  });

  it("ES が見つからない縮退でも ED と同じフレームを返さない", () => {
    // 造影が最後のフレームで最大になる（＝ED の後が無い）ケース。
    const late = [10, 12, 15, 20, 30, 50, 70, 85, 95, 100];
    const s = suggestEdEs(late)!;
    expect(s.warnings).toContain("esBeforeEd");
    expect(s.es).not.toBe(s.ed);
  });

  it("短すぎる/平坦なら null", () => {
    expect(suggestEdEs([1, 2])).toBeNull();
    expect(suggestEdEs([5, 5, 5, 5])).toBeNull();
  });
});

describe("壁運動（弦の短縮）", () => {
  // 実寸に近い左室（0.3mm/px で長軸 90mm・EDV ≈ 122mL）。小さすぎる心室にすると
  // Kennedy 補正後が負になり、補正の性質を確かめる前に「補正なし」になってしまう。
  const ed = ellipseContour(150, 85);
  const es = ellipseContour(120, 60);

  it("一様に縮んだ心室は全弦が正（内向き）", () => {
    const w = wallMotion(ed, es, 100)!;
    expect(w.shortening).toHaveLength(100);
    expect(w.shortening.every((v) => v > 0)).toBe(true);
  });

  it("動かなければ 0", () => {
    const w = wallMotion(ed, ed, 50)!;
    expect(Math.max(...w.normalized.map(Math.abs))).toBeLessThan(1e-9);
  });

  it("外向き（奇異性運動）は負になる", () => {
    const w = wallMotion(ellipseContour(120, 60), ellipseContour(150, 85), 50)!;
    expect(w.shortening.some((v) => v < 0)).toBe(true);
  });

  it("★正規化した値はスケール不変（未校正でも比較できる）", () => {
    const k = 3.7;
    const sc = (pts: Point[]): Point[] => pts.map((p) => [p[0] * k, p[1] * k] as Point);
    const a = wallMotion(ed, es, 40)!;
    const b = wallMotion(sc(ed), sc(es), 40)!;
    for (let i = 0; i < 40; i++) expect(b.normalized[i]).toBeCloseTo(a.normalized[i], 6);
  });

  it("Sheehan の centerline 法だと名乗らない", () => {
    // 名前を借りると、実装していない手法の妥当性を主張してしまう。
    expect(wallMotion(ed, es, 10)!.method).toBe("arc-length-chords");
  });
});

describe("補助関数", () => {
  it("弧長の再標本化は端点を保つ", () => {
    const pts: Point[] = [[0, 0], [10, 0], [10, 10]];
    const r = resampleByArcLength(pts, 21);
    expect(r).toHaveLength(21);
    expect(r[0]).toEqual([0, 0]);
    expect(r[20][0]).toBeCloseTo(10, 6);
    expect(r[20][1]).toBeCloseTo(10, 6);
  });

  it("再標本化した点の間隔がほぼ等しい", () => {
    const pts: Point[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const r = resampleByArcLength(pts, 31);
    const d: number[] = [];
    for (let i = 1; i < r.length; i++) d.push(Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]));
    expect(Math.max(...d) - Math.min(...d)).toBeLessThan(1e-6);
  });

  it("平滑化は端点を動かさない（弁面の位置を勝手に変えない）", () => {
    const pts: Point[] = [[0, 0], [5, 8], [12, 9], [18, 2]];
    const s = smoothContour(pts, 8);
    expect(s[0]).toEqual(pts[0]);
    expect(s[s.length - 1]).toEqual(pts[pts.length - 1]);
    expect(s.length).toBeGreaterThan(pts.length);
  });

  it("造影面積の閾値はフレーム内の相対値（濃淡をサイズ変化と混同しない）", () => {
    const bright = new Float32Array([100, 100, 10, 10]);
    // 全体を暗くしただけ（造影が濃い）でも、暗い画素の割合は変わらない。
    const dark = new Float32Array([50, 50, 5, 5]);
    expect(opacifiedAreaCount(bright)).toBe(opacifiedAreaCount(dark));
  });
});

describe("関心領域と生理的な妥当性（実データで踏んだ 2 件）", () => {
  it("🚨 画面全体で数えると心室以外を拾う → 矩形で切れる", () => {
    // 左半分が「心室」（造影で暗い）、右半分が背景（明るいが一部暗い＝横隔膜など）。
    const w = 20;
    const h = 10;
    const v = new Float32Array(w * h).fill(100);
    for (let y = 0; y < h; y++) for (let x = 0; x < 6; x++) v[y * w + x] = 0; // 心室
    for (let y = 0; y < h; y++) for (let x = 14; x < 20; x++) v[y * w + x] = 0; // 心室外の暗い構造
    const whole = opacifiedAreaCount(v);
    const roi = opacifiedAreaInRect(v, w, h, { x0: 0, y0: 0, x1: 9, y1: h - 1 });
    expect(whole).toBe(120); // 6×10 ＋ 6×10 ＝ 心室以外まで数えている
    expect(roi).toBe(60); // 心室だけ
  });

  it("輪郭から関心領域を作れる（余白つき）", () => {
    const b = expandedBounds([[10, 20], [30, 60]], 0.25)!;
    expect(b.x0).toBeCloseTo(10 - 5, 9);
    expect(b.x1).toBeCloseTo(30 + 5, 9);
    expect(b.y0).toBeCloseTo(20 - 10, 9);
    expect(b.y1).toBeCloseTo(60 + 10, 9);
  });

  it("矩形が画像の外へ出ても落ちない", () => {
    const v = new Float32Array(16).fill(5);
    v[0] = 0;
    expect(() => opacifiedAreaInRect(v, 4, 4, { x0: -10, y0: -10, x1: 100, y1: 100 })).not.toThrow();
    expect(opacifiedAreaInRect(v, 4, 4, { x0: 3, y0: 3, x1: 3, y1: 3 })).toBe(0);
  });

  it("🚨 ED→ES が生理的にありえない間隔なら警告する", () => {
    // 実データで「3 フレーム（120ms）しか離れていない ED/ES」が提案された。
    // 指標が心室を見ていないことのサインなので、黙って通さない。
    const c = [10, 90, 100, 95, 92, 96, 99, 94];
    const s = suggestEdEs(c, { frameIntervalMs: 25 })!;
    expect(Math.abs(s.es - s.ed) * 25).toBeLessThan(120);
    expect(s.warnings).toContain("implausibleInterval");
  });

  it("妥当な間隔なら警告しない", () => {
    const c: number[] = [];
    for (let i = 0; i < 40; i++) c.push(100 - 30 * (1 - Math.cos((2 * Math.PI * i) / 20)) / 2);
    const s = suggestEdEs(c, { frameIntervalMs: 25 })!;
    expect(s.warnings).not.toContain("implausibleInterval");
  });

  it("フレーム間隔を渡さなければ検査しない（誤った警告を出さない）", () => {
    const s = suggestEdEs([10, 90, 100, 95, 92, 96, 99, 94])!;
    expect(s.warnings).not.toContain("implausibleInterval");
  });
});
