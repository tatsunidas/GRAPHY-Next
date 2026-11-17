// 終了の確認ダイアログの文言（ja / en）。main.js の dialog.showMessageBox に渡す形を作る純関数。
const KIND = {
  ja: {
    import: "取り込み",
    urlImport: "URL からの取り込み",
    export: "エクスポート",
    anonymize: "匿名化",
    seriesExtract: "シリーズ抽出",
    qrRetrieve: "QR の取得",
    plugin: "プラグインの処理",
    compute: "計算ジョブ",
    texture: "テクスチャ解析",
    filteredSeries: "フィルタ画像の作成",
    roiFeature: "ROI の特徴量抽出",
    send: "DICOM 送信",
    qrGetMove: "QR の C-GET / C-MOVE",
    dbTransfer: "DB 間の転送",
    dbEdit: "DB の編集（削除・統合・患者情報の変更）",
    reportSave: "レポートの保存",
    watchScan: "監視フォルダの走査",
    gdrive: "Google Drive の同期",
    dbInbox: "DB 取り込み箱の処理",
    anonymizeRun: "匿名化（ZIP 作成・フォルダへのコピー）",
    exportRun: "エクスポート（ZIP・NIfTI）",
    seriesExtractRun: "シリーズ抽出（コピー・ZIP・検証）",
    importRun: "取り込み（パス指定・非 DICOM・NIfTI・RAW・顕微鏡・ImageJ）",
    prefetchRun: "事前取得",
    analysisRun: "解析（テクスチャ・GLAM・最大断面・派生シリーズ）",
  },
  en: {
    import: "Import",
    urlImport: "Import from URL",
    export: "Export",
    anonymize: "Anonymization",
    seriesExtract: "Series extraction",
    qrRetrieve: "QR retrieve",
    plugin: "Plug-in task",
    compute: "Compute job",
    texture: "Texture analysis",
    filteredSeries: "Filtered series",
    roiFeature: "ROI feature extraction",
    send: "DICOM send",
    qrGetMove: "QR C-GET / C-MOVE",
    dbTransfer: "DB transfer",
    dbEdit: "DB edit (delete / merge / patient info)",
    reportSave: "Saving a report",
    watchScan: "Watch-folder scan",
    gdrive: "Google Drive sync",
    dbInbox: "DB inbox processing",
    anonymizeRun: "Anonymization (ZIP / copy to folder)",
    exportRun: "Export (ZIP / NIfTI)",
    seriesExtractRun: "Series extraction (copy / ZIP / verify)",
    importRun: "Import (paths / non-DICOM / NIfTI / RAW / microscopy / ImageJ)",
    prefetchRun: "Prefetch",
    analysisRun: "Analysis (texture / GLAM / max section / derived series)",
  },
};

const T = {
  ja: {
    title: "GRAPHY-Next を終了",
    stay: "終了しない",
    quitCancel: "中止して終了",
    quitWait: "終了する",
    head: "実行中の処理があります。",
    cancelHead: "終了すると中止されます:",
    waitHead: "中止できないため、終わるのを待ってから終了します（最大 10 秒）:",
    unknown: "実行中の処理を確認できませんでした（アプリの内部が応答しません）。終了すると、実行中の処理は中断されます。",
    count: (n) => `${n} 件`,
  },
  en: {
    title: "Quit GRAPHY-Next",
    stay: "Don't quit",
    quitCancel: "Cancel and quit",
    quitWait: "Quit",
    head: "Some tasks are still running.",
    cancelHead: "These will be cancelled if you quit:",
    waitHead: "These cannot be cancelled; quitting waits for them to finish (up to 10 s):",
    unknown: "Could not check for running tasks (the app's backend is not responding). Quitting will interrupt anything that is running.",
    count: (n) => `${n}`,
  },
};

/** items: [{kind, count, cancellable}]。返すのは dialog.showMessageBox の引数（buttons[0]＝終了しない が既定・取り消し）。 */
function buildQuitDialog({ items, unknown, locale }) {
  const loc = locale === "ja" ? "ja" : "en";
  const t = T[loc];
  const label = (k) => KIND[loc][k] || k;
  const line = (i) => `  ・${label(i.kind)}: ${t.count(i.count)}`;
  const cancellable = items.filter((i) => i.cancellable);
  const waiting = items.filter((i) => !i.cancellable);
  // title はウィンドウの題、message は見出し（題の繰り返しにしない）、detail は一覧
  const parts = [];
  if (!unknown) {
    if (cancellable.length) parts.push(t.cancelHead, ...cancellable.map(line));
    if (waiting.length) parts.push(t.waitHead, ...waiting.map(line));
  }
  return {
    type: "warning",
    title: t.title,
    message: unknown ? t.unknown : t.head,
    detail: parts.join("\n"),
    buttons: [t.stay, cancellable.length || unknown ? t.quitCancel : t.quitWait],
    defaultId: 0,
    cancelId: 0,
  };
}

module.exports = { buildQuitDialog, KIND };
