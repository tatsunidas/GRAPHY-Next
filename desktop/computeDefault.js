// 既定の計算機。設計: fw/remote-compute-design.md §17
//
// 規則（ここ 1 か所だけ。画面は main が決めた結果を読む）:
//   1. 利用者が「既定にする」で選んだもの（defaultId）。"local" を選んで使えないときは黙って別の所へ落とさず断る
//   2. 自動: この PC（CUDA の GPU が使える）→ Colab の T4 → トークンのある最初 → 最初
//   3. どれも無く、Google にログイン済みなら Colab の T4 を 1 本だけ足す
// 確認ダイアログは出さない——送り先は「この PC」か「利用者自身の Google アカウントの Colab」に固定で、足しただけでは何も送らない
// （毎回の実行で main の同意画面に送り先・データ・コード全文が出る）。
// 🔴 送り先を増やせるのは main だけ、という守りは変えない（この関数は main からしか呼ばない）。

const LOCAL_ID = "local";

/** 既定にする Colab のランタイムの種類。 */
const DEFAULT_SPEC = Object.freeze({ variant: "VARIANT_GPU", accelerator: "T4", shape: "SHAPE_STANDARD" });
const DEFAULT_ID = "colab-t4";
const DEFAULT_LABEL = "Google Colab（GPU T4）";

const sameSpec = (a, b) => !!a && !!b && a.variant === b.variant && a.accelerator === b.accelerator && a.shape === b.shape;

/** 旧い規則（登録だけを見る）: Colab の T4 → トークンの入った最初 → 最初。移行の判定と、自動の後段で使う。 */
function pickDefault(endpoints) {
  return (
    endpoints.find((e) => e.kind === "colab" && sameSpec(e.spec, DEFAULT_SPEC)) ||
    endpoints.find((e) => e.hasToken) ||
    endpoints[0]
  );
}

/**
 * 実際に効く defaultId。キーが無い（undefined＝未移行）ときは旧い規則で既定を求め、
 * Colab の T4 なら自動（null）、利用者が登録したもの（院内の Jupyter など）ならその id＝**既定を黙って変えない**。
 */
function effectiveDefaultId(defaultId, endpoints) {
  if (defaultId !== undefined) return defaultId;
  const p = endpoints.length > 0 ? pickDefault(endpoints) : null;
  if (!p) return null;
  return p.kind === "colab" && sameSpec(p.spec, DEFAULT_SPEC) ? null : p.id;
}

/**
 * 既定の計算機を決める。
 * @param o.endpoints  登録（hasToken を付けたもの）
 * @param o.defaultId  compute-endpoints.json の値（undefined＝未移行／null＝自動／id）
 * @param o.local      { usable, cuda }（この PC の検出結果。使うときだけ呼ぶので関数でも渡せる）
 * @returns {Promise<{ok:true, id:string|null, mode:"chosen"|"auto"} | {ok:false, error:string}>}
 *   id が null＝登録が 0 件で自機も使えない（Colab を足す流れへ）
 */
async function resolveDefault(o) {
  const want = effectiveDefaultId(o.defaultId, o.endpoints);
  const local = async () => (typeof o.local === "function" ? await o.local() : o.local) || { usable: false, cuda: false };
  if (want === LOCAL_ID) {
    return (await local()).usable ? { ok: true, id: LOCAL_ID, mode: "chosen" } : { ok: false, error: "local-unavailable" };
  }
  if (want && o.endpoints.some((e) => e.id === want)) return { ok: true, id: want, mode: "chosen" };
  // 自動（宙に浮いた id もここ）
  if ((await local()).cuda) return { ok: true, id: LOCAL_ID, mode: "auto" };
  const p = o.endpoints.length > 0 ? pickDefault(o.endpoints) : null;
  return { ok: true, id: p ? p.id : null, mode: "auto" };
}

/**
 * @param deps.endpoints  computeEndpoints（get / save）
 * @param deps.enrich     登録に hasToken を付ける（無ければ付けない）
 * @param deps.local      この PC の検出結果 { usable, cuda } を返す関数
 * @param deps.colabAuth  { configured, signedIn }（無ければ Colab は使えない）
 * @param deps.colabApi   { runtimeSpecs }
 * @returns {Promise<{ok: true, endpointId: string, added: boolean} | {ok: false, error: string}>}
 *   error: local-unavailable（「この PC」を既定に選んでいるが使えない）/ colab-not-configured（配布物に OAuth の設定が無い）/
 *          colab-signin-required / t4-not-available / 保存の失敗
 */
async function ensureDefaultEndpoint(deps) {
  const cfg = deps.endpoints.get();
  // 設定のファイルが読めないときは足さない（上書きすると利用者の書いた接続先が消える）
  if (cfg.problems.some((p) => String(p).startsWith("config:"))) return { ok: false, error: "config-unreadable" };
  const current = cfg.endpoints.map((e) => (deps.enrich ? deps.enrich(e) : e));
  const r = await resolveDefault({ endpoints: current, defaultId: cfg.defaultId, local: deps.local });
  if (!r.ok) return r;
  // 既に決まった（利用者が選んだもの・この PC・登録済み）。足さない
  if (r.id) return { ok: true, endpointId: r.id, added: false };
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
    defaultId: null,
  });
  if (!saved.ok) return { ok: false, error: (saved.problems && saved.problems[0]) || "save-failed" };
  return { ok: true, endpointId: DEFAULT_ID, added: true };
}

module.exports = { ensureDefaultEndpoint, resolveDefault, effectiveDefaultId, pickDefault, LOCAL_ID, DEFAULT_SPEC, DEFAULT_ID, DEFAULT_LABEL };
