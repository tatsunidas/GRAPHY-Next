// `node --test`（desktop/ で `npm test`）。Electron に依存しないので素の Node で回せる。
//
// 実機で踏んだ不具合の再発防止が主目的:
//   1600×900 の画面に対し y=682 / 高さ 699 が保存されていて、下端が 521px 画面外へ
//   はみ出したまま復元された。「48px 見えていれば合格」という判定だったため。

const test = require("node:test");
const assert = require("node:assert");
const { sanitizeBounds, isFullyVisible, subtractRect } = require("./windowGeometry");

const FHD = { x: 0, y: 0, width: 1920, height: 1040 }; // 1920×1080 − タスクバー
const SMALL = { x: 0, y: 0, width: 1600, height: 860 }; // 1600×900 − タスクバー
const RIGHT = { x: 1920, y: 0, width: 1920, height: 1040 }; // 右隣の 2 枚目
const DEF = { width: 1280, height: 800 };

test("保存が無ければ既定サイズだけ返す（中央配置は Electron に委ねる）", () => {
  const b = sanitizeBounds(null, DEF, FHD, [FHD]);
  assert.deepStrictEqual(b, { width: 1280, height: 800 });
  assert.strictEqual("x" in b, false);
});

test("壊れた保存値（NaN）は既定へフォールバックする", () => {
  const b = sanitizeBounds({ x: NaN, y: 0, width: 800, height: 600 }, DEF, FHD, [FHD]);
  assert.deepStrictEqual(b, { width: 1280, height: 800 });
});

test("画面内に完全に収まっている位置はそのまま維持する", () => {
  const saved = { x: 150, y: 40, width: 1400, height: 830 };
  assert.deepStrictEqual(sanitizeBounds(saved, DEF, FHD, [FHD]), saved);
});

test("解像度が下がると、下端のはみ出しを引き戻す（実機で踏んだケース）", () => {
  const saved = { x: 120, y: 682, width: 1200, height: 699 };
  const b = sanitizeBounds(saved, DEF, SMALL, [SMALL]);
  assert.strictEqual(b.height, 699, "workArea に収まる高さは縮めない");
  assert.strictEqual(b.y, 860 - 699, "下端が workArea の下端に合う");
  assert.ok(b.y + b.height <= SMALL.height);
  assert.strictEqual(b.x, 120, "横は動かす必要が無い");
});

test("48px だけ見えている状態は「見えている」と認めない", () => {
  // 旧実装はこれを合格にしていた（minVisible=48）。
  const saved = { x: 0, y: 812, width: 1200, height: 700 };
  const b = sanitizeBounds(saved, DEF, SMALL, [SMALL]);
  assert.ok(b.y + b.height <= SMALL.height);
});

test("workArea より大きいウィンドウは収まるよう縮める", () => {
  const saved = { x: -50, y: -30, width: 2400, height: 1400 };
  const b = sanitizeBounds(saved, DEF, SMALL, [SMALL]);
  assert.deepStrictEqual(b, { x: 0, y: 0, width: 1600, height: 860 });
});

test("2 画面に跨がった配置は、全体が見えているので動かさない", () => {
  const saved = { x: 1700, y: 100, width: 600, height: 500 }; // 左画面の右端 → 右画面
  assert.deepStrictEqual(sanitizeBounds(saved, DEF, FHD, [FHD, RIGHT]), saved);
});

test("2 枚目を抜くと、跨がっていたウィンドウが残った画面へ戻る", () => {
  const saved = { x: 1700, y: 100, width: 600, height: 500 };
  const b = sanitizeBounds(saved, DEF, FHD, [FHD]);
  assert.strictEqual(b.x, 1920 - 600);
  assert.strictEqual(b.y, 100);
});

test("消えた画面に置かれていたウィンドウはプライマリへ引き戻す", () => {
  const saved = { x: 2400, y: 300, width: 800, height: 600 };
  const b = sanitizeBounds(saved, DEF, FHD, [FHD]);
  assert.ok(b.x >= FHD.x && b.x + b.width <= FHD.x + FHD.width);
  assert.ok(b.y >= FHD.y && b.y + b.height <= FHD.y + FHD.height);
});

test("左/上へはみ出した場合も引き戻す", () => {
  const b = sanitizeBounds({ x: -700, y: -400, width: 800, height: 600 }, DEF, FHD, [FHD]);
  assert.deepStrictEqual(b, { x: 0, y: 0, width: 800, height: 600 });
});

test("subtractRect: 重ならなければ元の矩形をそのまま返す", () => {
  const r = { x: 0, y: 0, width: 10, height: 10 };
  assert.deepStrictEqual(subtractRect(r, { x: 100, y: 100, width: 10, height: 10 }), [r]);
});

test("isFullyVisible: 隙間の空いた 2 画面は「収まっている」と見なさない", () => {
  const gapped = { x: 2000, y: 0, width: 1920, height: 1040 }; // 80px の隙間
  const rect = { x: 1900, y: 100, width: 300, height: 200 };
  assert.strictEqual(isFullyVisible(rect, [FHD, gapped]), false);
});
