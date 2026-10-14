// Drive 側のフォルダの確認と作成（main が行う。fw/gdrive-p0.md）。
//
// drive.file では既存フォルダの中身は見えない。Picker で選ばれた「親」には作成だけができる
// （マイドライブ・共有ドライブとも実測済み）。共有ドライブかどうかは、親の driveId で判る。

const API = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** Drive の名前に使えない文字（/ と制御文字）を除き、長さを抑える。 */
function safeName(s) {
  return String(s || "").replace(/[\/\\\u0000-\u001f]/g, "_").trim().slice(0, 100) || "db";
}

/** 日付（YYYYMMDD）。名前の衝突を避けるため。 */
function stamp(now = new Date()) {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Picker で選ばれた親を確かめ、その下にバックアップ用フォルダを作る。
 * @returns {Promise<{ok:true, folderId:string, driveId:string|null, parentName:string, name:string}|{ok:false, error:string}>}
 */
async function createBackupFolder({ token, parentId, dbName, fetchImpl = fetch, now = new Date() }) {
  const headers = { Authorization: `Bearer ${token}` };
  const get = await fetchImpl(
    `${API}/files/${encodeURIComponent(parentId)}?supportsAllDrives=true&fields=id,name,mimeType,driveId,trashed,capabilities(canAddChildren)`,
    { headers },
  );
  if (!get.ok) return { ok: false, error: `parent-${get.status}` };
  const parent = await get.json();
  if (parent.mimeType !== FOLDER_MIME || parent.trashed) return { ok: false, error: "parent-not-folder" };
  if (parent.capabilities && parent.capabilities.canAddChildren === false) return { ok: false, error: "parent-read-only" };
  const name = `GRAPHY-DB-${safeName(dbName)}-${stamp(now)}`;
  const created = await fetchImpl(`${API}/files?supportsAllDrives=true&fields=id,driveId`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  if (!created.ok) return { ok: false, error: `create-${created.status}` };
  const f = await created.json();
  if (typeof f.id !== "string") return { ok: false, error: "create-no-id" };
  return { ok: true, folderId: f.id, driveId: f.driveId || parent.driveId || null, parentName: String(parent.name || ""), name };
}

module.exports = { createBackupFolder, safeName, stamp };
