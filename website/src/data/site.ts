/**
 * Single source of truth for site copy and structured data (Phase 1, ja).
 *
 * Everything the pages render comes from here so that:
 *  - rework is cheap (edit data, not markup),
 *  - a future English pass is an isolated translation of this file,
 *  - product / feature / plugin / release lists are data-driven.
 */

export interface NavItem {
  label: string;
  href: string;
  /** show a "coming soon" badge and make it non-navigational (e.g. the live demo, Phase 3) */
  comingSoon?: boolean;
}

export interface Feature {
  icon: string;
  title: string;
  desc: string;
}

export interface PluginCard {
  name: string;
  tagline: string;
  repo?: string;
  /** set false until we confirm the plugin repo may be publicised */
  published: boolean;
}

/** GitHub repositories used for release/download data (fetched at build time). */
export const repos = {
  next: 'tatsunidas/GRAPHY-Next',
  classic: 'tatsunidas/GRAPHY',
} as const;

export const site = {
  brand: 'GRAPHY',
  domain: 'https://graphy.vis-ionary.com',
  company: 'Visionary Imaging Services, Inc.',
  companyUrl: 'https://vis-ionary.com',
  contactEmail: 'customerservices@vis-ionary.com',
  sponsorsUrl: 'https://github.com/sponsors/tatsunidas',
  githubOrgUrl: 'https://github.com/tatsunidas',
  subscription: { priceJpy: 700, period: '月' },

  // Support-subscription checkout via PayPal (hosted subscription button).
  // Create a ¥700/month subscription plan in the PayPal dashboard, then set
  // both values below to go live. While empty, the checkout shows a
  // "準備中" fallback instead of a broken button.
  payment: {
    provider: 'paypal' as const,
    // PayPal REST app client-id (use the LIVE id for production).
    paypalClientId: '',
    // Subscription plan id (P-XXXXXXXXXXXX) for the ¥700/month plan.
    paypalPlanId: '',
    // PayPal reports subscription amounts in this currency.
    currency: 'JPY',
  },
  tagline: '研究者のための、無料で始められる 3D DICOM ワークステーション',
  descriptionMeta:
    'GRAPHY は研究のための DICOM ワークステーション。2D・MPR・Curved MPR・3D シネマティックレンダリング・Radiomics 定量までオフラインで。Windows / macOS / Linux 対応、無料。',

  nav: [
    { label: 'GRAPHY-Next', href: '/next' },
    { label: 'classic', href: '/classic' },
    { label: 'Lab', href: '/lab' },
    { label: 'Demo', href: '/demo', comingSoon: true },
    { label: 'ダウンロード', href: '/download' },
  ] as NavItem[],
} as const;

/** Reused disclaimer line — shown in the footer and on download pages. */
export const disclaimerShort =
  '研究用途・非診断 / Not for diagnostic use';

export const home = {
  heroTitle: '次世代 DICOM ワークステーション、無料で。',
  heroSub:
    'インストールするだけで、2D・MPR・Curved MPR・3D シネマティックレンダリング・Radiomics 定量までオフラインで完結。Windows / macOS / Linux。',
  products: [
    {
      key: 'next',
      symbol: '◈',
      name: 'GRAPHY-Next',
      desc: '次世代版。スタンドアロン（オフライン）と Web（外部 PACS 連携）の 2 モード。',
      href: '/next',
    },
    {
      key: 'classic',
      symbol: '◇',
      name: 'GRAPHY classic',
      desc: '実績ある Java Swing 版。前身であり、寄付で運営を支えられます。',
      href: '/classic',
    },
    {
      key: 'lab',
      symbol: '⚗',
      name: 'GRAPHY Lab',
      desc: '使い方ガイドとプラグイン。拡張して自分の研究に合わせる。',
      href: '/lab',
    },
  ],
};

/** GRAPHY-Next feature grid. */
export const nextFeatures: Feature[] = [
  { icon: '🩻', title: '2D ビューア', desc: 'スタック表示・W/L プリセット・シネ・輝度校正（HU / SUV を一元管理）。' },
  { icon: '🧭', title: 'MPR', desc: '直交 3 断面のリスライス。ガントリチルト対応。' },
  { icon: '✂️', title: 'Slicer / Curved MPR', desc: '任意角オブリーク、芯線に沿った 3 種の CPR。' },
  { icon: '🧊', title: '3D（VTK.js）', desc: 'ボリューム / サーフェス、シネマティックレンダリング、3D 計測・カット。' },
  { icon: '🎯', title: 'ROI / マスク', desc: '2D ROI 描画・管理、マスク塗り、ROI ↔ メッシュ変換。' },
  { icon: '📊', title: 'Radiomics', desc: 'RadiomicsJ 連携によるテクスチャ解析（設定 UI）。' },
  { icon: '🔥', title: 'PET / CT Fusion', desc: 'フュージョンオーバーレイ、SUV 校正（body weight ほか）。' },
  { icon: '🌐', title: 'DICOM 通信', desc: '保管庫・DIMSE・DICOMweb・REST、Query/Retrieve、リモート送信。' },
  { icon: '🧩', title: 'プラグイン / 日英', desc: 'プラグイン機構、日本語・英語 UI。' },
];

export const nextModes = [
  {
    name: 'スタンドアロン',
    desc: 'Electron デスクトップ。ローカル H2 / ファイルシステムに保管し、DICOM 受信から全ビューア機能までオフラインで動作。',
  },
  {
    name: 'Web',
    desc: 'ブラウザから外部 PACS（DICOMweb / QIDO・WADO）に接続する BFF。画像は PACS 側に置いたまま参照表示。',
  },
];

/** GRAPHY classic feature list (Java Swing predecessor). */
export const classicFeatures: Feature[] = [
  { icon: '🩻', title: '2D / 3D ビューア', desc: '2D ビューア、3D ビューア、MPR。' },
  { icon: '🎯', title: 'ROI 解析', desc: 'ROI による定量解析。' },
  { icon: '🌐', title: 'DICOM I/O', desc: 'ローカル DIMSE、最小ローカル DB（Derby）。' },
  { icon: '🧩', title: 'プラグイン', desc: 'プラグインインターフェースで機能拡張。' },
  { icon: '💿', title: 'CD / DVD 書き込み', desc: 'WEASIS 連携での書き込み（Windows のみ）。' },
];

export const lab = {
  intro: '使い方とプラグイン。GRAPHY を学び、拡張する。',
  howtoUrl: 'https://tatsunidas.github.io/GRAPHY/',
  sections: [
    { title: 'How-to', desc: '基本操作・各ビューアの使い方（ユーザーマニュアル）。', href: 'https://tatsunidas.github.io/GRAPHY/' },
    { title: 'プラグイン開発ガイド', desc: 'プラグイン機構・API・雛形・ビルド手順。', href: 'https://github.com/tatsunidas/GRAPHY-Next' },
  ],
  // NOTE: publication of each plugin repo is pending confirmation — flip `published`
  // per card once approved. Cards render only when published === true.
  plugins: [
    { name: 'CT Fat Analyzer', tagline: 'CT の脂肪定量解析プラグイン。', published: false },
    { name: 'Aneurysm Detector', tagline: 'MRA を対象とした脳動脈瘤検出。', published: false },
    { name: 'Computed DWI', tagline: '計算 DWI の生成。', published: false },
    { name: 'Lesion Evanesco', tagline: '病変処理プラグイン。', published: false },
  ] as PluginCard[],
};

export const footer = {
  columns: [
    {
      heading: '製品',
      links: [
        { label: 'GRAPHY-Next', href: '/next' },
        { label: 'GRAPHY classic', href: '/classic' },
        { label: 'GRAPHY Lab', href: '/lab' },
        { label: 'ダウンロード', href: '/download' },
        { label: 'サポート購読', href: '/support' },
      ],
    },
    {
      heading: 'リソース',
      links: [
        { label: 'How-to (GitHub Pages)', href: 'https://tatsunidas.github.io/GRAPHY/' },
        { label: 'GitHub: GRAPHY-Next', href: 'https://github.com/tatsunidas/GRAPHY-Next' },
        { label: 'GitHub: GRAPHY', href: 'https://github.com/tatsunidas/GRAPHY' },
      ],
    },
    {
      heading: '会社',
      links: [
        { label: 'Visionary Imaging Services', href: 'https://vis-ionary.com' },
        { label: 'お問い合わせ', href: 'mailto:customerservices@vis-ionary.com' },
      ],
    },
    {
      heading: '法務',
      links: [
        { label: '免責事項', href: '/legal/disclaimer' },
        { label: '利用規約', href: '/legal/terms' },
        { label: 'プライバシー', href: '/legal/privacy' },
        { label: 'ライセンス', href: '/legal/licenses' },
      ],
    },
  ],
};
