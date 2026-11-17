const test = require("node:test");
const assert = require("node:assert/strict");
const { createQuitFlow } = require("./quitFlow");
const { buildQuitDialog, KIND } = require("./quitMessages");

/** 呼び出しの順序を記録する偽の依存。 */
function rig({ activity = { kind: "none" }, choice = "quit", fail = {}, askGate = null } = {}) {
  const calls = [];
  const asked = [];
  const deps = {
    log: () => {},
    getActivity: async () => {
      calls.push("getActivity");
      if (fail.getActivity) throw new Error("boom");
      return activity;
    },
    ask: async (a) => {
      calls.push("ask");
      asked.push(a);
      if (askGate) await askGate;
      if (fail.ask) throw new Error("dialog failed");
      return choice;
    },
    approve: () => calls.push("approve"),
    cancelAll: async () => {
      calls.push("cancelAll");
      if (fail.cancelAll) throw new Error("boom");
    },
    closeWindows: async () => {
      calls.push("closeWindows");
      if (fail.closeWindows) throw new Error("boom");
    },
    stopBackend: async () => {
      calls.push("stopBackend");
      if (fail.stopBackend) throw new Error("boom");
      return true;
    },
    quitApp: () => calls.push("quitApp"),
  };
  return { deps, calls, asked };
}

const JOBS = { kind: "items", items: [{ kind: "import", count: 1, cancellable: true }] };

test("何も走っていない: 確認なし。承認 → 窓 → backend → 終了の順（中止は呼ばない）", async () => {
  const r = rig();
  const flow = createQuitFlow(r.deps);
  assert.equal(await flow.request("menu"), "quit");
  assert.deepEqual(r.calls, ["getActivity", "approve", "closeWindows", "stopBackend", "quitApp"]);
  assert.equal(r.asked.length, 0);
});

test("実行中あり・中止して終了: 確認 → 承認 → 中止 → 窓 → backend → 終了の順", async () => {
  const r = rig({ activity: JOBS, choice: "quit" });
  assert.equal(await createQuitFlow(r.deps).request("menu"), "quit");
  assert.deepEqual(r.calls, ["getActivity", "ask", "approve", "cancelAll", "closeWindows", "stopBackend", "quitApp"]);
  assert.deepEqual(r.asked[0].items, JOBS.items);
  assert.equal(r.asked[0].unknown, false);
});

test("負例: 実行中あり・終了しない → 何も変えない（承認・中止・窓・backend・終了のどれも呼ばない）。次の要求は受け付ける", async () => {
  const r = rig({ activity: JOBS, choice: "stay" });
  const flow = createQuitFlow(r.deps);
  assert.equal(await flow.request("window-close"), "stay");
  assert.deepEqual(r.calls, ["getActivity", "ask"]);
  assert.equal(flow.isRunning(), false);
  r.deps.ask = async () => "quit";
  assert.equal(await flow.request("menu"), "quit");
});

test("backend に届かない（unknown）: 同じ 2 択を出す。終了しないなら何もしない", async () => {
  const r = rig({ activity: { kind: "unknown", reason: "timeout" }, choice: "stay" });
  assert.equal(await createQuitFlow(r.deps).request("menu"), "stay");
  assert.equal(r.asked[0].unknown, true);
  assert.deepEqual(r.calls, ["getActivity", "ask"]);
});

test("getActivity が例外: 「確認できない」として確認を出す（黙って終わらない）", async () => {
  const r = rig({ fail: { getActivity: true }, choice: "stay" });
  assert.equal(await createQuitFlow(r.deps).request("menu"), "stay");
  assert.equal(r.asked[0].unknown, true);
});

test("中止できないものだけ（送信中など）: 中止は呼ばず、backend の穏当な停止（完了待ち）へ進む", async () => {
  const r = rig({ activity: { kind: "items", items: [{ kind: "send", count: 1, cancellable: false }] }, choice: "quit" });
  assert.equal(await createQuitFlow(r.deps).request("menu"), "quit");
  assert.deepEqual(r.calls, ["getActivity", "ask", "approve", "closeWindows", "stopBackend", "quitApp"]);
});

test("確認ダイアログが失敗したら終わらせない（stay）", async () => {
  const r = rig({ activity: JOBS, fail: { ask: true } });
  assert.equal(await createQuitFlow(r.deps).request("menu"), "stay");
  assert.ok(!r.calls.includes("quitApp"));
});

test("確認中にもう一度来ても二重に動かさない（ignored）。確認は 1 回だけ", async () => {
  let release;
  const gate = new Promise((res) => (release = res));
  const r = rig({ activity: JOBS, askGate: gate });
  const flow = createQuitFlow(r.deps);
  const first = flow.request("menu");
  await new Promise((res) => setImmediate(res));
  assert.equal(await flow.request("window-close"), "ignored");
  release();
  assert.equal(await first, "quit");
  assert.equal(r.asked.length, 1);
  assert.equal(r.calls.filter((c) => c === "quitApp").length, 1);
});

test("承認のあとは、どこが失敗しても終了まで進む（中止・窓・backend の失敗）", async () => {
  for (const f of ["cancelAll", "closeWindows", "stopBackend"]) {
    const r = rig({ activity: JOBS, fail: { [f]: true } });
    assert.equal(await createQuitFlow(r.deps).request("menu"), "quit", f);
    assert.equal(r.calls.at(-1), "quitApp", `${f} が失敗しても終了する`);
  }
});

test("終了中の要求は無視する（終了後に running が戻らない）", async () => {
  const r = rig();
  const flow = createQuitFlow(r.deps);
  await flow.request("menu");
  assert.equal(flow.isRunning(), true);
  assert.equal(await flow.request("before-quit"), "ignored");
});

test("文言: 中止できるものと待つものを分けて出す。既定は［終了しない］（取り消しも同じ）", () => {
  const d = buildQuitDialog({
    locale: "ja",
    unknown: false,
    items: [
      { kind: "import", count: 2, cancellable: true },
      { kind: "send", count: 1, cancellable: false },
    ],
  });
  assert.equal(d.buttons[0], "終了しない");
  assert.equal(d.buttons[1], "中止して終了");
  assert.equal(d.defaultId, 0);
  assert.equal(d.cancelId, 0);
  assert.equal(d.message, "実行中の処理があります。", "見出しは題の繰り返しにしない");
  assert.notEqual(d.message, d.title);
  assert.match(d.detail, /取り込み: 2 件/);
  assert.match(d.detail, /DICOM 送信: 1 件/);
  assert.match(d.detail, /最大 10 秒/);
});

test("文言: 待つだけのときは［終了する］、unknown は確認できない旨、英語も出る、未知の kind はキーのまま", () => {
  const w = buildQuitDialog({ locale: "ja", unknown: false, items: [{ kind: "send", count: 1, cancellable: false }] });
  assert.equal(w.buttons[1], "終了する");
  const u = buildQuitDialog({ locale: "ja", unknown: true, items: [] });
  assert.match(u.message, /確認できませんでした/);
  assert.equal(u.detail, "", "unknown のときは一覧が無い");
  const en = buildQuitDialog({ locale: "en", unknown: false, items: [{ kind: "export", count: 1, cancellable: true }, { kind: "future-kind", count: 3, cancellable: true }] });
  assert.equal(en.buttons[0], "Don't quit");
  assert.match(en.detail, /Export: 1/);
  assert.match(en.detail, /future-kind: 3/);
});

test("文言: backend の kind は全部、日英の表に載っている（引き当て漏れで英字のキーを出さない）", () => {
  assert.deepEqual(Object.keys(KIND.ja).sort(), Object.keys(KIND.en).sort());
});

test("文言: backend が返しうる kind を、ソースから拾って全部、日英の表に載せている（引き当て漏れで英字のキーを出さない）", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "..", "backend", "src", "main", "java");
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith(".java")) files.push(f);
    }
  })(root);
  const kinds = new Set();
  for (const f of files) {
    const s = fs.readFileSync(f, "utf8");
    // ActiveWork の実装: public String kind() { return "x"; }
    for (const m of s.matchAll(/public String kind\(\)\s*\{\s*return "([A-Za-z]+)";/g)) kinds.add(m[1]);
    // 要求の数え上げ: Route.prefix("...", "x") / Route.exact("...", "x") と、末尾が /prefetch の分け
    if (f.endsWith("InFlightRequestFilter.java")) {
      for (const m of s.matchAll(/Route\.(?:prefix|exact)\("[^"]*",\s*"([A-Za-z]+)"\)/g)) kinds.add(m[1]);
      for (const m of s.matchAll(/return "([A-Za-z]+)";/g)) kinds.add(m[1]);
    }
  }
  assert.ok(kinds.size >= 20, `kind を拾えている（拾えた数 ${kinds.size}）。正規表現がソースの書き方とずれていないか`);
  for (const k of kinds) {
    assert.ok(KIND.ja[k], `ja に ${k} が無い`);
    assert.ok(KIND.en[k], `en に ${k} が無い`);
  }
});
