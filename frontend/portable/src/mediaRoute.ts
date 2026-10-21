// 本体の描画核は画像を `/__media/api/instances/<sop>/file` の URL で引く（本体では backend が配信）。
// ポータブル版では、dicom-image-loader が使う XMLHttpRequest の URL を、媒体の実ファイルへ向け直す。
// 登録した SOP の URL だけを対象にし、それ以外は素通しする。
const routes = new Map<string, string>();
let installed = false;

export function registerMediaRoute(sopUid: string, url: string): void {
  routes.set(`/__media/api/instances/${encodeURIComponent(sopUid)}/file`, url);
  install();
}

function install(): void {
  if (installed) return;
  installed = true;
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    const s = String(url);
    const q = s.search(/[?&]/);
    const path = q >= 0 ? s.slice(0, q) : s;
    const tail = q >= 0 ? s.slice(q) : "";
    const target = routes.get(path);
    return (open as (...a: unknown[]) => void).call(this, method, target ? target + tail : url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
}
