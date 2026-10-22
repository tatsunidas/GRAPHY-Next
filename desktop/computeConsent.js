// 外部の計算機へ送る前の同意画面（main が描く）。設計: fw/remote-compute-design.md §4.2
//
// なぜ main が描くのか:
//   外部 AI の同意（AiEgressConsentDialog）はレンダラが描く。プラグインはレンダラと同じ realm に
//   入るので、レンダラ内の同意は迂回・偽装できる。こちらは**任意のコードが外の計算機で動く**ので、
//   プラグインが触れない窓（専用の preload・別の webContents）で聞く。作り方はスプラッシュと同じ。
//
// 守っていること:
//   - 出す内容は main が backend から**自分で取り直したもの**（レンダラが渡した内容は使わない）
//   - 「内容を確認しました」にチェックを入れるまで送信ボタンは押せない（AI の同意と同じ規則）
//   - 決定を受け付けるのは**この窓の webContents からだけ**
//   - 同時に開くのは 1 つだけ。期限（backend の札は 5 分）より前に自動で取り消す

const { BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

const TIMEOUT_MS = 4.5 * 60 * 1000;

const STRINGS = {
  ja: {
    title: "外部の計算機へ送信します",
    lead: "プラグイン「{plugin}」が、次の計算機でコードを実行しようとしています。",
    destination: "送信先",
    plaintext: "⚠ 暗号化されない http で送られます（院内のサーバに限り許可されています）。",
    thisPc: "この PC",
    titleLocal: "この PC でコードを実行します",
    leadLocal: "プラグイン「{plugin}」が、この PC の Python でコードを実行しようとしています。",
    localNote: "GRAPHY はデータをこの PC の外へ送りません。ただし、実行するコードはこの PC の上であなたの権限で動くため、ファイルやネットワークにも触れられます。次のコードをよく確認してください。",
    localBurnNote: "⚠ このデータは単純X線（CR/DX/MG）で、画素に焼き込まれた文字（氏名・ID など）は塗らずに、この PC の計算機だけへ渡します。外部の計算機には送れません。",
    anonymization: "匿名化",
    datasets: "送るデータ",
    noData: "なし（画像は送りません。コードだけを実行します）",
    colModality: "種類",
    colInstances: "画像数",
    colFormat: "形式",
    colSize: "大きさ",
    colBurned: "焼き込みを塗った画像",
    colSha: "SHA-256",
    colKey: "組",
    batchSummary: "{items} 組・データ {datasets} 件・合計 {size}（同じコードを組ごとに実行します。同意は全組をまとめて 1 回です）",
    noInputItem: "（入力なし）",
    refusedTitle: "送らない組（{n} 組。送れないため外しました）",
    unknown: "不明",
    rerunSame: "再実行（{n} 回目）です。記録の版 {recorded}・今の版 {current}（同じ版）。記録のコードを、もう一度ここに送って実行します。",
    rerunChanged: "⚠ 再実行（{n} 回目）です。記録の版 {recorded}／今の版 {current}（違います）。今のプラグインではなく、記録のコードを実行します（結果の受け取りは今のプラグインが行います）。",
    code: "実行するコード（全文）",
    codeMeta: "{lines} 行・SHA-256 {sha}",
    ack: "送るデータと、実行するコードの全文を確認しました。",
    send: "送信する",
    cancel: "取り消す",
  },
  en: {
    title: "Send to an external computer",
    lead: "The plugin \"{plugin}\" wants to run code on the following computer.",
    destination: "Destination",
    plaintext: "⚠ Sent over unencrypted http (allowed only for in-house servers).",
    thisPc: "This PC",
    titleLocal: "Run code on this PC",
    leadLocal: "The plugin \"{plugin}\" wants to run code with Python on this PC.",
    localNote: "GRAPHY does not send the data outside this PC. However, the code runs on this PC with your permissions, so it can reach your files and the network. Review the code below carefully.",
    localBurnNote: "⚠ This data is plain radiography (CR/DX/MG). Text burned into the pixels (name, ID, etc.) is not painted out; the data goes only to this PC's local computer and cannot be sent to an external computer.",
    anonymization: "De-identification",
    datasets: "Data to send",
    noData: "None (no images are sent; only the code runs)",
    colModality: "Modality",
    colInstances: "Images",
    colFormat: "Format",
    colSize: "Size",
    colBurned: "Images with burned-in text painted",
    colSha: "SHA-256",
    colKey: "Item",
    batchSummary: "{items} items · {datasets} datasets · {size} in total (the same code runs once per item; one consent covers all items)",
    noInputItem: "(no input)",
    refusedTitle: "Not sent ({n} items could not be sent and were left out)",
    unknown: "unknown",
    rerunSame: "This is a re-run (attempt {n}). Recorded version {recorded}, current version {current} (same). The recorded code will be sent and run again.",
    rerunChanged: "⚠ This is a re-run (attempt {n}). Recorded version {recorded} / current version {current} (different). The recorded code runs, not the current plugin's (the current plugin receives the results).",
    code: "Code to run (full text)",
    codeMeta: "{lines} lines · SHA-256 {sha}",
    ack: "I have reviewed the data to be sent and the full code to be run.",
    send: "Send",
    cancel: "Cancel",
  },
};

/** 開いている同意画面（webContents.id → { win, resolve }）。 */
const open = new Map();

ipcMain.on("compute-consent:ready", (e) => {
  const entry = open.get(e.sender.id);
  if (entry) e.sender.send("compute-consent:show", entry.payload);
});

ipcMain.on("compute-consent:decide", (e, approve) => {
  // 🔴 この窓以外からの決定は受け付けない（レンダラ＝プラグインは送れない）
  const entry = open.get(e.sender.id);
  if (!entry) return;
  entry.finish(approve === true);
});

function busy() {
  return open.size > 0;
}

/**
 * 同意を聞く。
 * @param parent  親ウィンドウ（無ければ null）
 * @param detail  backend の EgressRequest（main が取り直したもの）
 * @param locale  "ja" | "en"
 * @returns Promise<boolean> 送信してよいなら true
 */
function ask(parent, detail, locale) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      modal: !!(parent && !parent.isDestroyed()),
      width: 820,
      height: 720,
      minWidth: 560,
      minHeight: 480,
      title: (STRINGS[locale] || STRINGS.ja).title,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "computeConsent-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    const id = win.webContents.id;
    let done = false;
    const timer = setTimeout(() => finish(false), TIMEOUT_MS);
    function finish(approve) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      open.delete(id);
      if (!win.isDestroyed()) win.destroy();
      resolve(approve);
    }
    open.set(id, { finish, payload: { detail, strings: STRINGS[locale] || STRINGS.ja } });
    // 窓の外へは出さない（リンクも新しい窓も開かない）
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (ev) => ev.preventDefault());
    win.on("closed", () => finish(false));
    win.once("ready-to-show", () => win.show());
    win.loadFile(path.join(__dirname, "computeConsent.html"));
  });
}

module.exports = { ask, busy, STRINGS };
