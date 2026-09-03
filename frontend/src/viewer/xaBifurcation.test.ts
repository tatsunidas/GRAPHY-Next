import { describe, expect, it } from "vitest";
import {
  analyzeBifurcation,
  suggestBifurcationWorkingAngles,
  ENDPOINT_SPREAD_LIMIT_MM,
  type BifurcationBranchInput,
} from "./xaBifurcation";
import { viewSeparationDeg, type Vec3, type XaViewGeometry } from "./xaGeometry";
import { type CrossSectionProfile } from "./xaRecon3d";

/**
 * 分岐部 QCA（A6b・`fw/angio-design.md` §21.4）の数値検証。
 *
 * <p>真値既知の合成分岐で測る。**45° で分岐する枝**を使うので、
 * 角度の約束（すべて「カリーナから出ていく向き」）が正しければ
 * 遠位↔側枝 = 45°、近位↔側枝 = 135°、近位↔遠位 = 180° になる。
 */

/** 一定径の直線枝。`from` から `dir` 方向へ `lengthMm`。 */
function straight(from: Vec3, dir: Vec3, lengthMm: number, diameterMm: number | ((t: number) => number), n = 40) {
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  const u: Vec3 = [dir[0] / len, dir[1] / len, dir[2] / len];
  const points: Vec3[] = [];
  const sections: CrossSectionProfile["sections"] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const s = t * lengthMm;
    points.push([from[0] + u[0] * s, from[1] + u[1] * s, from[2] + u[2] * s]);
    const d = typeof diameterMm === "number" ? diameterMm : diameterMm(t);
    sections.push({
      diameterAMm: d,
      diameterBMm: d,
      areaMm2: (Math.PI / 4) * d * d,
      equivalentDiameterMm: d,
      measurementAngleDeg: 90,
    });
  }
  const profile: CrossSectionProfile = {
    sections,
    minEquivalentDiameterMm: null,
    minIndex: null,
    minAreaMm2: null,
    medianMeasurementAngleDeg: 90,
    unavailable: null,
  };
  return { points, profile };
}

/** 近位母血管 3.0mm（カリーナへ向かう）／遠位 2.6mm／側枝 2.0mm・45° 分岐。 */
function bifurcation(opts?: { sideDiameter?: number; distalStenosis?: boolean }): BifurcationBranchInput[] {
  const carina: Vec3 = [0, 0, 0];
  // 近位は −x から来る（点列はカリーナで終わる）。
  const prox = straight([-30, 0, 0], [1, 0, 0], 30, 3.0);
  // 遠位はそのまま +x。50% 狭窄を中央に置ける。
  const dist = straight(carina, [1, 0, 0], 30, opts?.distalStenosis ? (t) => (t > 0.4 && t < 0.6 ? 1.3 : 2.6) : 2.6);
  // 側枝は +x から 45° 振る。
  const sideDir: Vec3 = [Math.SQRT1_2, Math.SQRT1_2, 0];
  const side = straight(carina, sideDir, 25, opts?.sideDiameter ?? 2.0);
  return [
    { id: "proximal", ...prox },
    { id: "distal", ...dist },
    { id: "side", ...side },
  ];
}

describe("★analyzeBifurcation — 分岐部（真値既知の合成分岐）", () => {
  it("カリーナは幾何から決まる（端点の重心ではない・段 4）", () => {
    const r = analyzeBifurcation(bifurcation())!;
    expect(r.carinaSource).toBe("geometry");
    expect(r.inscribedRadiusMm).not.toBeNull();
    // 真の分岐は原点。内接球の中心は**定義が違う**ので厳密には一致しない
    // （文献の POB は「3 本の輪郭に接する最大円の中心」で、分岐点そのものではない）。
    // 意味のある近さに居ることだけを固定する。
    expect(Math.hypot(...r.carina)).toBeLessThan(0.5);
  });

  it("🔴 端をどこで描き終えてもカリーナが動かない（旧方式はここで壊れていた）", () => {
    // 🚨 2026-09-02 の失敗の再発防止（§21.4.0）。端点の重心でカリーナを決めていたときは、
    //    カリーナ側の点を削るとカリーナ自体が動き、除外域も角度の窓も別の場所を指した。
    const base = analyzeBifurcation(bifurcation())!;
    const trimmed = analyzeBifurcation(
      bifurcation().map((b) => ({
        ...b,
        points: b.id === "proximal" ? b.points.slice(0, -3) : b.points.slice(3),
        profile: {
          ...b.profile,
          sections: b.id === "proximal" ? b.profile.sections.slice(0, -3) : b.profile.sections.slice(3),
        },
      })),
    )!;
    const shift = Math.hypot(
      trimmed.carina[0] - base.carina[0],
      trimmed.carina[1] - base.carina[1],
      trimmed.carina[2] - base.carina[2],
    );
    expect(shift).toBeLessThan(0.3);
  });

  it("角度の約束どおりに出る（遠位↔側枝 45° ＝ いわゆる分岐角）", () => {
    const r = analyzeBifurcation(bifurcation())!;
    expect(r).not.toBeNull();
    // ⚠️ 許容は 0.2°。**カリーナを幾何で決めるようにした（段 4）ぶんだけ動く**
    //    （実測 45.000° → 44.946°）。角度は「カリーナから 5mm の窓」で測るので、
    //    カリーナが 0.1mm 動けば角度も動く。0.05° は測っている量に対して無意味に細かい。
    expect(r.angles.distalToSideDeg!).toBeCloseTo(45, 0.7);
    expect(r.angles.proximalToSideDeg!).toBeCloseTo(135, 0.7);
    expect(r.angles.proximalToDistalDeg!).toBeCloseTo(180, 0.7);
  });

  it("🔴 カリーナのすぐ近くの点が揺れても分岐角がずれない（単位ベクトルの平均にしない）", () => {
    // 3D 再構成の点列は 0.1〜0.2mm 刻みで並ぶ。カリーナから 0.15mm の点が 0.05mm 横に
    // ずれるだけで、その点だけを見た向きは 18° 振れる——**向きの情報を持たない点**。
    // 単位ベクトルを等重みで平均すると、その 18° が 5mm 先の点と対等に効いて角度が狂う
    // （実機で分岐角が真値 +8.7° になった原因）。
    // 端点そのものは動かさない（動かすとカリーナの位置まで変わり、別の話が混ざる）。
    const jittered = bifurcation().map((x) => ({
      ...x,
      points: x.points.map((p) => {
        const d = Math.hypot(p[0], p[1], p[2]);
        return d > 1e-6 && d <= 1.0 ? ([p[0], p[1] + 0.05, p[2] + 0.05] as Vec3) : p;
      }),
    }));
    const r = analyzeBifurcation(jittered)!;
    // 距離で重み付けしていれば 1° 以内に収まる。単位ベクトルの平均だと数度ずれる。
    expect(Math.abs(r.angles.distalToSideDeg! - 45)).toBeLessThan(1);
    expect(Math.abs(r.angles.proximalToSideDeg! - 135)).toBeLessThan(1);
    expect(Math.abs(r.angles.proximalToDistalDeg! - 180)).toBeLessThan(1);
  });

  it("🚨 娘枝が母血管より太く出たら警告する（＝母血管に乗って測っている）", () => {
    // 分岐で娘枝が母血管より太いことは無い。それでも太く出るのは、投影で母血管と
    // 重なった区間を追跡・計測しているから（実機で真値 2.1mm の側枝が 3.11mm と出た）。
    const r = analyzeBifurcation(bifurcation({ sideDiameter: 4.0 }))!;
    const w = r.warnings.find((x) => x.code === "daughterWiderThanMother");
    expect(w).toBeTruthy();
    expect(w!.branch).toBe("side");
    expect(w!.value).toBeGreaterThan(w!.threshold);
  });

  it("娘枝が母血管より細ければ警告しない", () => {
    const r = analyzeBifurcation(bifurcation())!;
    expect(r.warnings.find((x) => x.code === "daughterWiderThanMother")).toBeUndefined();
  });

  it("カリーナは 3 本の端点の重心で、ばらつきが小さければ警告しない", () => {
    const r = analyzeBifurcation(bifurcation())!;
    expect(Math.hypot(...r.carina)).toBeLessThan(0.5);
    expect(r.endpointSpreadMm).toBeLessThan(0.5);
    expect(r.warnings).toHaveLength(0);
  });

  it("🚨 3 本が別の分岐を指していたら警告する（黙って重心を取らない）", () => {
    const b = bifurcation();
    // 側枝だけ 6mm ずれた場所から引いた。
    const shifted = b.map((x) =>
      x.id === "side" ? { ...x, points: x.points.map((p) => [p[0], p[1] + 6, p[2]] as Vec3) } : x,
    );
    const r = analyzeBifurcation(shifted)!;
    const w = r.warnings.find((x) => x.code === "endpointsApart");
    expect(w).toBeTruthy();
    expect(w!.value).toBeGreaterThan(ENDPOINT_SPREAD_LIMIT_MM);
  });

  it("★カリーナ周辺を測らない（母血管 1 径ぶん・除外した長さを出す）", () => {
    const r = analyzeBifurcation(bifurcation())!;
    // 母血管 3.0mm → 除外半径 3.0mm。
    expect(r.confluenceRadiusMm).toBeCloseTo(3.0, 6);
    for (const b of r.branches) {
      expect(b.excludedLengthMm).toBeGreaterThan(2.0);
      expect(b.measuredPoints).toBeGreaterThan(10);
    }
  });

  it("除外の範囲は係数で変えられ、変えた分だけ測る範囲が減る", () => {
    const wide = analyzeBifurcation(bifurcation(), { confluenceFactor: 2 })!;
    const narrow = analyzeBifurcation(bifurcation(), { confluenceFactor: 0.5 })!;
    expect(wide.confluenceRadiusMm).toBeCloseTo(6, 6);
    for (let i = 0; i < 3; i++) {
      expect(wide.branches[i].measuredPoints).toBeLessThan(narrow.branches[i].measuredPoints);
    }
  });

  it("参照径は枝ごとに立つ（1 本の回帰で通さない）", () => {
    const r = analyzeBifurcation(bifurcation())!;
    const byId = Object.fromEntries(r.branches.map((b) => [b.id, b]));
    expect(byId.proximal.rvdMm!).toBeCloseTo(3.0, 1);
    expect(byId.distal.rvdMm!).toBeCloseTo(2.6, 1);
    expect(byId.side.rvdMm!).toBeCloseTo(2.0, 1);
    // 段差を 1 本の回帰で通すと、この 3 つは互いに寄ってしまう。
    expect(byId.proximal.rvdMm! - byId.side.rvdMm!).toBeGreaterThan(0.8);
  });

  it("枝ごとに %DS が出る（遠位に 50% 狭窄）", () => {
    const r = analyzeBifurcation(bifurcation({ distalStenosis: true }))!;
    const byId = Object.fromEntries(r.branches.map((b) => [b.id, b]));
    expect(byId.distal.percentDiameterStenosis!).toBeGreaterThan(45);
    expect(byId.distal.percentDiameterStenosis!).toBeLessThan(55);
    expect(byId.proximal.percentDiameterStenosis!).toBeLessThan(5);
    expect(byId.side.percentDiameterStenosis!).toBeLessThan(5);
  });

  it("★Finet / Murray は差を出すだけで、径を書き換えない", () => {
    const r = analyzeBifurcation(bifurcation())!;
    // Finet: 0.678 × (2.6 + 2.0) = 3.119 に対し実測 3.0 → −3.8%
    expect(r.consistency.finet!.expectedMm).toBeCloseTo(3.119, 2);
    expect(r.consistency.finet!.measuredMm).toBeCloseTo(3.0, 1);
    expect(r.consistency.finet!.deviationPercent).toBeCloseTo(-3.8, 0);
    // Murray: (2.6³ + 2.0³)^(1/3) = (17.576 + 8)^(1/3) = 2.946
    expect(r.consistency.murray!.expectedMm).toBeCloseTo(2.946, 2);
    // ★ 実測の参照径は式に寄せられていない（推定に使っていない）。
    const byId = Object.fromEntries(r.branches.map((b) => [b.id, b]));
    expect(byId.proximal.rvdMm!).toBeCloseTo(3.0, 1);
  });

  it("Medina 分類は出さない（%DS だけを出して分類は人に委ねる）", () => {
    const r = analyzeBifurcation(bifurcation({ distalStenosis: true }))! as unknown as Record<string, unknown>;
    expect(Object.keys(r)).not.toContain("medina");
    expect(JSON.stringify(r)).not.toMatch(/medina/i);
  });

  it("枝が 3 本そろっていなければ null（黙って 2 本で分岐を測らない）", () => {
    const b = bifurcation();
    expect(analyzeBifurcation(b.slice(0, 2))).toBeNull();
    expect(analyzeBifurcation([b[0], b[1], { ...b[2], id: "distal" }])).toBeNull();
  });

  it("断面が無い枝は測れないと出す（0 で埋めない）", () => {
    const b = bifurcation();
    const noSections = b.map((x) =>
      x.id === "side"
        ? { ...x, profile: { ...x.profile, sections: x.profile.sections.map(() => null) } }
        : x,
    );
    const r = analyzeBifurcation(noSections)!;
    const side = r.branches.find((x) => x.id === "side")!;
    expect(side.mldMm).toBeNull();
    expect(side.percentDiameterStenosis).toBeNull();
    expect(r.warnings.some((w) => w.code === "noSections" && w.branch === "side")).toBe(true);
    // 他の枝は測れている。
    expect(r.branches.find((x) => x.id === "distal")!.mldMm).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* ワーキングアングル（分岐部）                                        */
/* ------------------------------------------------------------------ */

/**
 * 合成分岐は **z = 0 の平面**に置いてある（近位・遠位は ±x、側枝は x-y 面内で 45°）。
 * したがって
 * - 視線が平面の中にある（例 primary 0° / secondary 0° ＝ 患者の前から）と
 *   **遠位と側枝が完全に重なって見える**。短縮は小さいので「短縮だけ」で選ぶとここが上位に来る。
 * - 視線を平面から起こす（secondary を振る）と 2 本が離れて見える。
 * この 2 つを取り違えないことが、この関数の存在理由そのもの。
 */
const BASE_GEOMETRY: XaViewGeometry = {
  primaryAngleDeg: 0,
  secondaryAngleDeg: 0,
  sidMm: 1000,
  sodMm: 750,
  imagerSpacingMm: [0.2, 0.2],
  principalPoint: [512, 512],
};

/** カリーナ = 原点、除外半径 = 母血管 1 径ぶん（analyzeBifurcation の既定と同じ）。 */
function suggest(
  branches: BifurcationBranchInput[],
  opts?: Parameters<typeof suggestBifurcationWorkingAngles>[4],
) {
  return suggestBifurcationWorkingAngles(branches, [0, 0, 0], 3.0, BASE_GEOMETRY, opts);
}

describe("★suggestBifurcationWorkingAngles — 分岐部のワーキングアングル", () => {
  it("🔴 短縮だけなら上位に来る「正面（0°/0°）」を、重なりを見て外す", () => {
    const branches = bifurcation();

    // 正面は 3 本とも大きくは潰れていない（母血管は視線に直交＝1.0）。
    const front = suggest(branches, { count: 400, minSpreadDeg: 0 }).concat(
      // 候補から落ちていても値を確かめられるように、1 点だけを走査して取り直す。
      suggest(branches, { primaryRangeDeg: 0, secondaryRangeDeg: 0, count: 1, minSpreadDeg: 0 }),
    );
    const at00 = front.find((c) => c.primaryAngleDeg === 0 && c.secondaryAngleDeg === 0)!;
    expect(at00).toBeDefined();
    expect(at00.minVisibleFraction).toBeGreaterThan(0.7); // 潰れてはいない
    // …が、遠位と側枝が丸ごと重なる。
    expect(at00.overlapLengthMm).toBeGreaterThan(15);
    expect(at00.score).toBe(0);

    // 実際に返る候補は重なっていない。
    const top = suggest(branches)[0];
    expect(top.overlapLengthMm).toBeLessThan(5);
    expect(top.minVisibleFraction).toBeGreaterThan(0.7);
    expect(Math.abs(top.secondaryAngleDeg)).toBeGreaterThanOrEqual(20);
  });

  it("候補は互いに離れた方向になる（隣の格子点を 3 つ並べない）", () => {
    const out = suggest(bifurcation(), { count: 3 });
    expect(out.length).toBe(3);
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const sep = viewSeparationDeg(
          { ...BASE_GEOMETRY, primaryAngleDeg: out[i].primaryAngleDeg, secondaryAngleDeg: out[i].secondaryAngleDeg },
          { ...BASE_GEOMETRY, primaryAngleDeg: out[j].primaryAngleDeg, secondaryAngleDeg: out[j].secondaryAngleDeg },
        );
        expect(sep).toBeGreaterThanOrEqual(15);
      }
    }
  });

  it("重なっている 2 枝を必ず名指しする（「どこかが重なっている」では直しようがない）", () => {
    const out = suggest(bifurcation(), { count: 1 });
    expect(out[0].overlapPair).toHaveLength(2);
    expect(out[0].overlapPair[0]).not.toBe(out[0].overlapPair[1]);
    expect(out[0].overlapLengthMm).toBeGreaterThanOrEqual(0);
  });

  it("母血管に沿って見る角度（LAO 90°）は候補にならない（3 本とも潰れる）", () => {
    const along = suggest(bifurcation(), {
      primaryRangeDeg: 90,
      secondaryRangeDeg: 0,
      stepDeg: 90,
      count: 5,
      minSpreadDeg: 0,
    });
    const at90 = along.find((c) => c.primaryAngleDeg === 90)!;
    expect(at90.minVisibleFraction).toBeLessThan(0.05); // 視線 = 母血管の向き
    expect(at90.score).toBe(0);
    // 既定の探索では返らない。
    const out = suggest(bifurcation(), { count: 3 });
    for (const c of out) expect(c.minVisibleFraction).toBeGreaterThan(0.5);
  });

  it("径が出せない枝があると中心線どうしで判定し、それを申告する（黙って細い血管として扱わない）", () => {
    const b = bifurcation().map((x) =>
      x.id === "side"
        ? { ...x, profile: { ...x.profile, sections: x.profile.sections.map(() => null) } }
        : x,
    );
    const out = suggest(b, { count: 1 });
    expect(out[0].edgeAware).toBe(false);
    // 太さが分からない枝を 0 で埋めていない（埋めると重なりが過小に出る）。
    const full = suggest(bifurcation(), { count: 1 });
    expect(full[0].edgeAware).toBe(true);
  });

  it("枝が 3 本そろっていなければ候補を返さない", () => {
    expect(suggest(bifurcation().slice(0, 2))).toEqual([]);
  });

  it("除外域が枝を食い尽くしたら候補を返さない（測れない範囲で角度を決めない）", () => {
    expect(
      suggestBifurcationWorkingAngles(bifurcation(), [0, 0, 0], 100, BASE_GEOMETRY),
    ).toEqual([]);
  });
});
