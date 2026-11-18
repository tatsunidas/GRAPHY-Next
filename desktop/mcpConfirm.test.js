// `node --test`。外部 AI クライアントの確認ダイアログの待ち行列・自動取り消し・文面。
const test = require("node:test");
const assert = require("node:assert/strict");

const { createDialogQueue, writeConfirmText } = require("./mcpConfirm");

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("queue: ダイアログは 1 枚ずつ、呼んだ順に出る（同時に 2 枚出さない）", async () => {
  let open = 0;
  let maxOpen = 0;
  const order = [];
  const show = async (o) => {
    open++;
    maxOpen = Math.max(maxOpen, open);
    order.push(o.n);
    await tick(15);
    open--;
    return { response: 0 };
  };
  const q = createDialogQueue({ show });
  const rs = await Promise.all([1, 2, 3, 4].map((n) => q.ask({ n, cancelId: 1 })));
  assert.equal(maxOpen, 1);
  assert.deepEqual(order, [1, 2, 3, 4]);
  assert.ok(rs.every((r) => r.response === 0 && r.timedOut === false));
});

test("queue: 答えないまま timeoutMs が過ぎたら中断して［取り消す］（cancelId）を返す。待ち行列の待ち時間は数えない", async () => {
  let started = 0;
  const show = (o, signal) => new Promise((resolve, reject) => {
    started++;
    if (o.hang) signal.addEventListener("abort", () => reject(new Error("aborted")));
    else setTimeout(() => resolve({ response: 0 }), 5);
  });
  const q = createDialogQueue({ show });
  const t0 = Date.now();
  const first = q.ask({ hang: true, cancelId: 1 }, { timeoutMs: 40 });
  const second = q.ask({ hang: false, cancelId: 1 }, { timeoutMs: 40 }); // 1 つ目の 40ms の間は待つ。その分は自分の時間に入らない
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, { response: 1, timedOut: true });
  assert.deepEqual(b, { response: 0, timedOut: false });
  assert.ok(Date.now() - t0 >= 40);
  assert.equal(started, 2);
});

test("queue: timeoutMs なし（最初の接続の同意）は答えるまで待つ。表示の失敗は［取り消す］", async () => {
  const q = createDialogQueue({ show: async () => { await tick(60); return { response: 0 }; } });
  assert.deepEqual(await q.ask({ cancelId: 1 }), { response: 0, timedOut: false });
  const bad = createDialogQueue({ show: async () => { throw new Error("no window"); } });
  assert.deepEqual(await bad.ask({ cancelId: 1 }), { response: 1, timedOut: false });
  // 1 つが失敗しても、次は出る
  let n = 0;
  const flaky = createDialogQueue({ show: async () => { if (n++ === 0) throw new Error("x"); return { response: 0 }; } });
  const [r1, r2] = await Promise.all([flaky.ask({ cancelId: 1 }), flaky.ask({ cancelId: 1 })]);
  assert.equal(r1.response, 1);
  assert.equal(r2.response, 0);
});

test("文面: ROI の作成はクライアント名・形・位置・大きさ・undo を、計測の全削除は「元に戻せません」を最初の行に書く", () => {
  const roi = writeConfirmText("claude-x", "createRoi", { shape: "ellipse", u: 0.5, v: 0.25, radiusXmm: 20, radiusYmm: 10 });
  assert.match(roi.message, /「claude-x」/);
  assert.match(roi.message, /楕円/);
  assert.match(roi.detail, /横 50\.0%/);
  assert.match(roi.detail, /縦 25\.0%/);
  assert.match(roi.detail, /横 20\.0 mm/);
  assert.match(roi.detail, /undo_viewer_action/);
  assert.match(roi.detail, /自己申告/);
  assert.match(writeConfirmText("c", "createRoi", { shape: "rectangle", u: 0, v: 0, radiusXmm: 1, radiusYmm: 1 }).message, /矩形/);
  const cont = writeConfirmText("c", "createContourRoi", { shape: "polygon", points: [[0, 0], [1, 0], [0, 1]] });
  assert.match(cont.message, /多角形・頂点 3 個/);
  assert.match(writeConfirmText("c", "createContourRoi", { shape: "freehand", points: [] }).message, /自由曲線/);
  const clear = writeConfirmText("claude-x", "clearMeasurements", {});
  assert.match(clear.detail, /^元に戻せません。/);
  assert.match(clear.message, /すべて消します/);
  assert.equal(writeConfirmText("c", "setWindowLevel", {}), null); // 確認を出さない操作には文面が無い
  // クライアント名の制御文字・長さは落とす（ダイアログの文面を壊さない）
  assert.ok(!/\n/.test(writeConfirmText("a\nb" + "x".repeat(200), "clearMeasurements").message));
});
