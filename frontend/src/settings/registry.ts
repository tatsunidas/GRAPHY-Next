/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 環境設定の項目定義（宣言的レジストリ）。
// label/help/options/section.title/category.label は i18n キー（t() で解決）。
// ここにカテゴリ/セクション/フィールドを追加するだけで、ダイアログ右パネルが自動描画する。

export type FieldType = "toggle" | "text" | "number" | "select";

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
  {
    // セキュリティは専用パネル（実行時の値を確認）。SettingsDialog で特別扱い。
    id: "security",
    labelKey: "settings.cat.security",
    icon: "🔒",
    sections: [],
  },
];
