// GRAPHY-Next — ウィンドウ位置記憶の幾何判定（純関数のみ）
//
// `windowState.js` から Electron 依存を切り離した部分。ここには electron を require せず、
// 矩形の計算だけを置く。復元位置の判定はこの機能の核であり、実機でしか踏めない不具合
// （大きなモニタで保存 → 小さな画面で復元 → 下端が画面外）を出したので、
// **単体テストで守る**（`windowGeometry.test.js`）。
//
// 設計: fw/window-position-memory.md §5

/** 4 辺が有限で面積を持つ矩形か。 */
function isFiniteRect(r) {
  return (
    !!r &&
    ["x", "y", "width", "height"].every((k) => Number.isFinite(r[k])) &&
    r.width > 0 &&
    r.height > 0
  );
}

/** 2 矩形の重なり寸法。 */
function overlapSize(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/**
 * `rect` から `hole` を差し引いて残る部分（最大 4 片）。重なりが無ければ rect をそのまま返す。
 * 面積の残りだけを見るので、断片が細切れでも判定には影響しない。
 */
function subtractRect(rect, hole) {
  const ov = overlapSize(rect, hole);
  if (ov.width <= 0 || ov.height <= 0) return [rect];

  const left = Math.max(rect.x, hole.x);
  const right = Math.min(rect.x + rect.width, hole.x + hole.width);
  const top = Math.max(rect.y, hole.y);
  const bottom = Math.min(rect.y + rect.height, hole.y + hole.height);

  const out = [];
  if (rect.y < top) out.push({ x: rect.x, y: rect.y, width: rect.width, height: top - rect.y });
  if (bottom < rect.y + rect.height) {
    out.push({ x: rect.x, y: bottom, width: rect.width, height: rect.y + rect.height - bottom });
  }
  if (rect.x < left) out.push({ x: rect.x, y: top, width: left - rect.x, height: bottom - top });
  if (right < rect.x + rect.width) {
    out.push({ x: right, y: top, width: rect.x + rect.width - right, height: bottom - top });
  }
  return out.filter((r) => r.width > 0 && r.height > 0);
}

/**
 * 矩形が workArea の**和集合に完全に収まっている**か。
 *
 * 「タイトルバーがつかめる程度に見えているか」ではなく**全体が見えているか**を見るのが要点。
 * 前者だと、大きなモニタで保存した位置を小さな画面で復元したとき、上端だけ画面内に入って
 * 下端が数百 px はみ出した状態が「合格」になってしまう（利用者からは操作できない＝
 * 「アプリが起動しない」ように見える）。
 *
 * 逆に、2 画面に跨がった配置は和集合に収まるので**そのまま維持される**。
 */
function isFullyVisible(rect, workAreas) {
  let remain = [rect];
  for (const wa of workAreas || []) {
    const next = [];
    for (const r of remain) next.push(...subtractRect(r, wa));
    remain = next;
    if (remain.length === 0) return true;
  }
  return remain.length === 0;
}

/**
 * 保存 bounds を現在のディスプレイ構成に照らして検証する（迷子防止の中核）。
 *
 * 1. 保存なし/数値異常 → 既定サイズだけ返す（x,y 省略 = Electron がプライマリ中央に置く）
 * 2. `targetWorkArea` に収まるようサイズを縮小
 * 3. 全体が見えていなければ `targetWorkArea` の内側へ移動（縮小済みなので必ず収まる）
 *
 * @param {any} saved                       保存された bounds
 * @param {{width:number,height:number}} def 既定サイズ
 * @param {{x:number,y:number,width:number,height:number}} targetWorkArea
 *        最も重なるディスプレイの workArea（Electron の `getDisplayMatching` の結果を渡す）
 * @param {Array<{x:number,y:number,width:number,height:number}>} workAreas 全ディスプレイの workArea
 * @returns {{x?:number,y?:number,width:number,height:number}}
 */
function sanitizeBounds(saved, def, targetWorkArea, workAreas) {
  const dw = Math.round(def.width);
  const dh = Math.round(def.height);

  if (!isFiniteRect(saved) || !isFiniteRect(targetWorkArea)) {
    return { width: dw, height: dh };
  }

  const wa = targetWorkArea;
  let x = Math.round(saved.x);
  let y = Math.round(saved.y);
  const width = Math.min(Math.round(saved.width), wa.width);
  const height = Math.min(Math.round(saved.height), wa.height);

  if (!isFullyVisible({ x, y, width, height }, workAreas)) {
    x = Math.max(wa.x, Math.min(x, wa.x + wa.width - width));
    y = Math.max(wa.y, Math.min(y, wa.y + wa.height - height));
  }

  return { x, y, width, height };
}

module.exports = { isFiniteRect, overlapSize, subtractRect, isFullyVisible, sanitizeBounds };
