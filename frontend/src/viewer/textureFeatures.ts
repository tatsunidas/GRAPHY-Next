/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Texture 可視化マップで選択できる特徴ファミリーと特徴名。
 *
 * <p>backend {@code TextureFeatureCatalog} のファミリーキーと一致させる。送信する特徴文字列は
 * {@code `${familyKey}_${featureName}`}（例 "GLCM_JointEntropy"）。名称は RadiomicsJ の
 * {@code *FeatureType} enum 定数名に対応。
 */
export interface TextureFamily {
  /** backend ファミリーキー（feature 文字列の接頭辞）。 */
  key: string;
  /** 表示名。 */
  label: string;
  /** 特徴名（enum 定数名）。GLAM は行列×統計で組み立てるため空。 */
  features: string[];
}

// ── GLAM（Gray Level Affinity Metrics） ──────────────────────────
//
// GLAM だけは 19 行列 × 8 統計 = 150 特徴あり、1 本のドロップダウンに並べても選べない。
// GLCM が共起行列を記述子とするのと同じで、GLAM は「行列」が記述子・「統計」がその要約なので、
// UI もその 2 段で選ばせる。送信する文字列は `GLAM_<行列>_<統計>` で、backend は最初の "_" で
// 族を切り出すため、残り（例 "SecondVirialCoefficient_Mean"）がそのまま enum 定数名になる。

export const GLAM_FAMILY_KEY = "GLAM";

/** GLAM は 3D 専用で、カーネルは maxRadius が 2 以上になる大きさが要る（backend GlamMapSupport と一致）。 */
export const GLAM_MIN_FILTER_SIZE = 5;

/** GLAM の親和性行列。 */
export interface GlamMatrix {
  name: string;
  /** i18n キー。 */
  labelKey: string;
  /** 自己ペアだけで定義される行列（対角/非対角に分ける統計に意味が無い）。 */
  diagonalOnly?: boolean;
  /**
   * 境界補正が入ると値が 1 に張り付く行列。RadiomicsJ `GLAMMatrixType` の注記どおり、
   * これらを使うなら `BOOL_GLAM_boundaryCorrection` を 0 にする必要がある。
   */
  needsBoundaryCorrectionOff?: boolean;
}

export const GLAM_MATRICES: GlamMatrix[] = [
  { name: "RDFPeakPosition", labelKey: "texture.glam.mat.RDFPeakPosition" },
  { name: "RDFDispersionRatio", labelKey: "texture.glam.mat.RDFDispersionRatio" },
  { name: "LogRDFPeakHeight", labelKey: "texture.glam.mat.LogRDFPeakHeight" },
  { name: "LogRDFMedian", labelKey: "texture.glam.mat.LogRDFMedian" },
  { name: "LogRDFVariance", labelKey: "texture.glam.mat.LogRDFVariance" },
  { name: "LogRDFSkewness", labelKey: "texture.glam.mat.LogRDFSkewness" },
  { name: "LogRDFKurtosis", labelKey: "texture.glam.mat.LogRDFKurtosis" },
  { name: "SecondVirialCoefficient", labelKey: "texture.glam.mat.SecondVirialCoefficient" },
  { name: "PotentialEnergy", labelKey: "texture.glam.mat.PotentialEnergy" },
  { name: "Compressibility", labelKey: "texture.glam.mat.Compressibility", diagonalOnly: true },
  { name: "CoordinationNumber", labelKey: "texture.glam.mat.CoordinationNumber" },
  { name: "InverseCorrelationLength", labelKey: "texture.glam.mat.InverseCorrelationLength" },
  { name: "StructuralPressureIndex", labelKey: "texture.glam.mat.StructuralPressureIndex" },
  {
    name: "ConfigurationalDisorderIndex",
    labelKey: "texture.glam.mat.ConfigurationalDisorderIndex",
    needsBoundaryCorrectionOff: true,
  },
  { name: "WassersteinDistance", labelKey: "texture.glam.mat.WassersteinDistance" },
  { name: "AssemblyCoupling", labelKey: "texture.glam.mat.AssemblyCoupling" },
  { name: "PhenotypicDistance", labelKey: "texture.glam.mat.PhenotypicDistance" },
  { name: "LocalPackingFraction", labelKey: "texture.glam.mat.LocalPackingFraction" },
  {
    name: "FrustrationIndex",
    labelKey: "texture.glam.mat.FrustrationIndex",
    needsBoundaryCorrectionOff: true,
  },
];

/** 行列を 1 つの数値に潰す統計。 */
export const GLAM_STATISTICS = [
  "Mean",
  "Variance",
  "Skewness",
  "Kurtosis",
  "Minimum",
  "Maximum",
  "DiagonalMean",
  "OffDiagonalMean",
] as const;

/** 自己ペアだけの行列では、対角/非対角に分ける統計に意味が無い。 */
export const glamStatisticsFor = (matrix: GlamMatrix | undefined): readonly string[] =>
  matrix?.diagonalOnly
    ? GLAM_STATISTICS.filter((s) => s !== "DiagonalMean" && s !== "OffDiagonalMean")
    : GLAM_STATISTICS;

/** backend へ送る特徴文字列。 */
export const glamFeatureString = (matrix: string, statistic: string) =>
  `${GLAM_FAMILY_KEY}_${matrix}_${statistic}`;

export const TEXTURE_FAMILIES: TextureFamily[] = [
  {
    key: "GLCM",
    label: "GLCM (Co-occurrence)",
    features: [
      "JointMaximum", "JointAverage", "JointVariance", "JointEntropy",
      "DifferenceAverage", "DifferenceVariance", "DifferenceEntropy",
      "SumAverage", "SumVariance", "SumEntropy", "AngularSecondMoment",
      "Contrast", "Dissimilarity", "InverseDifference", "NormalizedInverseDifference",
      "InverseDifferenceMoment", "NormalizedInverseDifferenceMoment", "InverseVariance",
      "Correlation", "Autocorrection", "ClusterTendency", "ClusterShade", "ClusterProminence",
      "InformationalMeasureOfCorrelation1", "InformationalMeasureOfCorrelation2",
    ],
  },
  {
    key: "GLRLM",
    label: "GLRLM (Run Length)",
    features: [
      "ShortRunEmphasis", "LongRunEmphasis", "LowGrayLevelRunEmphasis", "HighGrayLevelRunEmphasis",
      "ShortRunLowGrayLevelEmphasis", "ShortRunHighGrayLevelEmphasis",
      "LongRunLowGrayLevelEmphasis", "LongRunHighGrayLevelEmphasis",
      "GrayLevelNonUniformity", "GrayLevelNonUniformityNormalized",
      "RunLengthNonUniformity", "RunLengthNonUniformityNormalized",
      "RunPercentage", "GrayLevelVariance", "RunLengthVariance", "RunEntropy",
    ],
  },
  {
    key: "GLSZM",
    label: "GLSZM (Size Zone)",
    features: [
      "SmallZoneEmphasis", "LargeZoneEmphasis", "LowGrayLevelZoneEmphasis", "HighGrayLevelZoneEmphasis",
      "SmallZoneLowGrayLevelEmphasis", "SmallZoneHighGrayLevelEmphasis",
      "LargeZoneLowGrayLevelEmphasis", "LargeZoneHighGrayLevelEmphasis",
      "GrayLevelNonUniformity", "GrayLevelNonUniformityNormalized",
      "SizeZoneNonUniformity", "SizeZoneNonUniformityNormalized",
      "ZonePercentage", "GrayLevelVariance", "ZoneSizeVariance", "ZoneSizeEntropy",
    ],
  },
  {
    key: "GLDZM",
    label: "GLDZM (Distance Zone)",
    features: [
      "SmallDistanceEmphasis", "LargeDistanceEmphasis", "LowGrayLevelZoneEmphasis", "HighGrayLevelZoneEmphasis",
      "SmallDistanceLowGrayLevelEmphasis", "SmallDistanceHighGrayLevelEmphasis",
      "LargeDistanceLowGrayLevelEmphasis", "LargeDistanceHighGrayLevelEmphasis",
      "GrayLevelNonUniformity", "GrayLevelNonUniformityNormalized",
      "ZoneDistanceNonUniformity", "ZoneDistanceNonUniformityNormalized",
      "ZonePercentage", "GrayLevelVariance", "ZoneDistanceVariance", "ZoneDistanceEntropy",
    ],
  },
  {
    key: "NGTDM",
    label: "NGTDM (Tone Difference)",
    features: ["Coarseness", "Contrast", "Busyness", "Complexity", "Strength"],
  },
  {
    key: "NGLDM",
    label: "NGLDM (Dependence)",
    features: [
      "LowDependenceEmphasis", "HighDependenceEmphasis", "LowGrayLevelCountEmphasis", "HighGrayLevelCountEmphasis",
      "LowDependenceLowGrayLevelEmphasis", "LowDependenceHighGrayLevelEmphasis",
      "HighDependenceLowGrayLevelEmphasis", "HighDependenceHighGrayLevelEmphasis",
      "GrayLevelNonUniformity", "GrayLevelNonUniformityNormalized",
      "DependenceCountNonUniformity", "DependenceCountNonUniformityNormalized",
      "DependenceCountPercentage", "GrayLevelVariance", "DependenceCountVariance",
      "DependenceCountEntropy", "DependenceCountEnergy",
    ],
  },
  {
    key: "FIRSTORDER",
    label: "First-order (Intensity)",
    features: [
      "Mean", "Variance", "Skewness", "Kurtosis", "Median", "Minimum",
      "Percentile10", "Percentile90", "Maximum", "Interquartile", "Range",
      "MeanAbsoluteDeviation", "RobustMeanAbsoluteDeviation", "MedianAbsoluteDeviation",
      "CoefficientOfVariation", "QuartileCoefficientOfDispersion",
      "Energy", "RootMeanSquared", "TotalEnergy", "StandardDeviation", "StandardError",
    ],
  },
  {
    key: "HISTOGRAM",
    label: "Histogram (Intensity)",
    features: [
      "MeanDiscretisedIntensity", "Variance", "Skewness", "Kurtosis", "Median", "Minimum",
      "Percentile10", "Percentile90", "Maximum", "Mode", "Interquartile", "Range",
      "MeanAbsoluteDeviation", "RobustMeanAbsoluteDeviation", "MedianAbsoluteDeviation",
      "CoefficientOfVariation", "QuartileCoefficientOfDispersion",
      "Entropy", "Uniformity",
      "MaximumHistogramGradient", "MaximumHistogramGradientIntensity",
      "MinimumHistogramGradient", "MinimumHistogramGradientIntensity",
    ],
  },
  {
    // 特徴は行列×統計から組み立てるので、ここは空にしてダイアログ側で 2 段選択にする。
    key: GLAM_FAMILY_KEY,
    label: "GLAM (Affinity Metrics)",
    features: [],
  },
];
