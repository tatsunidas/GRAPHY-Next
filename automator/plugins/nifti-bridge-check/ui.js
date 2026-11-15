/*
 * 実機検証用プラグイン（H78・H79〔仮〕）。host を window.__mainHost に置くだけ。検査（pluginNiftiCheck.ts）が直接呼ぶ。
 */
export function activate(host) {
  const w = host.openWindow({ title: "NIfTI Bridge Check", width: 420, height: 140 });
  const p = document.createElement("div");
  p.setAttribute("data-testid", "nifti-bridge-check-panel");
  p.style.padding = "12px";
  p.textContent = `surface=${host.surface} / pluginId=${host.pluginId}`;
  w.container.appendChild(p);
  window.__mainHost = host;
}
