/*
 * Google Drive 対応（P0 スパイク）の実機検証。計画: ~/.claude/plans/graphy-next-db-googledrive-agile-cupcake.md
 *
 * 実行:  cd automator && npx tsx src/spike/gdriveApiCheck.ts
 *
 * 🔴 **人の操作が要る**: 初回はブラウザが開く（URL をログにも出す）。テストユーザーのアカウントで drive.file を許可する。
 *    refresh token は SPIKE_TOKEN_FILE（既定 ./.gdrive-spike-token.json・gitignore 対象外なのでコミットしない）に置く。
 * 🔴 マイドライブに `GRAPHY-DB-spike-<時刻>/` を作る。終わりに GDRIVE_SPIKE_KEEP=1 でなければゴミ箱へ。
 *
 * 確かめること（drive.file のみで）:
 *   1. PKCE（loopback）でログインできる
 *   2. アプリが作ったフォルダ配下で 作成・一覧・md5 照合ができる
 *   3. resumable upload を途中で止め、状態を問い合わせて続きから再開できる
 *   4. appProperties による冪等な再送（同じ sopUid を二重に作らない）
 *   5. drive.file では root 直下の「アプリが作っていない」ファイルが見えない
 *   6. 共有ドライブ一覧（drives.list）が drive.file で呼べるか ← 未確認事項。結果をそのまま記録する
 *
 * 前提: desktop/gdrive-oauth-client.json（"installed"）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";

const CLIENT_FILE = path.resolve("..", "desktop", "gdrive-oauth-client.json");
const TOKEN_FILE = process.env.SPIKE_TOKEN_FILE ?? path.resolve(".gdrive-spike-token.json");
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const CHUNK = 256 * 1024;

const results: { name: string; status: "合格" | "失敗" | "未達"; note: string }[] = [];
const rec = (name: string, status: "合格" | "失敗" | "未達", note = "") => {
  results.push({ name, status, note });
  console.log(`[${status}] ${name} ${note}`);
};
const b64url = (b: Buffer) => b.toString("base64url");

const client = JSON.parse(fs.readFileSync(CLIENT_FILE, "utf8")).installed;

async function tokenRequest(params: Record<string, string>) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, ...params }),
  });
  if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`);
  return (await r.json()) as { access_token: string; refresh_token?: string; scope?: string };
}

async function login(): Promise<string> {
  if (fs.existsSync(TOKEN_FILE)) {
    const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    try {
      return (await tokenRequest({ grant_type: "refresh_token", refresh_token: saved.refresh_token })).access_token;
    } catch (e) {
      console.log("保存済みトークンが使えない。ログインし直す:", (e as Error).message);
    }
  }
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const code = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
    const server = http.createServer();
    const timer = setTimeout(() => { server.close(); reject(new Error("login-timeout")); }, 10 * 60 * 1000);
    server.listen(0, "127.0.0.1", () => {
      const redirect = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: client.client_id, redirect_uri: redirect, response_type: "code", scope: SCOPE,
        code_challenge: challenge, code_challenge_method: "S256", state, access_type: "offline", prompt: "consent",
      })}`;
      console.log("ブラウザで許可してください:\n" + url);
      execFile("xdg-open", [url], () => undefined);
      server.on("request", (req, res) => {
        const q = new URL(req.url ?? "/", redirect).searchParams;
        if (!q.get("code") && !q.get("error")) { res.statusCode = 404; res.end(); return; }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end("<p>受け取りました。閉じてかまいません。</p>");
        clearTimeout(timer); server.close();
        if (q.get("error") || q.get("state") !== state) reject(new Error(`oauth ${q.get("error") ?? "state-mismatch"}`));
        else resolve({ code: q.get("code")!, redirect });
      });
    });
  });
  const t = await tokenRequest({
    grant_type: "authorization_code", code: code.code, redirect_uri: code.redirect, code_verifier: verifier,
  });
  if (!t.refresh_token) throw new Error("refresh_token が返らなかった");
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token: t.refresh_token }), { mode: 0o600 });
  console.log("付与されたスコープ:", t.scope);
  return t.access_token;
}

let bearer = "";
const hdr = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${bearer}`, ...extra });
async function api(method: string, url: string, body?: unknown) {
  const r = await fetch(url, {
    method, headers: hdr(body ? { "Content-Type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}

async function startResumable(name: string, parent: string, sopUid: string, size: number) {
  const r = await fetch(`${UPLOAD}?uploadType=resumable&supportsAllDrives=true&fields=id,md5Checksum,size`, {
    method: "POST",
    headers: hdr({ "Content-Type": "application/json", "X-Upload-Content-Length": String(size) }),
    body: JSON.stringify({ name, parents: [parent], appProperties: { sopUid } }),
  });
  if (!r.ok) throw new Error(`resumable start ${r.status}: ${await r.text()}`);
  return r.headers.get("location")!;
}

async function putRange(session: string, data: Buffer, from: number, to: number, total: number) {
  return fetch(session, {
    method: "PUT",
    headers: hdr({ "Content-Range": `bytes ${from}-${to - 1}/${total}`, "Content-Length": String(to - from) }),
    body: new Uint8Array(data.subarray(from, to)),
  });
}

/** 受け取り済みのバイト数（308 の Range）。 */
async function queryOffset(session: string, total: number): Promise<number> {
  const r = await fetch(session, { method: "PUT", headers: hdr({ "Content-Range": `bytes */${total}`, "Content-Length": "0" }) });
  if (r.status !== 308) throw new Error(`状態問い合わせ ${r.status}`);
  const range = r.headers.get("range");
  return range ? Number(range.split("-")[1]) + 1 : 0;
}

async function main() {
  bearer = await login();
  rec("1 PKCE ログイン", "合格");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const folder = await api("POST", `${API}/files?supportsAllDrives=true&fields=id`, {
    name: `GRAPHY-DB-spike-${stamp}`, mimeType: "application/vnd.google-apps.folder",
  });
  if (folder.status !== 200) { rec("2 フォルダ作成", "失敗", JSON.stringify(folder.json)); return finish(); }
  const root: string = folder.json.id;
  rec("2a フォルダ作成", "合格", root);

  // 2/3: 1.5MB を 256KiB の倍数で送り、3 チャンク目で中断して再開する
  const data = crypto.randomBytes(CHUNK * 6);
  const md5 = crypto.createHash("md5").update(data).digest("hex");
  const sopUid = `1.2.3.${Date.now()}`;
  const session = await startResumable("spike.dcm", root, sopUid, data.length);
  let r = await putRange(session, data, 0, CHUNK * 3, data.length);
  if (r.status !== 308) return finish(rec("3 最初のチャンク", "失敗", `status ${r.status}`));
  // 中断: 4 チャンク目は途中までしか届かなかった想定で、サーバーが持つ位置を問い合わせる
  const offset = await queryOffset(session, data.length);
  rec("3a 中断後の受信位置を取得", offset === CHUNK * 3 ? "合格" : "失敗", `offset=${offset} 期待=${CHUNK * 3}`);
  r = await putRange(session, data, offset, data.length, data.length);
  const done = r.status === 200 || r.status === 201 ? await r.json() : null;
  rec("3b 続きから再開して完了", done ? "合格" : "失敗", `status ${r.status}`);
  if (done) rec("2b md5 照合", done.md5Checksum === md5 ? "合格" : "失敗", `${done.md5Checksum} / ${md5}`);

  // 4: 冪等 — sopUid で検索して既存なら作らない
  const found = await api("GET", `${API}/files?q=${encodeURIComponent(`appProperties has { key='sopUid' and value='${sopUid}' } and '${root}' in parents and trashed=false`)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  rec("4 appProperties で既存を検出（再送を作らない）", found.json?.files?.length === 1 ? "合格" : "失敗", `件数=${found.json?.files?.length}`);

  // 5: root 直下に、アプリが作っていないファイルが見えないこと
  const rootList = await api("GET", `${API}/files?q=${encodeURIComponent("'root' in parents and trashed=false")}&fields=files(id,name)&pageSize=50`);
  const names: string[] = (rootList.json?.files ?? []).map((f: { name: string }) => f.name);
  const onlyOurs = names.every((n) => n.startsWith("GRAPHY-DB-spike-"));
  rec("5 drive.file は root 直下の他ファイルを返さない", rootList.status === 200 && onlyOurs ? "合格" : "失敗",
    `status=${rootList.status} 件数=${names.length}（先頭: ${names.slice(0, 3).join(", ")}）`);

  // 6: 共有ドライブ一覧（未確認事項。結果をそのまま記録）
  const drives = await api("GET", `${API}/drives?pageSize=20`);
  rec("6 drives.list が drive.file で呼べる", drives.status === 200 ? "合格" : "失敗",
    drives.status === 200 ? `共有ドライブ ${drives.json.drives?.length ?? 0} 件` : `${drives.status} ${JSON.stringify(drives.json?.error?.message)}`);

  if (process.env.GDRIVE_SPIKE_KEEP !== "1") {
    const t = await api("PATCH", `${API}/files/${root}?supportsAllDrives=true`, { trashed: true });
    rec("後始末（ゴミ箱へ）", t.status === 200 ? "合格" : "失敗", `status ${t.status}`);
  }
  finish();
}

function finish(_?: unknown) {
  const c = (s: string) => results.filter((x) => x.status === s).length;
  console.log(`\n合格 ${c("合格")} / 失敗 ${c("失敗")} / 未達 ${c("未達")}`);
  process.exit(c("失敗") ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
