/*
 * Google Drive 対応（P0 スパイク その2）: Picker と「選んだ既存フォルダ」の扱い。
 *
 * 実行:  cd automator && SPIKE_TOKEN_FILE=<gdriveApiCheck と同じ> npx tsx src/spike/gdrivePickerCheck.ts
 *
 * 🔴 人の操作が要る: ブラウザに Picker が開くので、フォルダを 1 つ選ぶ。
 *    マイドライブの「中に自分のファイルがあるフォルダ」と、共有ドライブ配下のフォルダで 1 回ずつ実行する。
 *    ※ この段のブラウザは利用者の既定ブラウザ（Electron の窓ではない）。Electron での表示は P1 で確かめる。
 *
 * 確かめること（drive.file のみ）:
 *   1. Picker でフォルダ（マイドライブ／共有ドライブ）が選べ、driveId が取れるか
 *   2. 選んだ既存フォルダの子（アプリが作っていないファイル）が files.list で見えるか
 *   3. 選んだフォルダの直下にフォルダを作れるか・そこへ resumable upload できるか（supportsAllDrives）
 *
 * 前提: desktop/gdrive-oauth-client.json・~/.config/GRAPHY-Next/gdrive-api-key.txt・保存済みの refresh token。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const client = JSON.parse(fs.readFileSync(path.resolve("..", "desktop", "gdrive-oauth-client.json"), "utf8")).installed;
const apiKey = fs.readFileSync(path.join(os.homedir(), ".config", "GRAPHY-Next", "gdrive-api-key.txt"), "utf8").trim();
const TOKEN_FILE = process.env.SPIKE_TOKEN_FILE ?? path.resolve(".gdrive-spike-token.json");
const projectNumber = client.client_id.split("-")[0];
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

const results: { name: string; status: "合格" | "失敗" | "未達"; note: string }[] = [];
const rec = (name: string, status: "合格" | "失敗" | "未達", note = "") => {
  results.push({ name, status, note });
  console.log(`[${status}] ${name} ${note}`);
};

async function accessToken(): Promise<string> {
  const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id, client_secret: client.client_secret,
      grant_type: "refresh_token", refresh_token: saved.refresh_token,
    }),
  });
  if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
}

const PAGE = (token: string) => `<!doctype html><meta charset="utf-8"><title>Picker spike</title>
<p id="m">Picker を開いています…（開かなければ再読み込み）</p>
<script src="https://apis.google.com/js/api.js"></script>
<script>
const done = (o) => fetch('/picked', {method:'POST', body: JSON.stringify(o)}).then(() => { document.getElementById('m').textContent = '受け取りました。閉じてかまいません。'; });
gapi.load('picker', () => {
  const mk = () => new google.picker.DocsView(google.picker.ViewId.FOLDERS)
    .setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes('application/vnd.google-apps.folder');
  new google.picker.PickerBuilder()
    .addView(mk().setLabel('マイドライブ').setParent('root'))
    .addView(mk().setLabel('共有ドライブ').setEnableDrives(true))
    .enableFeature(google.picker.Feature.SUPPORT_DRIVES)
    .setOAuthToken(${JSON.stringify(token)})
    .setDeveloperKey(${JSON.stringify(apiKey)})
    .setAppId(${JSON.stringify(projectNumber)})
    .setCallback((d) => {
      if (d.action === 'picked') done({id: d.docs[0].id, name: d.docs[0].name});
      if (d.action === 'cancel') done({cancel: true});
    })
    .build().setVisible(true);
});
</script>`;

async function pick(token: string): Promise<{ id?: string; name?: string; cancel?: boolean }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/picked") {
        let b = ""; req.on("data", (c) => (b += c));
        req.on("end", () => { res.end("ok"); clearTimeout(timer); server.close(); resolve(JSON.parse(b)); });
        return;
      }
      if (req.url === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(PAGE(token)); return; }
      res.statusCode = 404; res.end();
    });
    const timer = setTimeout(() => { server.close(); reject(new Error("pick-timeout")); }, 10 * 60 * 1000);
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
      console.log("ブラウザで Picker が開きます（開かなければこの URL を開く）:", url);
      execFile("xdg-open", [url], () => undefined);
    });
  });
}

async function main() {
  const token = await accessToken();
  const H = { Authorization: `Bearer ${token}` };
  const j = async (u: string, init?: RequestInit) => {
    const r = await fetch(u, { ...init, headers: { ...H, ...(init?.headers as object) } });
    const t = await r.text();
    return { status: r.status, json: t ? JSON.parse(t) : null };
  };

  const p = await pick(token);
  if (p.cancel || !p.id) return finish(rec("1 Picker でフォルダを選ぶ", "未達", "キャンセル"));
  rec("1a Picker でフォルダを選べた", "合格", `id=${p.id}`);

  const meta = await j(`${API}/files/${p.id}?supportsAllDrives=true&fields=id,name,mimeType,driveId,parents,capabilities(canAddChildren,canListChildren)`);
  if (meta.status !== 200) return finish(rec("1b 選んだフォルダのメタデータ", "失敗", `${meta.status} ${JSON.stringify(meta.json?.error?.message)}`));
  const where = meta.json.driveId ? `共有ドライブ driveId=${meta.json.driveId}` : "マイドライブ（driveId なし）";
  rec("1b メタデータ取得", "合格", `${where} / canAddChildren=${meta.json.capabilities?.canAddChildren}`);

  const q = encodeURIComponent(`'${p.id}' in parents and trashed=false`);
  const kids = await j(`${API}/files?q=${q}&fields=files(id,name,mimeType)&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true${meta.json.driveId ? `&corpora=drive&driveId=${meta.json.driveId}` : ""}`);
  rec("2 選んだ既存フォルダの子が見える（アプリが作っていないもの）", kids.status === 200 && (kids.json.files?.length ?? 0) > 0 ? "合格" : "失敗",
    `status=${kids.status} 件数=${kids.json?.files?.length ?? "?"}（${kids.status !== 200 ? JSON.stringify(kids.json?.error?.message) : "0 件なら見えないか空。フォルダの中身をご確認ください"}）`);

  const sub = await j(`${API}/files?supportsAllDrives=true&fields=id`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `GRAPHY-DB-spike-${Date.now()}`, mimeType: "application/vnd.google-apps.folder", parents: [p.id] }),
  });
  if (sub.status !== 200) return finish(rec("3a 選んだフォルダ直下にフォルダ作成", "失敗", `${sub.status} ${JSON.stringify(sub.json?.error?.message)}`));
  rec("3a 選んだフォルダ直下にフォルダ作成", "合格", sub.json.id);

  const data = crypto.randomBytes(256 * 1024 * 2);
  const md5 = crypto.createHash("md5").update(data).digest("hex");
  const start = await fetch(`${UPLOAD}?uploadType=resumable&supportsAllDrives=true&fields=id,md5Checksum`, {
    method: "POST", headers: { ...H, "Content-Type": "application/json", "X-Upload-Content-Length": String(data.length) },
    body: JSON.stringify({ name: "spike.dcm", parents: [sub.json.id] }),
  });
  if (!start.ok) { rec("3b resumable upload 開始", "失敗", `${start.status} ${await start.text()}`); }
  else {
    const put = await fetch(start.headers.get("location")!, {
      method: "PUT", headers: { ...H, "Content-Range": `bytes 0-${data.length - 1}/${data.length}` }, body: data,
    });
    const done = put.ok ? await put.json() : null;
    rec("3b 直下のフォルダへ upload・md5 一致", done?.md5Checksum === md5 ? "合格" : "失敗", `status=${put.status}`);
  }
  const t = await j(`${API}/files/${sub.json.id}?supportsAllDrives=true`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }),
  });
  rec("後始末（自作フォルダだけゴミ箱へ）", t.status === 200 ? "合格" : "失敗", `status=${t.status}`);
  finish();
}

function finish(_?: unknown) {
  const c = (s: string) => results.filter((x) => x.status === s).length;
  console.log(`\n合格 ${c("合格")} / 失敗 ${c("失敗")} / 未達 ${c("未達")}`);
  process.exit(c("失敗") ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
