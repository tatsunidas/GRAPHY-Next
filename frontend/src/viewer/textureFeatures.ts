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
  /** 特徴名（enum 定数名）。 */
  features: string[];
}

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
];
