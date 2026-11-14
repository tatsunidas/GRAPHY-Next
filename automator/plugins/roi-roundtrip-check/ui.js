/* 検証専用: host を window に出し、automator が getRois / createRoi を呼べるようにする。 */
export async function activate(host) {
  if (host.surface !== "viewer2d.menu" && host.surface !== "viewer2d.toolbar") return;
  window.__rtHost = host;
}
