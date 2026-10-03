// Colab のランタイムの確保・接続トークンの更新・解放。設計: fw/remote-compute-design.md §15
//
// 接続先（computeEndpoints の kind:"colab"）ごとに、確保したランタイムを 1 つ持つ。
// 確保したら、ランタイムの Jupyter（connectionInfo.url）と接続トークンを backend の登録簿へ入れる
// （onChange → pushComputeEndpoints）。backend から見ると普通の Jupyter Server と同じ。
//
// 守っていること:
//   - 接続トークンは約 1 時間で切れる（実測）。期限の 5 分前に GetRuntime で取り直して入れ直す。失敗したら 30 秒後に再試行
//   - Colab が回収した（GetRuntime が not-found）ら持っているランタイムを捨てる
//   - アプリを閉じるときは確保したランタイムを解放する（利用者の Colab の利用枠を使い続けない）
//   - トークンはレンダラへ返さない（status は確保しているか・種類・期限だけ）

const REFRESH_BEFORE_MS = 5 * 60 * 1000;
const RETRY_MS = 30 * 1000;

/**
 * @param api       createColabApi の戻り値
 * @param onChange  () => Promise<void>（backend へ入れ直す）
 * @param timers    テスト用（setTimeout / clearTimeout）
 */
function createColabRuntimes(api, onChange, timers = { setTimeout, clearTimeout, now: Date.now }) {
  /** endpointId → { name, url, token, expireTime, spec, label, timer } */
  const held = new Map();
  /** 確保中（同じ接続先へ同時に 2 つ作らない）。 */
  const creating = new Map();

  function schedule(id) {
    const r = held.get(id);
    if (!r) return;
    if (r.timer) timers.clearTimeout(r.timer);
    const due = Date.parse(r.expireTime) - REFRESH_BEFORE_MS - timers.now();
    r.timer = timers.setTimeout(() => void refresh(id), Math.max(due, 1000));
  }

  async function refresh(id) {
    const r = held.get(id);
    if (!r) return;
    try {
      const rt = await api.getRuntime(r.name);
      const ci = rt.connectionInfo || {};
      if (!ci.url || !ci.token) throw new Error("no connectionInfo");
      Object.assign(r, { url: ci.url, token: ci.token, expireTime: ci.expireTime });
      schedule(id);
      await onChange();
    } catch (e) {
      if (e && e.code === "not-found") {
        // Colab が回収した（idle・寿命）。持っているものを捨てる
        console.log(`[colab] runtime of ${id} was reclaimed by Colab`);
        drop(id);
        await onChange();
        return;
      }
      console.error(`[colab] token refresh failed for ${id}: ${e && e.message}`);
      r.timer = timers.setTimeout(() => void refresh(id), RETRY_MS);
    }
  }

  function drop(id) {
    const r = held.get(id);
    if (r && r.timer) timers.clearTimeout(r.timer);
    held.delete(id);
  }

  /** 確保済みならそれを、無ければ確保する。 */
  async function ensure(id, label, spec) {
    if (held.has(id)) return status(id);
    if (creating.has(id)) return creating.get(id);
    const p = (async () => {
      try {
        const rt = await api.createRuntime(spec);
        const ci = rt.connectionInfo || {};
        if (!ci.url || !ci.token) {
          await api.deleteRuntime(rt.name).catch(() => undefined);
          throw Object.assign(new Error("no connectionInfo"), { code: "no-connection-info" });
        }
        held.set(id, { name: rt.name, url: ci.url, token: ci.token, expireTime: ci.expireTime, spec, label });
        schedule(id);
        console.log(`[colab] allocated ${rt.name} (${spec.variant}/${spec.accelerator}) for ${id}`);
        await onChange();
        return status(id);
      } finally {
        creating.delete(id);
      }
    })();
    creating.set(id, p);
    return p;
  }

  async function release(id) {
    const r = held.get(id);
    if (!r) return { ok: true, released: false };
    drop(id);
    await onChange();
    try {
      await api.deleteRuntime(r.name);
    } catch (e) {
      console.error(`[colab] release failed for ${r.name}: ${e && e.message}`);
      return { ok: false, error: (e && e.code) || "release-failed" };
    }
    console.log(`[colab] released ${r.name}`);
    return { ok: true, released: true };
  }

  async function releaseAll() {
    await Promise.all([...held.keys()].map((id) => release(id)));
  }

  /** 画面へ返してよい状態（トークンは含めない）。 */
  function status(id) {
    const r = held.get(id);
    if (!r) return { allocated: false };
    return { allocated: true, name: r.name, spec: r.spec, expireTime: r.expireTime };
  }

  /** backend の登録簿へ入れる形（トークン込み。main の中でだけ使う）。 */
  function endpoints() {
    return [...held.entries()].map(([id, r]) => ({ id, label: r.label, url: r.url, token: r.token, kind: "colab" }));
  }

  return { ensure, release, releaseAll, status, endpoints, refresh };
}

module.exports = { createColabRuntimes, REFRESH_BEFORE_MS };
