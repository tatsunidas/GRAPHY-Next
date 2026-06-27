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
    ],
  },
];
