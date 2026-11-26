const test = require("node:test");
const assert = require("node:assert/strict");
const { createDbImportFlow } = require("./dbImportFlow");

const FOLDER = "/media/someone/SECRET-DRIVE/transfer";
const SCAN = {
  packages: [{ name: "p1", studies: 2, files: 10, bytes: 2 << 20, problem: null, pluginNotes: [{ id: "demo", sourceVersion: "1.0.0", localVersion: "2.0.0", kind: "different" }] }],
  stalePartials: 1, requiredBytes: 100, freeBytes: 1000, enoughSpace: true,
};
const JOB_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function setup({ folder = FOLDER, scan = SCAN, agree = true, job } = {}) {
  const calls = [];
  const shown = [];
  const flow = createDbImportFlow({
    ja: () => true,
    pickDirectory: async () => folder,
    confirm: async (d) => { shown.push(d); return agree; },
    call: async (method, path, body) => {
      calls.push([method, path, body]);
      if (path.endsWith("/scan")) return scan.status ? { ok: false, status: scan.status, body: scan.body } : { ok: true, status: 200, body: scan };
      if (method === "POST") return { ok: true, status: 200, body: { jobId: JOB_ID } };
      return { ok: true, status: 200, body: job };
    },
  });
  return { flow, calls, shown };
}

test("選ぶ → 中身を見せて確かめる → 始める。戻り値にフォルダは出ない", async () => {
  const { flow, calls, shown } = setup();
  const r = await flow.start();
  assert.deepEqual(r, { ok: true, jobId: JOB_ID });
  assert.deepEqual(calls.map((c) => c[1]), ["/api/internal/db-transfer/import/scan", "/api/internal/db-transfer/import"]);
  assert.match(shown[0], /荷物 1 個・検査 2 件・画像 10 枚/);
  assert.match(shown[0], /demo.*移し元 1\.0\.0・この PC 2\.0\.0/);
  assert.match(shown[0], /途中で止まった荷物が 1 個/);
  assert.doesNotMatch(JSON.stringify(r), /SECRET-DRIVE/);
});

test("フォルダを選ばなければ backend を呼ばない・確認で断れば始めない", async () => {
  const none = setup({ folder: null });
  assert.deepEqual(await none.flow.start(), { ok: false, canceled: true });
  assert.equal(none.calls.length, 0);
  const no = setup({ agree: false });
  assert.deepEqual(await no.flow.start(), { ok: false, canceled: true });
  assert.equal(no.calls.length, 1, "scan だけで、始める要求は出さない");
});

test("取り込めないときは確認を出さず、理由の記号だけを返す", async () => {
  const cases = [
    [{ ...SCAN, enoughSpace: false }, "not-enough-space"],
    [{ ...SCAN, packages: [{ ...SCAN.packages[0], problem: "too-new" }] }, "too-new"],
    [{ ...SCAN, packages: [], stalePartials: 2 }, "only-interrupted"],
    [{ status: 400, body: { message: "source-is-current" } }, "source-is-current"],
    [{ status: 500, body: { message: `読めません ${FOLDER}/x` } }, "backend-500"],
  ];
  for (const [scan, reason] of cases) {
    const s = setup({ scan });
    const r = await s.flow.start();
    assert.equal(r.reason, reason);
    assert.equal(s.shown.length, 0);
    assert.equal(s.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(r), /SECRET-DRIVE/);
  }
});

test("選んでいる間の 2 件目は busy", async () => {
  let release;
  const flow = createDbImportFlow({ ja: () => true, pickDirectory: () => new Promise((r) => { release = r; }), confirm: async () => true, call: async () => ({ ok: false }) });
  const first = flow.start();
  assert.deepEqual(await flow.start(), { ok: false, reason: "busy" });
  release(null);
  await first;
});

test("状態は件数だけ。移し元の場所・エラーの本文・荷物の名前は返さない。形の違う jobId は backend に送らない", async () => {
  const job = {
    state: "done", studyUids: ["1.2.3"],
    packages: [{ name: "20260101-000000-abcdef01", outcome: "imported", result: { imported: 3, skippedExisting: 1, failed: 1, sourceDbFolder: FOLDER, errors: [`${FOLDER}/dicom/a.dcm`], relatedInserted: 2, relatedSame: 0, conflicts: 0, pluginNotes: [] } }],
  };
  const { flow, calls } = setup({ job });
  const r = await flow.status(JOB_ID);
  assert.equal(r.ok, true);
  assert.equal(r.packages[0].imported, 3);
  assert.equal(r.studies, 1);
  assert.doesNotMatch(JSON.stringify(r), /SECRET-DRIVE|abcdef01/);
  const before = calls.length;
  assert.deepEqual(await flow.status("../x"), { ok: false, reason: "job-not-found" });
  assert.equal(calls.length, before);
});
