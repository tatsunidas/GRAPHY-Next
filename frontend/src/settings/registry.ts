// 環境設定の項目定義（宣言的レジストリ）。
// ここにカテゴリ/セクション/フィールドを追加するだけで、ダイアログ右パネルが自動描画する。
// 値は backend に文字列 KV で保存し、型解釈はこの定義が担う。

export type FieldType = "toggle" | "text" | "number" | "select";

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldDef {
  /** 保存キー（名前空間付き推奨: "viewer.invertScroll"）。 */
  key: string;
  label: string;
  type: FieldType;
  default: string | number | boolean;
  help?: string;
  options?: FieldOption[]; // select 用
  min?: number; // number 用
  max?: number; // number 用
}

export interface SectionDef {
  title: string;
  fields: FieldDef[];
}

export interface CategoryDef {
  id: string;
  label: string;
  icon?: string;
  sections: SectionDef[];
}

export const SETTINGS_REGISTRY: CategoryDef[] = [
  {
    id: "general",
    label: "一般",
    icon: "⚙",
    sections: [
      {
        title: "外観",
        fields: [
          {
            key: "general.theme",
            label: "テーマ",
            type: "select",
            default: "system",
            options: [
              { value: "system", label: "システムに従う" },
              { value: "light", label: "ライト" },
              { value: "dark", label: "ダーク" },
            ],
          },
          {
            key: "general.language",
            label: "言語",
            type: "select",
            default: "ja",
            options: [
              { value: "ja", label: "日本語" },
              { value: "en", label: "English" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "viewer",
    label: "表示",
    icon: "🖼",
    sections: [
      {
        title: "ビューア",
        fields: [
          { key: "viewer.invertScroll", label: "スクロール方向を反転", type: "toggle", default: false },
          {
            key: "viewer.showOverlay",
            label: "オーバーレイ情報を表示",
            type: "toggle",
            default: true,
            help: "患者名・スライス番号などを画像上に表示します。",
          },
          { key: "viewer.defaultZoom", label: "初期ズーム(%)", type: "number", default: 100, min: 10, max: 800 },
        ],
      },
    ],
  },
  {
    id: "data",
    label: "データ管理",
    icon: "🗂",
    sections: [
      {
        title: "削除",
        fields: [
          { key: "data.confirmBeforeDelete", label: "削除前に確認する", type: "toggle", default: true },
          {
            key: "data.deleteFilesOnDisk",
            label: "削除時にディスク上の DICOM ファイルも削除",
            type: "toggle",
            default: true,
            help: "OFF にすると索引からのみ除外し、実ファイルは残ります。",
          },
        ],
      },
      {
        title: "患者情報の編集",
        fields: [
          {
            key: "data.applyPatientEditToFiles",
            label: "患者情報の編集を元の DICOM ファイルにも反映",
            type: "toggle",
            default: true,
            help: "ON で該当患者の全 DICOM ファイルのタグを書き換えます（重い・不可逆）。OFF は索引のみ更新。",
          },
        ],
      },
      {
        title: "表示・統計",
        fields: [
          { key: "data.tableRowsPerPage", label: "DBテーブルの1ページ表示件数", type: "number", default: 100, min: 10, max: 1000 },
          { key: "data.statsRangeMonths", label: "統計の既定期間（月）", type: "number", default: 12, min: 1, max: 120 },
          {
            key: "data.volumeUnit",
            label: "データ容量の単位",
            type: "select",
            default: "auto",
            options: [
              { value: "auto", label: "自動(MB/GB)" },
              { value: "MB", label: "MB" },
              { value: "GB", label: "GB" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "dicom",
    label: "DICOM通信",
    icon: "🌐",
    sections: [
      {
        title: "自局",
        fields: [
          {
            key: "dicom.localAeTitle",
            label: "自局 AE タイトル",
            type: "text",
            default: "GRAPHYNEXT",
            help: "現状は表示・保存のみ。将来 backend 設定への反映を予定。",
          },
        ],
      },
      {
        title: "PACS 連携（web）",
        fields: [
          {
            key: "dicom.pacsUiUrl",
            label: "PACS 管理 UI の URL",
            type: "text",
            default: "",
            help: "web 版で患者情報を編集する際に開く dcm4chee の UI。例: http://localhost:8080/dcm4chee-arc/ui2",
          },
        ],
      },
    ],
  },
];
