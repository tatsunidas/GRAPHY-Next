import { describe, expect, it } from "vitest";
import {
  calibrationScaleFor,
  isXaCalibrated,
  resolveXaCalibration,
  toViewerSpatialCalibration,
  type XaCalibTags,
} from "./xaCalibration";

/**
 * XA の空間校正フォールバック連鎖（fw/angio-design.md §7.2）。
 *
 * <p>ここが崩れると「未校正なのに mm が出る（倍率ぶん過大）」か
 * 「装置が校正した値を捨てて粗い近似で上書きする」のどちらかになる。
 * どちらも画面上は普通に見えるので、**分岐を全部テストで押さえる**。
 */

const IMAGER = [0.279, 0.279] as const;

function tags(over: Partial<XaCalibTags> = {}): XaCalibTags {
  return { imagerPixelSpacing: IMAGER, ...over };
}

describe("P1/P2 — 装置が校正済み（CalibrationType あり）", () => {
  it("FIDUCIAL はそのまま使う（信頼度 high・fiducial 深さで有効）", () => {
    const c = resolveXaCalibration(
      tags({
        pixelSpacing: [0.213, 0.213],
        pixelSpacingCalibrationType: "FIDUCIAL",
        pixelSpacingCalibrationDescription: "6Fr catheter",
      }),
    );
    expect(c.source).toBe("dicom-fiducial");
    expect(c.mmPerPxCol).toBe(0.213);
    expect(c.confidence).toBe("high");
    expect(c.plane).toBe("fiducial-depth");
    expect(c.tier).toBe("calibrated");
    expect(c.provenance).toContain("FIDUCIAL");
    expect(c.provenance).toContain("6Fr catheter");
  });

  it("GEOMETRY は「近似」扱い（中心線と同じ深さでのみ有効）", () => {
    const c = resolveXaCalibration(tags({ pixelSpacing: [0.24, 0.24], pixelSpacingCalibrationType: "geometry" }));
    expect(c.source).toBe("dicom-geometry");
    expect(c.confidence).toBe("medium");
    expect(c.plane).toBe("central-ray");
    expect(c.tier).toBe("approximate");
  });

  it("種別が明記されていても値が検出器面と同値なら警告を立てる", () => {
    const c = resolveXaCalibration(
      tags({ pixelSpacing: [...IMAGER] as [number, number], pixelSpacingCalibrationType: "GEOMETRY" }),
    );
    expect(c.source).toBe("dicom-geometry");
    expect(c.warnings).toContain("pixelSpacingEqualsImager");
  });
});

describe("P3 / P3' — CalibrationType が無い PixelSpacing", () => {
  it("検出器面と異なるなら「補正済み」とみなすが、種別欠落を警告する", () => {
    const c = resolveXaCalibration(tags({ pixelSpacing: [0.21, 0.21] }));
    expect(c.source).toBe("dicom-calibrated-unspecified");
    expect(c.tier).toBe("approximate");
    expect(c.plane).toBe("unknown");
    expect(c.warnings).toContain("calibrationTypeMissing");
  });

  it("★検出器面と同値なら規格の明文どおり『未校正』として降格する", () => {
    // ここが本連鎖の肝。ベンダが ImagerPixelSpacing をコピーしただけの PixelSpacing を
    // 校正済みと信じると、患者内の mm が倍率ぶん（典型 1.1〜1.4 倍）過大になる。
    const c = resolveXaCalibration(
      tags({ pixelSpacing: [...IMAGER] as [number, number], distanceSourceToDetector: null, distanceSourceToPatient: null }),
    );
    expect(c.source).toBe("detector-plane");
    expect(c.tier).toBe("uncalibrated");
    expect(c.mmPerPxCol).toBeNull();
    expect(c.warnings).toContain("pixelSpacingEqualsImager");
    // 値そのものは捨てない（ツールチップに出す）。
    expect(c.detectorMmPerPx).toBe(IMAGER[1]);
  });

  it("同値でも SID/SOD があれば幾何近似まで落ちる（未校正で止まらない）", () => {
    const c = resolveXaCalibration(
      tags({
        pixelSpacing: [...IMAGER] as [number, number],
        distanceSourceToDetector: 1000,
        distanceSourceToPatient: 750,
      }),
    );
    expect(c.source).toBe("geometric-sid-sod");
    expect(c.mmPerPxCol).toBeCloseTo(0.279 * 0.75, 10);
  });

  it("ImagerPixelSpacing が無ければ比較できないので降格しない", () => {
    const c = resolveXaCalibration({ pixelSpacing: [0.279, 0.279] });
    expect(c.source).toBe("dicom-calibrated-unspecified");
    expect(c.mmPerPxCol).toBe(0.279);
  });
});

describe("P4/P5 — 幾何近似", () => {
  it("SID/SOD から mm/px = Imager × SOD/SID", () => {
    const c = resolveXaCalibration(tags({ distanceSourceToDetector: 1000, distanceSourceToPatient: 700 }));
    expect(c.source).toBe("geometric-sid-sod");
    expect(c.mmPerPxCol).toBeCloseTo(0.1953, 4);
    expect(c.confidence).toBe("low");
    expect(c.plane).toBe("isocenter");
    expect(c.tier).toBe("approximate");
  });

  it("SID/SOD が無ければ推定拡大率を使う", () => {
    const c = resolveXaCalibration(tags({ estimatedRadiographicMagnificationFactor: 1.4 }));
    expect(c.source).toBe("geometric-magfactor");
    expect(c.mmPerPxCol).toBeCloseTo(0.279 / 1.4, 10);
  });

  it("両方あるときは SID/SOD（実測）を優先する", () => {
    const c = resolveXaCalibration(
      tags({ distanceSourceToDetector: 1000, distanceSourceToPatient: 700, estimatedRadiographicMagnificationFactor: 1.4285 }),
    );
    expect(c.source).toBe("geometric-sid-sod");
  });

  it("SID/SOD 由来と拡大率由来が 5% 以上食い違ったら警告する", () => {
    const c = resolveXaCalibration(
      tags({ distanceSourceToDetector: 1000, distanceSourceToPatient: 700, estimatedRadiographicMagnificationFactor: 1.0 }),
    );
    expect(c.warnings).toContain("sidSodDiffersFromMagFactor");
  });

  it("SOD だけ / SID だけでは組めない → 検出器面まで落ちる", () => {
    const c = resolveXaCalibration(tags({ distanceSourceToPatient: 700 }));
    expect(c.source).toBe("detector-plane");
    expect(c.tier).toBe("uncalibrated");
  });
});

describe("P6/P7 — 校正できないとき", () => {
  it("ImagerPixelSpacing だけなら未校正（mm を出さない）", () => {
    const c = resolveXaCalibration(tags());
    expect(c.source).toBe("detector-plane");
    expect(isXaCalibrated(c)).toBe(false);
    expect(c.detectorMmPerPx).toBe(IMAGER[1]);
  });

  it("何も無ければ none", () => {
    const c = resolveXaCalibration({});
    expect(c.source).toBe("none");
    expect(c.tier).toBe("uncalibrated");
    expect(isXaCalibrated(c)).toBe(false);
  });

  it("0 や負の値は「無い」と同じ扱い", () => {
    const c = resolveXaCalibration({ pixelSpacing: [0, 0], imagerPixelSpacing: [-1, -1] });
    expect(c.source).toBe("none");
  });
});

describe("P0 — 人が確定した校正", () => {
  it("常に最優先（装置が FIDUCIAL で校正済みでも人が勝つ）", () => {
    const c = resolveXaCalibration(
      tags({ pixelSpacing: [0.213, 0.213], pixelSpacingCalibrationType: "FIDUCIAL" }),
      { mmPerPx: 0.2, method: "catheter", note: "6Fr（造影あり）" },
    );
    expect(c.source).toBe("user-catheter");
    expect(c.mmPerPxCol).toBe(0.2);
    expect(c.tier).toBe("calibrated");
    expect(c.provenance).toContain("6Fr");
  });

  it("装置の校正値と 10% 以上ずれたら警告する（黙って上書きしない）", () => {
    const c = resolveXaCalibration(
      tags({ pixelSpacing: [0.213, 0.213], pixelSpacingCalibrationType: "FIDUCIAL" }),
      { mmPerPx: 0.3, method: "ruler" },
    );
    expect(c.source).toBe("user-ruler");
    expect(c.warnings).toContain("userDiffersFromDevice");
  });

  it("僅差なら警告しない", () => {
    const c = resolveXaCalibration(
      tags({ pixelSpacing: [0.213, 0.213], pixelSpacingCalibrationType: "FIDUCIAL" }),
      { mmPerPx: 0.215, method: "catheter" },
    );
    expect(c.warnings).not.toContain("userDiffersFromDevice");
  });

  it("不正な mmPerPx は無視して通常の連鎖に落ちる", () => {
    const c = resolveXaCalibration(tags({ pixelSpacing: [0.21, 0.21] }), { mmPerPx: 0, method: "ruler" });
    expect(c.source).toBe("dicom-calibrated-unspecified");
  });
});

describe("非等方 spacing", () => {
  it("row ≠ col を潰さずに保持し、警告を立てる", () => {
    const c = resolveXaCalibration({
      pixelSpacing: [0.2, 0.25],
      pixelSpacingCalibrationType: "FIDUCIAL",
    });
    expect(c.mmPerPxRow).toBe(0.2);
    expect(c.mmPerPxCol).toBe(0.25);
    expect(c.warnings).toContain("anisotropic");
  });

  it("等方なら警告しない", () => {
    const c = resolveXaCalibration({ pixelSpacing: [0.2, 0.2], pixelSpacingCalibrationType: "FIDUCIAL" });
    expect(c.warnings).not.toContain("anisotropic");
  });

  it("1 要素しか無い spacing は 2 要素目を同値で補う（readXaCalibTags 側の契約）", () => {
    const c = resolveXaCalibration({ pixelSpacing: [0.2, 0.2], pixelSpacingCalibrationType: "FIDUCIAL" });
    expect(c.mmPerPxRow).toBe(c.mmPerPxCol);
  });
});

describe("calibrationScaleFor — 計測ツールへ渡す倍率", () => {
  it("PixelSpacing が無い（world=px）＋カテーテル校正 → px/mm 比になる", () => {
    // 318px の線を 2mm と校正 → mmPerPx = 0.006289…。scale = 1 / 0.006289 = 159
    const mmPerPx = 2 / 318;
    expect(calibrationScaleFor(null, mmPerPx)).toBeCloseTo(159, 0);
    // 表示値 = world(318) / scale = 2.0mm
    expect(318 / calibrationScaleFor(null, mmPerPx)).toBeCloseTo(2, 6);
  });

  it("★DICOM の PixelSpacing をそのまま使う場合は 1（二重適用しない）", () => {
    expect(calibrationScaleFor(0.2, 0.2)).toBeCloseTo(1, 12);
  });

  it("未校正なら loaderSpacing をそのまま返す（px 表示へ戻す）", () => {
    // world が 0.279mm 刻みでも、px 表示にするには 0.279 で割る。
    expect(calibrationScaleFor(0.279, null)).toBeCloseTo(0.279, 12);
    expect(calibrationScaleFor(null, null)).toBe(1);
  });

  it("不正値は 1 として扱う", () => {
    expect(calibrationScaleFor(0, null)).toBe(1);
    expect(calibrationScaleFor(-1, 0.2)).toBeCloseTo(1 / 0.2, 12);
  });
});

/**
 * プラグインへ渡す形（host API の H35）。
 *
 * <p>ここで守るのは 1 つだけ——**未校正を数値で埋めないこと**。プラグインは受け取った
 * mm/px で径を出すので、検出器面の値を流し込むと**未校正の画像が mm で測られる**。
 * 値はそれらしいので、画面にも数値にも異常が出ない（＝誰も気付けない）。
 */
describe("★H35 — プラグインへ渡す校正（出自ごと渡す）", () => {
  it("未校正では mm/px を null のまま渡す（検出器面の値で埋めない）", () => {
    // ImagerPixelSpacing しか無い＝P6。検出器面の値は持っているが被写体の mm/px ではない。
    const c = resolveXaCalibration(tags());
    expect(isXaCalibrated(c)).toBe(false);
    const v = toViewerSpatialCalibration("img#1", c);
    expect(v.mmPerPxRow).toBeNull();
    expect(v.mmPerPxCol).toBeNull();
    expect(v.tier).toBe("uncalibrated");
    // 捨てはしない。**別のフィールドで**渡す（ツールチップ用）。
    expect(v.detectorMmPerPx).toBeCloseTo(0.279, 6);
  });

  it("出自・信頼度・警告をそのまま渡す（数値だけにしない）", () => {
    const c = resolveXaCalibration(
      tags({ pixelSpacing: [0.21, 0.21], pixelSpacingCalibrationType: "fiducial" }),
    );
    const v = toViewerSpatialCalibration("img#2", c);
    expect(v.mmPerPxRow).toBeCloseTo(0.21, 6);
    expect(v.source).toBe("dicom-fiducial");
    expect(v.confidence).toBe("high");
    expect(v.tier).toBe("calibrated");
    expect(v.provenance).not.toBe("");
    expect(Array.isArray(v.warnings)).toBe(true);
  });

  it("幾何近似は approximate として渡す（「近似」と書けるようにする）", () => {
    const c = resolveXaCalibration(
      tags({
        pixelSpacing: [...IMAGER] as [number, number],
        distanceSourceToDetector: 1000,
        distanceSourceToPatient: 750,
      }),
    );
    const v = toViewerSpatialCalibration("img#3", c);
    expect(v.tier).toBe("approximate");
    expect(v.source).toBe("geometric-sid-sod");
    expect(v.mmPerPxRow).toBeCloseTo(0.279 * 750 / 1000, 6);
  });

  it("警告は写しを渡す（受け手が本体の配列を書き換えられない）", () => {
    const c = resolveXaCalibration(
      tags({ pixelSpacing: [0.279, 0.279] }), // ImagerPixelSpacing と同値＝未補正の警告が立つ
    );
    const v = toViewerSpatialCalibration("img#4", c);
    v.warnings.push("tampered" as never);
    expect(c.warnings).not.toContain("tampered");
  });
});
