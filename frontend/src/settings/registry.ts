/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 環境設定の項目定義（宣言的レジストリ）。
// label/help/options/section.title/category.label は i18n キー（t() で解決）。
// ここにカテゴリ/セクション/フィールドを追加するだけで、ダイアログ右パネルが自動描画する。

export type FieldType = "toggle" | "text" | "number" | "select" | "color";

export interface FieldOption {
  value: string;
  /** i18n キー。 */
  labelKey: string;
}

export interface FieldDef {
  /** 保存キー（名前空間付き推奨: "viewer.invertScroll"）。 */
  key: string;
  /** ラベルの i18n キー。 */
  labelKey: string;
  type: FieldType;
  default: string | number | boolean;
  /** 補足説明の i18n キー（任意）。 */
  helpKey?: string;
  options?: FieldOption[]; // select 用
  min?: number; // number 用
  max?: number; // number 用
}

export interface SectionDef {
  /** セクション見出しの i18n キー。 */
  titleKey: string;
  fields: FieldDef[];
}

export interface CategoryDef {
  id: string;
  /** カテゴリ名の i18n キー。 */
  labelKey: string;
  icon?: string;
  sections: SectionDef[];
}

// Texture（Radiomics）: ビン系フィールドはファミリー共通なのでヘルパで生成する。
// キーは backend が期待する GRAPHY Property キーに "texture." を付けたもの。
function binFields(fam: string, opts: { delta?: boolean; alpha?: boolean } = {}): FieldDef[] {
  const f: FieldDef[] = [
    { key: `texture.BINCOUNT_${fam}_BOOL`, labelKey: "settings.tex.useBinCount", type: "toggle", default: true },
    { key: `texture.BINCOUNT_${fam}_INT`, labelKey: "settings.tex.binCount", type: "number", default: 16, min: 2, max: 256 },
    { key: `texture.BINWIDTH_${fam}_DOUBLE`, labelKey: "settings.tex.binWidth", type: "number", default: 0, min: 0, max: 100000 },
  ];
  if (opts.delta) f.push({ key: `texture.DELTA_${fam}_DOUBLE`, labelKey: "settings.tex.delta", type: "number", default: 1, min: 1, max: 20 });
  if (opts.alpha) f.push({ key: `texture.ALPHA_${fam}_DOUBLE`, labelKey: "settings.tex.alpha", type: "number", default: 1, min: 0, max: 20 });
  return f;
}
function familyToggle(key: string, labelKey: string, def: boolean): FieldDef {
  return { key: `texture.${key}`, labelKey, type: "toggle", default: def };
}

// Texture（Radiomics 可視化マップ）設定＝GRAPHY RadiomicsSettings の全 62 パラメータをファミリー別に。
const TEXTURE_CATEGORY: CategoryDef = {
  id: "texture",
  labelKey: "settings.cat.texture",
  icon: "🧬",
  sections: [
    {
      titleKey: "settings.sec.tex.computation",
      fields: [{ key: "texture.D3Basis", labelKey: "settings.tex.d3basis", type: "toggle", default: true, helpKey: "settings.tex.d3basis.help" }],
    },
    {
      titleKey: "settings.sec.tex.mask",
      fields: [
        { key: "texture.MASK_LABEL_INT", labelKey: "settings.tex.maskLabel", type: "number", default: 1, min: 1, max: 255 },
        { key: "texture.RemoveOutliers_BOOL", labelKey: "settings.tex.removeOutliers", type: "toggle", default: false },
        { key: "texture.Sigma_INT", labelKey: "settings.tex.sigma", type: "number", default: 3, min: 1, max: 10 },
        { key: "texture.RangeFiltering_BOOL", labelKey: "settings.tex.rangeFilter", type: "toggle", default: false },
        { key: "texture.ResamplingMin_DOUBLE", labelKey: "settings.tex.rangeMin", type: "number", default: 0, min: -100000, max: 100000 },
        { key: "texture.ResamplingMax_DOUBLE", labelKey: "settings.tex.rangeMax", type: "number", default: 0, min: -100000, max: 100000 },
      ],
    },
    {
      titleKey: "settings.sec.tex.resample",
      fields: [
        { key: "texture.Resampling_BOOL", labelKey: "settings.tex.resample", type: "toggle", default: false },
        { key: "texture.ResamplingX_DOUBLE", labelKey: "settings.tex.resampleX", type: "number", default: 1, min: 0, max: 100 },
        { key: "texture.ResamplingY_DOUBLE", labelKey: "settings.tex.resampleY", type: "number", default: 1, min: 0, max: 100 },
        { key: "texture.ResamplingZ_DOUBLE", labelKey: "settings.tex.resampleZ", type: "number", default: 1, min: 0, max: 100 },
      ],
    },
    {
      titleKey: "settings.sec.tex.families",
      fields: [
        familyToggle("Operational", "settings.tex.fam.operational", true),
        familyToggle("Diagnostics", "settings.tex.fam.diagnostics", true),
        familyToggle("Morphological", "settings.tex.fam.morphological", false),
        familyToggle("LocalIntensity", "settings.tex.fam.localIntensity", true),
        familyToggle("IntensityStats", "settings.tex.fam.intensityStats", true),
        familyToggle("IntensityHistogram", "settings.tex.fam.histogram", true),
        familyToggle("VolumeHistogram", "settings.tex.fam.ivh", true),
        familyToggle("GLCM", "settings.tex.fam.glcm", true),
        familyToggle("GLRLM", "settings.tex.fam.glrlm", true),
        familyToggle("GLSZM", "settings.tex.fam.glszm", true),
        familyToggle("GLDZM", "settings.tex.fam.gldzm", true),
        familyToggle("NGTDM", "settings.tex.fam.ngtdm", true),
        familyToggle("NGLDM", "settings.tex.fam.ngldm", true),
        familyToggle("Fractal", "settings.tex.fam.fractal", true),
        familyToggle("Shape2D", "settings.tex.fam.shape2d", false),
      ],
    },
    { titleKey: "settings.sec.tex.glcm", fields: binFields("GLCM", { delta: true }) },
    { titleKey: "settings.sec.tex.glrlm", fields: binFields("GLRLM") },
    { titleKey: "settings.sec.tex.glszm", fields: binFields("GLSZM") },
    { titleKey: "settings.sec.tex.gldzm", fields: binFields("GLDZM") },
    { titleKey: "settings.sec.tex.ngtdm", fields: binFields("NGTDM", { delta: true }) },
    { titleKey: "settings.sec.tex.ngldm", fields: binFields("NGLDM", { delta: true, alpha: true }) },
    { titleKey: "settings.sec.tex.histogram", fields: binFields("HIST") },
    {
      titleKey: "settings.sec.tex.ivh",
      fields: [
        { key: "texture.USEORIGINAL_IVH_BOOL", labelKey: "settings.tex.ivhOriginal", type: "toggle", default: false },
        { key: "texture.BINCOUNT_IVH_BOOL", labelKey: "settings.tex.useBinCount", type: "toggle", default: true },
        { key: "texture.BINCOUNT_IVH_INT", labelKey: "settings.tex.binCount", type: "number", default: 16, min: 2, max: 256 },
        { key: "texture.BINWIDTH_IVH_DOUBLE", labelKey: "settings.tex.binWidth", type: "number", default: 0, min: 0, max: 100000 },
      ],
    },
    {
      titleKey: "settings.sec.tex.fractal",
      fields: [{ key: "texture.BOXSIZES_FRACTAL", labelKey: "settings.tex.boxSizes", type: "text", default: "2,3,4,6,8,12,16,32,64" }],
    },
  ],
};

export const SETTINGS_REGISTRY: CategoryDef[] = [
  {
    id: "general",
    labelKey: "settings.cat.general",
    icon: "⚙",
    sections: [
      {
        titleKey: "settings.sec.appearance",
        fields: [
          {
            key: "general.theme",
            labelKey: "settings.field.theme",
            type: "select",
            default: "system",
            options: [
              { value: "system", labelKey: "settings.opt.theme.system" },
              { value: "light", labelKey: "settings.opt.theme.light" },
              { value: "dark", labelKey: "settings.opt.theme.dark" },
            ],
          },
          // 言語は i18n コンテキストに直結（SettingsDialog で特別扱い）
          {
            key: "general.language",
            labelKey: "settings.field.language",
            type: "select",
            default: "ja",
            options: [
              { value: "ja", labelKey: "settings.opt.lang.ja" },
              { value: "en", labelKey: "settings.opt.lang.en" },
            ],
          },
        ],
      },
      {
        titleKey: "settings.sec.debug",
        fields: [
          {
            key: "general.debugMode",
            labelKey: "settings.field.debugMode",
            type: "toggle",
            default: false,
            helpKey: "settings.field.debugMode.help",
          },
        ],
      },
    ],
  },
  {
    // 画像オーバーレイ（4 隅の表示属性）はカスタムパネル OverlayConfigPanel で編集。
    id: "overlay",
    labelKey: "settings.cat.overlay",
    icon: "🅣",
    sections: [],
  },
  {
    // DICOM 送信先（Remote AE）はカスタムパネル RemoteAePanel で編集。
    id: "dicomSend",
    labelKey: "settings.cat.dicomSend",
    icon: "📡",
    sections: [],
  },
  {
    id: "qr",
    labelKey: "settings.cat.qr",
    icon: "🔎",
    sections: [
      {
        titleKey: "settings.sec.qr",
        fields: [
          {
            key: "qr.autoRefreshOnStartup",
            labelKey: "settings.field.qrAutoRefreshOnStartup",
            type: "toggle",
            default: false,
            helpKey: "settings.field.qrAutoRefreshOnStartup.help",
          },
          {
            key: "qr.autoRefreshIntervalSec",
            labelKey: "settings.field.qrAutoRefreshIntervalSec",
            type: "number",
            default: 60,
            min: 10,
            max: 3600,
            helpKey: "settings.field.qrAutoRefreshIntervalSec.help",
          },
          {
            key: "qr.largeRetrieveThreshold",
            labelKey: "settings.field.qrLargeRetrieveThreshold",
            type: "number",
            default: 500,
            min: 1,
            max: 100000,
            helpKey: "settings.field.qrLargeRetrieveThreshold.help",
          },
          {
            key: "dicom.webMoveDestAet",
            labelKey: "settings.field.webMoveDestAet",
            type: "text",
            default: "",
            helpKey: "settings.field.webMoveDestAet.help",
          },
        ],
      },
    ],
  },
  {
    id: "viewer",
    labelKey: "settings.cat.viewer",
    icon: "🖼",
    sections: [
      {
        titleKey: "settings.sec.viewer",
        fields: [
          { key: "viewer.invertScroll", labelKey: "settings.field.invertScroll", type: "toggle", default: false },
          {
            key: "viewer.showOverlay",
            labelKey: "settings.field.showOverlay",
            type: "toggle",
            default: true,
            helpKey: "settings.field.showOverlay.help",
          },
          { key: "viewer.defaultZoom", labelKey: "settings.field.defaultZoom", type: "number", default: 100, min: 10, max: 800 },
          { key: "viewer.cineFps", labelKey: "settings.field.cineFps", type: "number", default: 10, min: 1, max: 60 },
        ],
      },
      {
        titleKey: "settings.sec.roiMeasure",
        fields: [
          {
            key: "roi.defaultColor",
            labelKey: "settings.field.roiDefaultColor",
            type: "color",
            default: "#ffff00",
            helpKey: "settings.field.roiDefaultColor.help",
          },
          {
            key: "roi.defaultLineWidth",
            labelKey: "settings.field.roiDefaultLineWidth",
            type: "number",
            default: 1,
            min: 1,
            max: 10,
            helpKey: "settings.field.roiDefaultLineWidth.help",
          },
        ],
      },
      {
        titleKey: "settings.sec.roiMask",
        fields: [
          {
            key: "viewer.maskFillOpacity",
            labelKey: "settings.field.maskFillOpacity",
            type: "number",
            default: 50,
            min: 0,
            max: 100,
            helpKey: "settings.field.maskFillOpacity.help",
          },
          {
            key: "viewer.maskOutlineWidth",
            labelKey: "settings.field.maskOutlineWidth",
            type: "number",
            default: 1,
            min: 0,
            max: 10,
            helpKey: "settings.field.maskOutlineWidth.help",
          },
        ],
      },
      {
        titleKey: "settings.sec.seriesSync",
        fields: [
          {
            key: "viewer.coordinateSync",
            labelKey: "settings.field.coordinateSync",
            type: "toggle",
            default: true,
            helpKey: "settings.field.coordinateSync.help",
          },
          {
            key: "viewer.coordinateSyncMargin",
            labelKey: "settings.field.coordinateSyncMargin",
            type: "number",
            default: 2.5,
            min: 0,
            max: 100,
            helpKey: "settings.field.coordinateSyncMargin.help",
          },
        ],
      },
      {
        titleKey: "settings.sec.slicer",
        fields: [
          {
            key: "slicer.interpolation",
            labelKey: "settings.field.slicerInterp",
            type: "select",
            default: "linear",
            options: [
              { value: "linear", labelKey: "settings.opt.interp.linear" },
              { value: "nearest", labelKey: "settings.opt.interp.nearest" },
            ],
            helpKey: "settings.field.slicerInterp.help",
          },
        ],
      },
      {
        titleKey: "settings.sec.fusion",
        fields: [
          {
            key: "viewer.fusionOpacity",
            labelKey: "settings.field.fusionOpacity",
            type: "number",
            default: 50,
            min: 0,
            max: 100,
            helpKey: "settings.field.fusionOpacity.help",
          },
          {
            key: "viewer.fusionLut",
            labelKey: "settings.field.fusionLut",
            type: "text",
            default: "",
            helpKey: "settings.field.fusionLut.help",
          },
        ],
      },
    ],
  },
  {
    id: "data",
    labelKey: "settings.cat.data",
    icon: "🗂",
    sections: [
      {
        titleKey: "settings.sec.delete",
        fields: [
          { key: "data.confirmBeforeDelete", labelKey: "settings.field.confirmBeforeDelete", type: "toggle", default: true },
          {
            key: "data.deleteFilesOnDisk",
            labelKey: "settings.field.deleteFilesOnDisk",
            type: "toggle",
            default: true,
            helpKey: "settings.field.deleteFilesOnDisk.help",
          },
        ],
      },
      {
        titleKey: "settings.sec.patientEdit",
        fields: [
          {
            key: "data.applyPatientEditToFiles",
            labelKey: "settings.field.applyPatientEditToFiles",
            type: "toggle",
            default: true,
            helpKey: "settings.field.applyPatientEditToFiles.help",
          },
        ],
      },
      {
        titleKey: "settings.sec.displayStats",
        fields: [
          { key: "data.tableRowsPerPage", labelKey: "settings.field.tableRowsPerPage", type: "number", default: 100, min: 10, max: 1000 },
          { key: "data.statsRangeMonths", labelKey: "settings.field.statsRangeMonths", type: "number", default: 12, min: 1, max: 120 },
          {
            key: "data.volumeUnit",
            labelKey: "settings.field.volumeUnit",
            type: "select",
            default: "auto",
            options: [
              { value: "auto", labelKey: "settings.opt.volume.auto" },
              { value: "MB", labelKey: "settings.opt.volume.mb" },
              { value: "GB", labelKey: "settings.opt.volume.gb" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "dicom",
    labelKey: "settings.cat.dicom",
    icon: "🌐",
    sections: [
      {
        titleKey: "settings.sec.localAe",
        fields: [
          {
            key: "dicom.localAeTitle",
            labelKey: "settings.field.localAeTitle",
            type: "text",
            default: "GRAPHYNEXT",
            helpKey: "settings.field.localAeTitle.help",
          },
          {
            key: "dicom.localAePort",
            labelKey: "settings.field.localAePort",
            type: "number",
            default: 11112,
            min: 1,
            max: 65535,
            helpKey: "settings.field.localAePort.help",
          },
          {
            key: "dicom.localAeBindAddress",
            labelKey: "settings.field.localAeBindAddress",
            type: "text",
            default: "0.0.0.0",
            helpKey: "settings.field.localAeBindAddress.help",
          },
        ],
      },
      {
        titleKey: "settings.sec.pacs",
        fields: [
          {
            key: "dicom.pacsUiUrl",
            labelKey: "settings.field.pacsUiUrl",
            type: "text",
            default: "",
            helpKey: "settings.field.pacsUiUrl.help",
          },
        ],
      },
    ],
  },
  TEXTURE_CATEGORY,
  {
    // セキュリティは専用パネル（実行時の値を確認）。SettingsDialog で特別扱い。
    id: "security",
    labelKey: "settings.cat.security",
    icon: "🔒",
    sections: [],
  },
  {
    // モニター診断は専用パネル（表示環境の一覧＋目視テストパターン）。SettingsDialog で特別扱い。
    id: "monitor",
    labelKey: "settings.cat.monitor",
    icon: "🖥️",
    sections: [],
  },
  {
    // 情報（バージョン等）は専用パネル（/api/status を表示）。SettingsDialog で特別扱い。
    id: "about",
    labelKey: "settings.cat.about",
    icon: "ℹ️",
    sections: [],
  },
];
