// 画像の URL は XHR 差し替え（mediaRoute.ts）が媒体の実ファイルへ向け直す。ここは仮の接頭辞。
export const apiBase = (): string => "/__media";
