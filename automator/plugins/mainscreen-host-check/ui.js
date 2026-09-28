/*
 * 実機検証用プラグイン（メイン画面の host H42 と、共通の host API H43〜H46）。
 *
 * activate で窓を開き、host をそのまま window.__mainHost に置く。検査（mainScreenHostCheck.ts）は
 * page.evaluate で host のメソッドを直接呼んで結果を見る（DOM は覗かない）。
 * 窓には「開けた」ことが人にも分かる 1 行だけを出す。
 */
export function activate(host) {
  const w = host.openWindow({ title: "Main Screen Host Check", width: 420, height: 160 });
  const p = document.createElement("div");
  p.setAttribute("data-testid", "mainscreen-host-check-panel");
  p.style.padding = "12px";
  p.textContent = `surface=${host.surface} / pluginId=${host.pluginId}`;
  w.container.appendChild(p);
  window.__mainHostWindow = w;
  window.__mainHost = host;
}
