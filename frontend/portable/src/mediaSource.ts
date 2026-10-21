/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Portable 2D Viewer — 起動スクリプトのローカルサーバ経由で媒体を読む（自動認識）。
// ビューアは `http://127.0.0.1:<port>/<token>/VIEWER/index.html` で開かれる。同じ `<token>/` 配下の
// `DICOMDIR` と `DICOM/…` をそのまま URL で引ける（フォルダ選択は不要）。
import { parseDicomDirBytes, type DicomDirModel } from "./dicomdir";

/** この文書がローカルサーバから開かれていれば、媒体ルートの URL（末尾 `/`）。そうでなければ null。 */
export function serverBase(loc: Location = window.location): string | null {
  if (loc.protocol !== "http:" && loc.protocol !== "https:") return null;
  const m = loc.pathname.match(/^(\/[0-9a-f]{32}\/)VIEWER\/[^/]*$/);
  return m ? `${loc.origin}${m[1]}` : null;
}

/** 媒体相対パス（`/` 区切り）を URL にする。各セグメントをエンコードする。 */
export function mediaUrl(base: string, relPath: string): string {
  return base + relPath.split("/").map(encodeURIComponent).join("/");
}

/** サーバ上の DICOMDIR を読み、URL を引き当てた木を返す。 */
export async function loadFromServer(base: string): Promise<DicomDirModel> {
  const res = await fetch(`${base}DICOMDIR`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? "媒体のルートに DICOMDIR がありません（DICOMDIR のない媒体は「フォルダを選択」で開けます）"
        : `DICOMDIR を取得できません（HTTP ${res.status}）`,
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return parseDicomDirBytes(bytes, {
    image: (relPath) => ({ url: mediaUrl(base, relPath) }),
    video: (sopUid) => ({ url: mediaUrl(base, `VIDEO/${sopUid}.mp4`) }),
  });
}

/** サーバへ生存を知らせる（ブラウザを閉じると止まり、サーバが自動終了する）。 */
export function startHeartbeat(base: string, everyMs = 20_000): () => void {
  const ping = () => void fetch(`${base}__ping`, { cache: "no-store" }).catch(() => undefined);
  ping();
  const id = window.setInterval(ping, everyMs);
  return () => window.clearInterval(id);
}
