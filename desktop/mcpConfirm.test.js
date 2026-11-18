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

const { pluginWriteConfirmText, pluginSendConfirmText, pluginExposeConfirmText } = require("./mcpConfirm");

const MONAI = { pluginId: "vis-monai", pluginName: "MONAI", tool: "segment_run", effect: "write", description: "[plugin: MONAI] (writes data) 臓器を分割する", permissions: ["remote-compute", "ai-tools"] };
const DEMO = { pluginId: "demo", pluginName: "Demo", tool: "make_roi", effect: "write", description: "[plugin: Demo] (writes data) ROI を作る", permissions: ["ai-tools"] };

test("文面(plugin): write はクライアント・プラグイン・ツール・引数・「信用できない文字列」を示す。remote-compute には、別に計算機の送信の確認が出ることを添える", () => {
  const t = pluginWriteConfirmText("claude-x", MONAI, '{"organs":"liver"}');
  assert.match(t.message, /「claude-x」/);
  assert.match(t.message, /「MONAI」/);
  assert.match(t.message, /「segment_run」/);
  assert.match(t.detail, /信用できない文字列/);
  assert.match(t.detail, /臓器を分割する/);
  assert.ok(!/\[plugin:/.test(t.detail) && !/\(writes data\)/.test(t.detail)); // main が前置した名乗りは重複させない
  assert.match(t.detail, /liver/);
  assert.match(t.detail, /外部の計算機へデータを送る機能/);
  assert.match(t.detail, /計算機への送信の同意/);
  // remote-compute が無いプラグインには、その注記を出さない（出すと常に警告で、見分けがつかなくなる）
  assert.ok(!/外部の計算機/.test(pluginWriteConfirmText("c", DEMO, "{}").detail));
  assert.ok(!/\n/.test(pluginWriteConfirmText("a\nb", DEMO, "{}").message));
});

test("文面(plugin): 結果を返す確認は、結果の先頭と「信用できない文字列」・患者情報の確認を促す。公開の確認はツールと効果の一覧を示す", () => {
  const s = pluginSendConfirmText("claude-x", DEMO, "x".repeat(500));
  assert.match(s.message, /「Demo」/);
  assert.match(s.message, /「claude-x」/);
  assert.match(s.detail, /信用できない文字列/);
  assert.match(s.detail, /患者情報が含まれていないか/);
  assert.ok(s.detail.length < 800); // 結果の先頭は切る
  const e = pluginExposeConfirmText("vis-monai", [
    MONAI,
    { ...MONAI, tool: "segment_models", effect: "read" },
    { ...DEMO, tool: "show_mask", effect: "display" },
  ]);
  assert.match(e.message, /「MONAI」/);
  assert.match(e.detail, /segment_run（データを変更。実行のたびに確認）/);
  assert.match(e.detail, /segment_models（読み取り）/);
  assert.ok(!/show_mask/.test(e.detail)); // 他のプラグインのツールは載せない
  assert.match(e.detail, /画素や患者に関わる値に触れ得ます/);
  assert.match(pluginExposeConfirmText("none", []).detail, /ツールが見つかりません/);
});
