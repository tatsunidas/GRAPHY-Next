/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * IVUS プルバックの対応づけ（`fw/angio-design.md` §12 / A8）。
 *
 * <p>ここが 1 フレームずれても**画面は普通に動く**（少し違う断層が出るだけ）。
 * 目視では気付けない類いなので、テストでしか守れない。
 */
import { describe, expect, it, vi } from "vitest";

// ⚠️ タグ読み取りのために `xaCine` 経由で Cornerstone のローダが読み込まれる。
//    ここでは純関数だけを検証するので偽物に差し替える（`xaCine.test.ts` と同じ作法）。
vi.mock("@cornerstonejs/dicom-image-loader", () => ({
  internal: { xhrRequest: vi.fn() },
  wadouri: { dataSetCacheManager: { isLoaded: vi.fn(), load: vi.fn(), get: vi.fn() } },
}));

const {
  distanceForFrame,
  frameForDistance,
  pathLengthMm,
  pathLengthRatio,
  pointAtDistance,
  pullbackGeometry,
} = await import("./ivusSync");
type PullbackGeometry = import("./ivusSync").PullbackGeometry;
type PullbackSource = import("./ivusSync").PullbackSource;

/** GNBP-IVUS ファントムと同じ諸元。 */
const PHANTOM: PullbackSource = {
  numberOfFrames: 610,
  pullbackRateMmPerS: 0.5,
  frameRate: 30,
  startFrameNumber: 61, // 1 origin
  stopFrameNumber: 610,
};

function geom(src: PullbackSource = PHANTOM): PullbackGeometry {
  const r = pullbackGeometry(src);
  if ("unavailable" in r) throw new Error(`幾何が出せない: ${r.unavailable}`);
  return r.geometry;
}

describe("pullbackGeometry", () => {
  it("開始・停止フレームを 1 origin から 0 origin へ直す", () => {
    // 🔴 直し忘れると全体が 1 フレームぶんずれる。小さいので目視では気付けない。
    const g = geom();
    expect(g.startFrame).toBe(60);
    expect(g.stopFrame).toBe(609);
  });

  it("引き抜き区間の長さを出す", () => {
    // (609 − 60) / 30 × 0.5 = 9.15mm（ファントムの truth と一致）
    expect(geom().lengthMm).toBeCloseTo(9.15, 6);
  });

  it("🔴 引き抜き速度が無ければ距離を出さない（既定値で埋めない）", () => {
    const r = pullbackGeometry({ ...PHANTOM, pullbackRateMmPerS: null });
    expect(r).toEqual({ unavailable: "noPullbackRate" });
  });

  it("🔴 フレームレートが無ければ距離を出さない", () => {
    const r = pullbackGeometry({ ...PHANTOM, frameRate: 0 });
    expect(r).toEqual({ unavailable: "noFrameRate" });
  });

  it("開始・停止が無ければ全区間として扱う", () => {
    const g = geom({ numberOfFrames: 100, pullbackRateMmPerS: 1, frameRate: 10 });
    expect(g.startFrame).toBe(0);
    expect(g.stopFrame).toBe(99);
  });

  it("開始と停止が逆でも壊れない（小さい方を開始にする）", () => {
    const g = geom({ ...PHANTOM, startFrameNumber: 610, stopFrameNumber: 61 });
    expect(g.startFrame).toBe(60);
    expect(g.stopFrame).toBe(609);
  });
});

describe("distanceForFrame（ランドマーク無し＝一定速度）", () => {
  it("ファントムのマーカー位置と一致する", () => {
    // truth.json: 1mm→フレーム 120(0 origin), 3mm→240, 5mm→360, 7mm→480, 9mm→600
    const g = geom();
    for (const [frame, mm] of [
      [120, 1],
      [240, 3],
      [360, 5],
      [480, 7],
      [600, 9],
    ] as const) {
      expect(distanceForFrame(g, frame), `frame ${frame}`).toBeCloseTo(mm, 6);
    }
  });

  it("開始フレームで 0mm", () => {
    expect(distanceForFrame(geom(), 60)).toBeCloseTo(0, 9);
  });

  it("🔴 引き抜き前のフレームは負の距離（0 に丸めない）", () => {
    // 丸めると静止区間の数十フレームが全部「始点」に対応づく。
    expect(distanceForFrame(geom(), 0)).toBeCloseTo(-1.0, 6);
    expect(distanceForFrame(geom(), 30)).toBeLessThan(0);
  });
});

describe("distanceForFrame（ランドマークあり＝区分線形）", () => {
  it("ランドマークを必ず通る", () => {
    const g = geom();
    const marks = [
      { frame: 240, distanceMm: 4 }, // 一定速度なら 3mm のところを 4mm と対応づける
      { frame: 480, distanceMm: 8 },
    ];
    expect(distanceForFrame(g, 240, marks)).toBeCloseTo(4, 9);
    expect(distanceForFrame(g, 480, marks)).toBeCloseTo(8, 9);
  });

  it("区間の中は線形に引き伸ばす", () => {
    const g = geom();
    const marks = [
      { frame: 240, distanceMm: 4 },
      { frame: 480, distanceMm: 8 },
    ];
    expect(distanceForFrame(g, 360, marks)).toBeCloseTo(6, 6);
  });

  it("最初のランドマークより手前は開始点との傾きで内挿する", () => {
    const g = geom();
    const marks = [{ frame: 240, distanceMm: 4 }];
    // 開始 60 で 0mm、240 で 4mm → 150 では 2mm。
    expect(distanceForFrame(g, 150, marks)).toBeCloseTo(2, 6);
  });

  it("最後のランドマークより先は直前の区間の傾きで外挿する", () => {
    const g = geom();
    const marks = [
      { frame: 240, distanceMm: 4 },
      { frame: 480, distanceMm: 8 },
    ];
    // 傾きは 4mm / 240 フレーム → 600 では 8 + 2 = 10mm。
    expect(distanceForFrame(g, 600, marks)).toBeCloseTo(10, 6);
  });

  it("ランドマークが 1 個のときは一定速度の傾きで外挿する", () => {
    const g = geom();
    const marks = [{ frame: 240, distanceMm: 4 }];
    // 240 より先は一定速度（0.5mm/s ÷ 30fps）で進む → 360 では 4 + 2 = 6mm。
    expect(distanceForFrame(g, 360, marks)).toBeCloseTo(6, 6);
  });

  it("🚨 同じフレームに違う距離を割り当てた対は使わない（傾きが無限大になる）", () => {
    const g = geom();
    const bad = [
      { frame: 240, distanceMm: 4 },
      { frame: 240, distanceMm: 6 },
    ];
    // 矛盾しているので一定速度へ戻る（黙って片方を選ばない）。
    expect(distanceForFrame(g, 240, bad)).toBeCloseTo(3, 6);
  });

  it("🚨 距離が逆行するランドマークは使わない", () => {
    const g = geom();
    const bad = [
      { frame: 240, distanceMm: 6 },
      { frame: 480, distanceMm: 4 },
    ];
    expect(distanceForFrame(g, 360, bad)).toBeCloseTo(5, 6);
  });
});

describe("frameForDistance（逆引き）", () => {
  it("一定速度では distanceForFrame の逆になる", () => {
    const g = geom();
    for (const frame of [60, 120, 360, 600]) {
      const d = distanceForFrame(g, frame);
      expect(frameForDistance(g, d, 610), `frame ${frame}`).toBe(frame);
    }
  });

  it("範囲外の距離はフレームの端で止める", () => {
    const g = geom();
    expect(frameForDistance(g, -99, 610)).toBe(0);
    expect(frameForDistance(g, 999, 610)).toBe(609);
  });

  it("ランドマークがあっても往復できる", () => {
    const g = geom();
    const marks = [
      { frame: 240, distanceMm: 4 },
      { frame: 480, distanceMm: 8 },
    ];
    for (const frame of [240, 360, 480]) {
      const d = distanceForFrame(g, frame, marks);
      expect(frameForDistance(g, d, 610, marks), `frame ${frame}`).toBe(frame);
    }
  });
});

describe("pointAtDistance", () => {
  /** 100px の直線（x 方向）。0.1mm/px → 10mm。 */
  const path = {
    pointsPx: [
      [0, 0],
      [100, 0],
    ] as const,
    mmPerPx: 0.1,
  };

  it("距離に応じて経路上を進む", () => {
    expect(pointAtDistance(path, 0)!.x).toBeCloseTo(0, 6);
    expect(pointAtDistance(path, 5)!.x).toBeCloseTo(50, 6);
    expect(pointAtDistance(path, 10)!.x).toBeCloseTo(100, 6);
  });

  it("折れ線でも弧長に沿って進む", () => {
    const bent = {
      pointsPx: [
        [0, 0],
        [30, 40], // 長さ 50px
        [30, 90], // 長さ 50px（合計 100px = 10mm）
      ] as const,
      mmPerPx: 0.1,
    };
    const p = pointAtDistance(bent, 5)!;
    expect(p.x).toBeCloseTo(30, 6);
    expect(p.y).toBeCloseTo(40, 6);
  });

  it("🔴 未校正なら null（px の長さを mm と呼ばない）", () => {
    expect(pointAtDistance({ pointsPx: path.pointsPx, mmPerPx: null }, 5)).toBeNull();
    expect(pointAtDistance({ pointsPx: path.pointsPx, mmPerPx: 0 }, 5)).toBeNull();
  });

  it("経路の外へ出る距離は端で止め、その旨を返す", () => {
    const over = pointAtDistance(path, 99)!;
    expect(over.x).toBeCloseTo(100, 6);
    expect(over.clamped).toBe(true);
    const under = pointAtDistance(path, -3)!;
    expect(under.x).toBeCloseTo(0, 6);
    expect(under.clamped).toBe(true);
  });

  it("点が足りなければ null", () => {
    expect(pointAtDistance({ pointsPx: [[0, 0]], mmPerPx: 0.1 }, 1)).toBeNull();
  });
});

describe("pathLengthMm / pathLengthRatio", () => {
  const path = { pointsPx: [[0, 0], [100, 0]] as const, mmPerPx: 0.1 };

  it("経路長を mm で出す", () => {
    expect(pathLengthMm(path)).toBeCloseTo(10, 6);
  });

  it("未校正なら null", () => {
    expect(pathLengthMm({ pointsPx: path.pointsPx, mmPerPx: null })).toBeNull();
  });

  it("🔑 経路長と引き抜き長の食い違いを比で返す（経路の引き間違いの唯一の手掛かり）", () => {
    const g = geom(); // 9.15mm
    expect(pathLengthRatio(path, g)!).toBeCloseTo(10 / 9.15, 4);
    // 経路を 3 倍長く引いてしまった場合。
    const long = { pointsPx: [[0, 0], [300, 0]] as const, mmPerPx: 0.1 };
    expect(pathLengthRatio(long, g)!).toBeGreaterThan(3);
  });
});
