// 外部 AI クライアントによる 2D ビューアの表示操作・ROI の作成・計測の全削除と、その「元に戻す」の履歴。
// 設計: roadmap fw/mcp-server-design.md §6（段 4c-1・4c-2a）。electron に依存しない純モジュール（`node --test` で検査する）。
//
// 🔴 履歴（逆操作）は main だけが持つ。クライアントへは `inverse` を返さない（偽の逆操作を送らせない）。undo は履歴の逆操作だけを再実行する。
// 🔴 操作できる id は `mcpTools.VIEWER_ACTIONS`（表示の 10 種）と、allowViewerEdit のときだけ `VIEWER_WRITE_ACTIONS`（ROI の作成・計測の全削除。
//    **実行のたびに利用者へ確認**する）。履歴の逆操作の id もここで再び絞る（表示の 10 種と、ROI を消す removeAssistantRoi だけ。ツールとしては呼べない）。
// 🔴 計測の全削除（clearMeasurements）は元に戻せない。履歴に積まず、結果に irreversible を付ける。
// 🔴 窓からの失敗は、符号の許可リストだけ素通しする（`exec-failed:<例外の文>` など本文を含み得るものは viewer-failed に丸める）。
// 2D 窓は毎回 validateAction で再検証する（ここの検査は二重の備え）。
const { VIEWER_ACTIONS, VIEWER_WRITE_ACTIONS, UNDO_ONLY_ACTIONS } = require("./mcpTools");

const MAX_HISTORY = 20;
/**
 * 連打で利用者の画面を塞がないための上限（接続ごと）。統計的・物理的な根拠から導いた値ではなく、設計上の選択
 * （人が頼んで行う操作では届かない余裕を見た値）。実機で不都合があれば見直す。
 */
const RATE = { max: 20, windowMs: 10_000 };

/** 2D 窓の ROI の作成の失敗の理由（frontend/src/viewer/roiCreate.ts の CreateRoiFailure。固定）。 */
const ROI_REASONS = "bad-request|off-slice|no-geometry|too-large|no-image|thick-slab|self-intersecting|degenerate|bad-axes|failed";
const SAFE_ERROR = new RegExp(`^(no-viewer|timeout|declined|no-tile|unknown-preset|not-removable|roi-(${ROI_REASONS})|(bad-param|out-of-range|missing-param|unknown-param|degenerate|self-intersecting):[A-Za-z]{1,24})$`);
/** main 自身が返す符号（履歴の空・連打）。窓の本文ではない。 */
const OWN_ERRORS = new Set(["rate-limited", "nothing-to-undo", "edit-disabled"]);
/** クライアントへ返してよい失敗の符号（許可リスト）。それ以外は viewer-failed。mcpBridge も使う。 */
const safeError = (e) => (typeof e === "string" && (SAFE_ERROR.test(e) || OWN_ERRORS.has(e)) ? e : "viewer-failed");

/**
 * @param {object} o
 * @param {(sessionId: string, cmd: object, opts?: {confirm?: (id: string) => Promise<boolean>}) => Promise<{ok: boolean, inverse?: any, error?: string}>} o.relay  main の viewerRelay.relay（action だけ渡す。write は opts.confirm の承認が要る）
 * @param {() => number} [o.now]
 */
function createViewerControl({ relay, now = Date.now, maxHistory = MAX_HISTORY, rate = RATE }) {
  const history = new Map(); // クライアント名 → 逆操作の列の配列（古い → 新しい）
  const hits = new Map(); // クライアント名 → 直近の操作の時刻

  function stackOf(client) {
    if (!history.has(client)) history.set(client, []);
    return history.get(client);
  }

  function limited(client) {
    const t = now();
    const recent = (hits.get(client) ?? []).filter((x) => t - x < rate.windowMs);
    if (recent.length >= rate.max) {
      hits.set(client, recent);
      return true;
    }
    recent.push(t);
    hits.set(client, recent);
    return false;
  }

  const INVERSE_IDS = [...VIEWER_ACTIONS, ...UNDO_ONLY_ACTIONS];
  /** 結果の inverse（配列）から、許可リストの id だけ残す（表示の 10 種と、ROI を消す removeAssistantRoi）。 */
  function cleanInverse(inv) {
    return (Array.isArray(inv) ? inv : []).filter((s) => s && typeof s.id === "string" && INVERSE_IDS.includes(s.id)).map((s) => ({ id: s.id, params: s.params && typeof s.params === "object" ? s.params : {} }));
  }

  /**
   * @param {{allowEdit?: boolean, confirm?: (id: string, params: object) => Promise<boolean>}} [ctx]  write は allowEdit と confirm（利用者の承認）が要る
   */
  async function run(client, desc, ctx = {}) {
    const sid = `mcp:${client}`;
    if (!desc || (desc.kind !== "action" && desc.kind !== "undo")) return { ok: false, error: "viewer-failed" };
    if (limited(client)) return { ok: false, error: "rate-limited" };
    const stack = stackOf(client);

    if (desc.kind === "undo") {
      const entry = stack.pop();
      if (!entry) return { ok: false, error: "nothing-to-undo" };
      for (const step of entry) {
        let r;
        try {
          r = await relay(sid, { kind: "action", id: step.id, params: step.params });
        } catch {
          return { ok: false, error: "viewer-failed" };
        }
        if (!r || r.ok !== true) {
          if (r && r.error === "no-viewer") history.delete(client);
          return { ok: false, error: safeError(r && r.error) };
        }
      }
      return { ok: true, control: { undone: true, undoDepth: stack.length } };
    }

    const isWrite = VIEWER_WRITE_ACTIONS.includes(desc.id);
    if (!VIEWER_ACTIONS.includes(desc.id) && !isWrite) return { ok: false, error: "viewer-failed" };
    if (isWrite && ctx.allowEdit !== true) return { ok: false, error: "edit-disabled" }; // 二重の備え（ツールの一覧・buildRequest でも止めている）
    const params = desc.params ?? {};
    let r;
    try {
      // write は 2D 窓が引数・対象を検査（dryRun。失敗は確認を出さずに返る）→ confirm（利用者の承認）→ 本実行。承認の印は main が付ける
      r = await relay(sid, { kind: "action", id: desc.id, params }, isWrite ? { confirm: () => (typeof ctx.confirm === "function" ? ctx.confirm(desc.id, params) : Promise.resolve(false)) } : {});
    } catch {
      return { ok: false, error: "viewer-failed" };
    }
    if (!r || r.ok !== true) {
      if (r && r.error === "no-viewer") history.delete(client); // 窓が閉じた。履歴は今の画面と合わない
      return { ok: false, error: safeError(r && r.error) };
    }
    if (desc.id === "clearMeasurements") return { ok: true, control: { applied: desc.id, undoDepth: stack.length, irreversible: true } };
    const inv = cleanInverse(r.inverse);
    if (inv.length > 0) {
      stack.push(inv);
      while (stack.length > maxHistory) stack.shift();
    }
    return { ok: true, control: { applied: desc.id, undoDepth: stack.length } };
  }

  /** 履歴を捨てる（受け口を止めるとき・窓が閉じたとき）。client を省くと全部。 */
  function clear(client) {
    if (client === undefined) {
      history.clear();
      hits.clear();
    } else {
      history.delete(client);
    }
  }

  return { run, clear, depth: (client) => (history.get(client) ?? []).length };
}

module.exports = { createViewerControl, safeError, SAFE_ERROR, ROI_REASONS, MAX_HISTORY, RATE };
