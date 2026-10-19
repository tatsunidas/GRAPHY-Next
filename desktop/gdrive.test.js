// `node --test`。Drive の保存先フォルダの作成と、Picker の結果の受け入れ。
// 🔴 electron を import しない。fetch は差し替える。

const test = require("node:test");
const assert = require("node:assert");
const { createBackupFolder, describeBackupFolder, safeName, stamp } = require("./gdriveFolder");

const json = (status, body) => ({ ok: status < 300, status, json: async () => body });

test("親が共有ドライブのフォルダなら driveId を引き継ぎ、親の直下に supportsAllDrives で作る", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", body: init.body, auth: init.headers && init.headers.Authorization });
    if ((init.method || "GET") === "GET")
      return json(200, { id: "P", name: "Team", mimeType: "application/vnd.google-apps.folder", driveId: "DRIVE-1", capabilities: { canAddChildren: true } });
    return json(200, { id: "NEWFOLDERID", driveId: "DRIVE-1" });
  };
  const r = await createBackupFolder({ token: "tok", parentId: "P", dbName: "data", fetchImpl, now: new Date("2026-10-12T00:00:00Z") });
  assert.deepEqual(r, { ok: true, folderId: "NEWFOLDERID", driveId: "DRIVE-1", parentName: "Team", name: "GRAPHY-DB-data-20261012" });
  assert.ok(calls.every((c) => c.auth === "Bearer tok" && c.url.includes("supportsAllDrives=true")));
  assert.deepEqual(JSON.parse(calls[1].body).parents, ["P"]);
});

test("マイドライブなら driveId は null", async () => {
  const fetchImpl = async (url, init = {}) =>
    (init.method || "GET") === "GET"
      ? json(200, { id: "P", name: "x", mimeType: "application/vnd.google-apps.folder" })
      : json(200, { id: "NEW" });
  const r = await createBackupFolder({ token: "t", parentId: "P", dbName: "d", fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.driveId, null);
});

test("負例: フォルダでない・ゴミ箱・書込不可・取得失敗・作成失敗では作らず理由を返す", async () => {
  const mk = (parent, createStatus = 200) => async (url, init = {}) => {
    if ((init.method || "GET") === "GET") return typeof parent === "number" ? json(parent, {}) : json(200, parent);
    return json(createStatus, { id: "NEW" });
  };
  const F = "application/vnd.google-apps.folder";
  assert.equal((await createBackupFolder({ token: "t", parentId: "P", dbName: "d", fetchImpl: mk({ mimeType: "text/plain" }) })).error, "parent-not-folder");
  assert.equal((await createBackupFolder({ token: "t", parentId: "P", dbName: "d", fetchImpl: mk({ mimeType: F, trashed: true }) })).error, "parent-not-folder");
  assert.equal((await createBackupFolder({ token: "t", parentId: "P", dbName: "d", fetchImpl: mk({ mimeType: F, capabilities: { canAddChildren: false } }) })).error, "parent-read-only");
  assert.equal((await createBackupFolder({ token: "t", parentId: "P", dbName: "d", fetchImpl: mk(404) })).error, "parent-404");
  assert.equal((await createBackupFolder({ token: "t", parentId: "P", dbName: "d", fetchImpl: mk({ mimeType: F }, 403) })).error, "create-403");
});

test("名前: / や制御文字を除く・空は既定名・長さを抑える", () => {
  assert.equal(safeName("a/b\\c\u0001d"), "a_b_c_d");
  assert.equal(safeName(""), "db");
  assert.equal(safeName("x".repeat(300)).length, 100);
  assert.equal(stamp(new Date("2026-01-02T03:04:05Z")), "20260102");
});

test("describeBackupFolder: 名前と共有ドライブの ID を返す。フォルダでない・ゴミ箱・取得失敗は断る（負例）", async () => {
  const mk = (status, body) => async () => json(status, body);
  const FOLDER = "application/vnd.google-apps.folder";
  assert.deepEqual(
    await describeBackupFolder({ token: "t", folderId: "F", fetchImpl: mk(200, { id: "F", name: "GRAPHY-DB-x-20261015", mimeType: FOLDER, driveId: "D1" }) }),
    { ok: true, name: "GRAPHY-DB-x-20261015", driveId: "D1" },
  );
  assert.deepEqual(
    await describeBackupFolder({ token: "t", folderId: "F", fetchImpl: mk(200, { id: "F", name: "n", mimeType: FOLDER }) }),
    { ok: true, name: "n", driveId: null },
    "マイドライブは driveId なし",
  );
  assert.deepEqual(await describeBackupFolder({ token: "t", folderId: "F", fetchImpl: mk(200, { id: "F", name: "n", mimeType: "text/plain" }) }), { ok: false, error: "not-folder" });
  assert.deepEqual(await describeBackupFolder({ token: "t", folderId: "F", fetchImpl: mk(200, { id: "F", name: "n", mimeType: FOLDER, trashed: true }) }), { ok: false, error: "not-folder" });
  assert.deepEqual(await describeBackupFolder({ token: "t", folderId: "F", fetchImpl: mk(404, {}) }), { ok: false, error: "folder-404" });
  const calls = [];
  await describeBackupFolder({ token: "tok", folderId: "A/B", fetchImpl: async (url, init) => { calls.push({ url, auth: init.headers.Authorization }); return json(200, { mimeType: FOLDER, name: "x" }); } });
  assert.ok(calls[0].url.includes("supportsAllDrives=true") && calls[0].url.includes("A%2FB") && calls[0].auth === "Bearer tok");
});
