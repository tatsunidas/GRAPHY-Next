/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * XA/XRF の空間校正（px → mm）の**単一入口**（`fw/angio-design.md` §7）。
 *
 * <p>mm を欲しがる箇所（スケールバー・計測ラベル・QCA・3D 再構成）は**全部ここを通す**。
 * 個別に `PixelSpacing` を読む実装を書かないこと。輝度校正の
 * {@link ./pixelCalibration} が「Rescale を二重適用しない」ための単一入口であるのと同じ作法。
 *
 * <h3>なぜ単純な分岐で済まないか</h3>
 * XA の空間校正タグは**すべて Type 3（無くてよい）**で、しかも
 * - `PixelSpacing (0028,0030)` は「**校正済みのときだけ**現れる」（Type 1C。患者内 mm）
 * - `ImagerPixelSpacing (0018,1164)` は「検出器面の間隔。**倍率補正のために調整してはならない**」
 * - 規格の明文: **両者が一致 ⇒ 補正されていない／異なる ⇒ 何らかの補正済み**
 * という関係にある。ベンダによっては `PixelSpacing` に検出器面の値をそのままコピーするため、
 * **一致判定を入れないと未校正の値を校正済みと信じて mm を出す**ことになる。
 *
 * <p>そこで優先度つきのフォールバック連鎖（P0〜P7）として解決し、
 * 「どの経路で決まったか（{@link XaCalibration.source}）」と
 * 「その値が妥当な平面（{@link XaCalibration.plane}）」を**必ず結果に添えて返す**。
 */

/** 校正がどこから来たか。UI とレポートにそのまま出す。 */
export type XaCalibSource =
  /** P0: 人が確定（カテーテル法 / ルーラー法）、または読み込んだ表示状態（GSPS）の値。 */
  | "user-catheter"
  | "user-ruler"
  /** P0: GSPS（他システムが書いた表示状態）の Presentation Pixel Spacing。出自を混ぜない。 */
  | "gsps"
  /** P1: 装置/後処理が既知寸法物体で校正（PixelSpacingCalibrationType = FIDUCIAL）。 */
  | "dicom-fiducial"
  /** P2: 幾何倍率で補正済み（同 = GEOMETRY）。 */
  | "dicom-geometry"
  /** P3: PixelSpacing はあるが校正種別の記載が無い（非準拠だが実在）。 */
  | "dicom-calibrated-unspecified"
  /** P4: ImagerPixelSpacing × SOD/SID の幾何近似。 */
  | "geometric-sid-sod"
  /** P5: ImagerPixelSpacing ÷ 推定拡大率。 */
  | "geometric-magfactor"
  /** P6: 検出器面の値しか無い（**校正できていない**）。 */
  | "detector-plane"
  /** P7: 何も無い。 */
  | "none";

/** その mm/px が妥当な平面。 */
export type XaCalibPlane = "fiducial-depth" | "isocenter" | "central-ray" | "detector" | "unknown";

/** 表示の縮退（§7.4）。 */
export type XaCalibTier = "calibrated" | "approximate" | "uncalibrated";

/** 警告コード（訳は i18n の `xa.calib.warn.*`）。 */
export type XaCalibWarning =
  | "userDiffersFromDevice"
  | "sidSodDiffersFromMagFactor"
  | "calibrationTypeMissing"
  | "pixelSpacingEqualsImager"
  | "anisotropic";

/** 校正の材料（DICOM タグ）。すべて任意。 */
export interface XaCalibTags {
  /** PixelSpacing (0028,0030) [row, col] mm。 */
  pixelSpacing?: readonly [number, number] | null;
  /** PixelSpacingCalibrationType (0028,0A02)。定義語 GEOMETRY / FIDUCIAL。 */
  pixelSpacingCalibrationType?: string | null;
  /** PixelSpacingCalibrationDescription (0028,0A04)。 */
  pixelSpacingCalibrationDescription?: string | null;
  /** ImagerPixelSpacing (0018,1164) [row, col] mm（検出器面）。 */
  imagerPixelSpacing?: readonly [number, number] | null;
  /** DistanceSourceToDetector (0018,1110) = SID [mm]。 */
  distanceSourceToDetector?: number | null;
  /** DistanceSourceToPatient (0018,1111) = SOD [mm]。 */
  distanceSourceToPatient?: number | null;
  /** EstimatedRadiographicMagnificationFactor (0018,1114)。 */
  estimatedRadiographicMagnificationFactor?: number | null;
}

/** 人が確定した校正（カテーテル法 / ルーラー法）。 */
export interface XaUserCalibration {
  mmPerPx: number;
  /**
   * 校正の出自。🚨 **`gsps` を人の校正と混ぜない**——他システムが書いた値であり、
   * どう作られたかはこちらでは分からない（`provenance` にそう出す）。
   */
  method: "catheter" | "ruler" | "gsps";
  /** 出自の説明（"6Fr カテーテル（造影あり）" など）。そのまま表示する。 */
  note?: string;
}

export interface XaCalibration {
  /** 行方向 mm/px。null なら未校正。 */
  mmPerPxRow: number | null;
  /** 列方向 mm/px。非等方をそのまま保持する（平均して 1 値に潰さない）。 */
  mmPerPxCol: number | null;
  source: XaCalibSource;
  confidence: "high" | "medium" | "low" | "none";
  plane: XaCalibPlane;
  tier: XaCalibTier;
  /** 人向けの根拠（例 `DICOM PixelSpacing (FIDUCIAL: 6Fr catheter)`）。 */
  provenance: string;
  warnings: XaCalibWarning[];
  /** P6 のとき、検出器面の値（捨てずにツールチップへ出す）。 */
  detectorMmPerPx?: number | null;
}

/** `PixelSpacing == ImagerPixelSpacing`（＝未補正）とみなす相対許容差。 */
const EQUAL_REL_EPS = 1e-6;
/** 人の校正と装置の校正がこれ以上ずれたら警告する。 */
const USER_VS_DEVICE_WARN = 0.1;
/** SID/SOD 由来と拡大率由来がこれ以上ずれたら警告する。 */
const GEOMETRIC_DISAGREE_WARN = 0.05;

function pos(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

function pair(v: readonly [number, number] | null | undefined): [number, number] | null {
  if (!v || v.length < 2) return null;
  const a = pos(v[0]);
  const b = pos(v[1]);
  return a != null && b != null ? [a, b] : null;
}

function relDiff(a: number, b: number): number {
  const m = Math.max(Math.abs(a), Math.abs(b));
  return m > 0 ? Math.abs(a - b) / m : 0;
}

const UNCALIBRATED: XaCalibration = {
  mmPerPxRow: null,
  mmPerPxCol: null,
  source: "none",
  confidence: "none",
  plane: "unknown",
  tier: "uncalibrated",
  provenance: "no spatial calibration",
  warnings: [],
};

/**
 * 校正を解決する（P0 → P7 のフォールバック連鎖）。純関数。
 *
 * @param tags     DICOM タグ（{@link readXaCalibTags} で読む）
 * @param override 人が確定した校正（あれば最優先）
 */
export function resolveXaCalibration(
  tags: XaCalibTags,
  override?: XaUserCalibration | null,
): XaCalibration {
  const warnings: XaCalibWarning[] = [];
  const ps = pair(tags.pixelSpacing);
  const imager = pair(tags.imagerPixelSpacing);
  const type = tags.pixelSpacingCalibrationType?.trim().toUpperCase() || null;

  // 規格の明文: PixelSpacing == ImagerPixelSpacing なら「補正は施されていない」。
  const psEqualsImager =
    !!ps && !!imager && relDiff(ps[0], imager[0]) < EQUAL_REL_EPS && relDiff(ps[1], imager[1]) < EQUAL_REL_EPS;

  // 装置由来の校正（P1〜P3）。P3' は「未校正」として採用しない。
  let device: XaCalibration | null = null;
  if (ps) {
    const desc = tags.pixelSpacingCalibrationDescription?.trim();
    if (type === "FIDUCIAL" || type === "GEOMETRY") {
      // 校正種別の明記があるならそれが結論。ただし値が検出器面と同じなら不審なので警告。
      const w: XaCalibWarning[] = psEqualsImager ? ["pixelSpacingEqualsImager"] : [];
      device = {
        mmPerPxRow: ps[0],
        mmPerPxCol: ps[1],
        source: type === "FIDUCIAL" ? "dicom-fiducial" : "dicom-geometry",
        confidence: type === "FIDUCIAL" ? "high" : "medium",
        plane: type === "FIDUCIAL" ? "fiducial-depth" : "central-ray",
        tier: type === "FIDUCIAL" ? "calibrated" : "approximate",
        provenance: `DICOM PixelSpacing (${type}${desc ? `: ${desc}` : ""})`,
        warnings: w,
      };
    } else if (!psEqualsImager) {
      // 種別の記載は無いが、検出器面とは違う ＝ 何らかの補正済みとみなす（信頼度は 1 段下げる）。
      device = {
        mmPerPxRow: ps[0],
        mmPerPxCol: ps[1],
        source: "dicom-calibrated-unspecified",
        confidence: "medium",
        plane: "unknown",
        tier: "approximate",
        provenance: `DICOM PixelSpacing${desc ? ` (${desc})` : ""}`,
        warnings: ["calibrationTypeMissing"],
      };
    } else {
      // P3': 検出器面と同値 ＝ 未校正。P4 以降へ落とす。
      warnings.push("pixelSpacingEqualsImager");
    }
  }

  // P0: 人が確定した校正は常に最優先。装置校正と食い違うなら警告する（黙って上書きしない）。
  const userMm = pos(override?.mmPerPx);
  if (override && userMm) {
    const w = [...warnings];
    if (device?.mmPerPxCol && relDiff(userMm, device.mmPerPxCol) > USER_VS_DEVICE_WARN) {
      w.push("userDiffersFromDevice");
    }
    return withAnisotropyCheck({
      mmPerPxRow: userMm,
      mmPerPxCol: userMm,
      source:
        override.method === "catheter"
          ? "user-catheter"
          : override.method === "gsps"
            ? "gsps"
            : "user-ruler",
      confidence: "high",
      plane: "fiducial-depth",
      tier: "calibrated",
      provenance: override.note?.trim()
        ? `${userCalibLabel(override.method)}: ${override.note.trim()}`
        : userCalibLabel(override.method),
      warnings: w,
    });
  }

  if (device) {
    return withAnisotropyCheck({ ...device, warnings: [...warnings, ...device.warnings] });
  }

  // P4/P5: 幾何近似。ImagerPixelSpacing が無ければどちらも組めない。
  if (imager) {
    const sid = pos(tags.distanceSourceToDetector);
    const sod = pos(tags.distanceSourceToPatient);
    const mag = pos(tags.estimatedRadiographicMagnificationFactor);
    const bySidSod = sid && sod ? sod / sid : null;
    const byMag = mag ? 1 / mag : null;
    if (bySidSod && byMag && relDiff(bySidSod, byMag) > GEOMETRIC_DISAGREE_WARN) {
      warnings.push("sidSodDiffersFromMagFactor");
    }
    // 実測（SID/SOD）を装置の見積もり（拡大率）より優先する。
    const factor = bySidSod ?? byMag;
    if (factor) {
      return withAnisotropyCheck({
        mmPerPxRow: imager[0] * factor,
        mmPerPxCol: imager[1] * factor,
        source: bySidSod ? "geometric-sid-sod" : "geometric-magfactor",
        confidence: "low",
        plane: bySidSod ? "isocenter" : "central-ray",
        tier: "approximate",
        provenance: bySidSod
          ? `geometric (ImagerPixelSpacing × SOD/SID = ${sod}/${sid})`
          : `geometric (ImagerPixelSpacing ÷ magnification ${mag})`,
        warnings,
      });
    }
    // P6: 検出器面の値しか無い ＝ 校正できていない。値は捨てずに持つ。
    return {
      ...UNCALIBRATED,
      source: "detector-plane",
      plane: "detector",
      provenance: "ImagerPixelSpacing only (detector plane, uncalibrated)",
      warnings,
      detectorMmPerPx: imager[1],
    };
  }

  // P7
  return { ...UNCALIBRATED, warnings };
}

function userCalibLabel(method: "catheter" | "ruler" | "gsps"): string {
  if (method === "catheter") return "catheter calibration";
  if (method === "gsps") return "presentation state (GSPS)";
  return "ruler calibration";
}

/** 非等方（row ≠ col）を検出して警告に積む。値は潰さない。 */
function withAnisotropyCheck(c: XaCalibration): XaCalibration {
  if (c.mmPerPxRow != null && c.mmPerPxCol != null && relDiff(c.mmPerPxRow, c.mmPerPxCol) > 1e-6) {
    return { ...c, warnings: [...c.warnings, "anisotropic"] };
  }
  return c;
}

/**
 * Cornerstone の計測ツールへ渡す `calibration.scale`。
 *
 * <p>🚨 **world 座標は「ローダが作った画像オブジェクトの spacing」で決まる**。`imagePlaneModule` に
 * 校正値を注入しても world は変わらない（実機で「スケールバーは mm・計測は px のまま」で発覚）。
 * Cornerstone の計測ツールは `表示値 = world 長 / calibration.scale` で単位を作るので、
 * ここに比を渡すのが**ライブラリが想定している経路**。
 *
 * <p>`world 長 = 画素数 × loaderSpacing` なので
 * <ul>
 *   <li>校正済み（mm 表示）: `scale = loaderSpacing / mmPerPx`</li>
 *   <li>未校正（px 表示）:   `scale = loaderSpacing`</li>
 * </ul>
 * DICOM の `PixelSpacing` をそのまま使う場合（loaderSpacing === mmPerPx）は 1 になり、
 * **二重適用にならない**。
 *
 * @param loaderSpacing ローダが画像に付けた列方向 spacing（`PixelSpacing` が無ければ 1）
 * @param mmPerPx       解決した mm/px。未校正なら null
 */
export function calibrationScaleFor(loaderSpacing: number | null | undefined, mmPerPx: number | null): number {
  const ls = loaderSpacing && loaderSpacing > 0 ? loaderSpacing : 1;
  if (mmPerPx && mmPerPx > 0) return ls / mmPerPx;
  return ls;
}

/** mm 表示してよいか（スケールバー・計測ラベルの判断）。 */
export function isXaCalibrated(c: XaCalibration): boolean {
  return c.tier !== "uncalibrated" && c.mmPerPxCol != null;
}
