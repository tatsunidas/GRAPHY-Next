// GRAPHY-Next — 別窓（ビューア・アシスタントなど）のメニュー。
//
// 純粋なモジュール（Electron を import しない）。Menu.buildFromTemplate に渡すテンプレートを返す。
//
// メニューを決めないと Electron の既定メニューが付き、macOS 以外では［File］が「Quit」だけになる。
// 別窓で Quit を選ぶと、その窓ではなく本体ごと終了してしまう。別窓の［File］は「この窓を閉じる」にする。
// 本体の終了はメインの窓からだけ。

/**
 * @param {string} platform process.platform
 * @returns {object[] | null} null は「窓ごとのメニューを付けない」（macOS はアプリ共通のメニューで、既定の File が Close）
 */
function viewerMenuTemplate(platform) {
  if (platform === "darwin") return null;
  return [
    { label: "File", submenu: [{ role: "close" }] },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
}

module.exports = { viewerMenuTemplate };
