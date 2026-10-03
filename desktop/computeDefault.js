// 既定の計算機（Colab の GPU T4）。設計: fw/remote-compute-design.md §17
//
// 計算機が 1 つも登録されていないとき、Google にログイン済みなら Colab の T4 を 1 本だけ足す。
// 確認ダイアログは出さない——送り先は「利用者自身の Google アカウントの Colab」に固定で、足しただけでは何も送らない
// （毎回の実行で main の同意画面に送り先・データ・コード全文が出る）。
// 🔴 送り先を増やせるのは main だけ、という守りは変えない（この関数は main からしか呼ばない）。

/** 既定にする Colab のランタイムの種類。 */
const DEFAULT_SPEC = Object.freeze({ variant: "VARIANT_GPU", accelerator: "T4", shape: "SHAPE_STANDARD" });
const DEFAULT_ID = "colab-t4";
const DEFAULT_LABEL = "Google Colab（GPU T4）";

const sameSpec = (a, b) => !!a && !!b && a.variant === b.variant && a.accelerator === b.accelerator && a.shape === b.shape;

/**
 * @param deps.endpoints  computeEndpoints（get / save）
 * @param deps.colabAuth  { configured, signedIn }（無ければ Colab は使えない）
 * @param deps.colabApi   { runtimeSpecs }
 * @returns {Promise<{ok: true, endpointId: string, added: boolean} | {ok: false, error: string}>}
 *   error: colab-not-configured（配布物に OAuth の設定が無い）/ colab-signin-required / t4-not-available / 保存の失敗
 */
async function ensureDefaultEndpoint(deps) {
  const cfg = deps.endpoints.get();
  // 設定のファイルが読めないときは足さない（上書きすると利用者の書いた接続先が消える）
  if (cfg.problems.some((p) => String(p).startsWith("config:"))) return { ok: false, error: "config-unreadable" };
  const current = cfg.endpoints;
  if (current.length > 0) {
    // 既に登録がある（利用者が選んだもの）。足さない。既定は選び方（pickDefault）で決める
    return { ok: true, endpointId: pickDefault(current).id, added: false };
  }
  if (!deps.colabAuth || !deps.colabAuth.configured()) return { ok: false, error: "colab-not-configured" };
  if (!deps.colabAuth.signedIn()) return { ok: false, error: "colab-signin-required" };
  let specs;
  try {
    specs = await deps.colabApi.runtimeSpecs();
  } catch (e) {
    return { ok: false, error: (e && e.code) || "colab-specs-failed" };
  }
  const t4 = specs.find((s) => sameSpec(s, DEFAULT_SPEC));
  // 黙って CPU に落とさない（遅く、理由が分からない）
  if (!t4 || !t4.eligible) return { ok: false, error: "t4-not-available" };
  const saved = deps.endpoints.save({
    endpoints: [{ id: DEFAULT_ID, label: DEFAULT_LABEL, kind: "colab", spec: { ...DEFAULT_SPEC } }],
  });
  if (!saved.ok) return { ok: false, error: (saved.problems && saved.problems[0]) || "save-failed" };
  return { ok: true, endpointId: DEFAULT_ID, added: true };
}

/**
 * 既定の計算機: Colab の T4 があればそれ、無ければトークンの入った最初の計算機、それも無ければ最初の計算機。
 * 画面（pluginComputeApi）と同じ規則。
 */
function pickDefault(endpoints) {
  return (
    endpoints.find((e) => e.kind === "colab" && sameSpec(e.spec, DEFAULT_SPEC)) ||
    endpoints.find((e) => e.hasToken) ||
    endpoints[0]
  );
}

module.exports = { ensureDefaultEndpoint, pickDefault, DEFAULT_SPEC, DEFAULT_ID, DEFAULT_LABEL };
