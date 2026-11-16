/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 電子カルテ連携の、main プロセス側の純粋なロジック（electron を読み込まない。`node --test` で試せる）。
//
// 監視とファイルの読み取り・過去検査の取り込みは backend（standalone）。main は backend の状態を 1 秒ごとに見て、
//   ・患者が変わって、自動で開く設定なら、「その患者の直近の検査を開く」要求を送る
//   ・トレイの［電子カルテの患者を開く］で、同じ要求を送る
// を行う。レンダラのタイマーは、窓が隠れている（トレイ）間は間引かれて遅れるので、main で見る。
// 🔴 患者 ID はログに出さない。

const POLL_MS = 1000;

/**
 * backend の状態を見て、自動で開くべきか決める（純関数）。
 * @param {object|null} status `GET /api/emr/status` の応答（取れなければ null）
 * @param {number|null} lastSeq 最後に見た通し番号（null＝まだ基準を持っていない）
 * @returns {{open: string|null, lastSeq: number|null}}
 */
function decide(status, lastSeq) {
  if (!status || typeof status !== "object") return { open: null, lastSeq }; // 取れない間は何もしない（基準も変えない）
  const patient = status.patient;
  const seq = patient && Number.isInteger(patient.seq) ? patient.seq : 0;
  if (lastSeq === null) return { open: null, lastSeq: seq }; // 最初の 1 回は基準として覚えるだけ（起動しただけで患者を開かない）
  if (seq < lastSeq) return { open: null, lastSeq: seq }; // backend が作り直された（通し番号が戻った）
  if (seq === lastSeq) return { open: null, lastSeq };
  // 通し番号が進んだ: ID が変わった
  const shouldOpen = status.enabled === true && status.valid === true && status.autoOpen === true
    && patient && typeof patient.id === "string" && patient.id.length > 0;
  return { open: shouldOpen ? patient.id : null, lastSeq: seq };
}

/**
 * 1 秒ごとに backend を見て、開くべきときに onOpen(patientId) を呼ぶ。重ならない（前の問い合わせが終わってから次を待つ）。
 * @param {{fetchStatus: () => Promise<object|null>, onOpen: (patientId: string) => void,
 *          intervalMs?: number, setTimer?: Function, clearTimer?: Function}} deps
 */
function createWatcher(deps) {
  const { fetchStatus, onOpen } = deps;
  const intervalMs = deps.intervalMs ?? POLL_MS;
  const setT = deps.setTimer ?? setTimeout;
  const clearT = deps.clearTimer ?? clearTimeout;
  let lastSeq = null;
  let timer = null;
  let stopped = true;

  async function tick() {
    let status = null;
    try {
      status = await fetchStatus();
    } catch {
      status = null; // backend が応答しない間は、何もしない
    }
    const d = decide(status, lastSeq);
    lastSeq = d.lastSeq;
    if (d.open) {
      try {
        onOpen(d.open);
      } catch {
        // 開く側の失敗で、監視を止めない
      }
    }
  }

  async function loop() {
    if (stopped) return;
    await tick();
    if (!stopped) timer = setT(loop, intervalMs);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      lastSeq = null;
      timer = setT(loop, intervalMs);
    },
    stop() {
      stopped = true;
      if (timer) clearT(timer);
      timer = null;
    },
    tick, // テスト用
  };
}

/**
 * トレイの［電子カルテの患者を開く］。いまの患者の過去検査がまだ取り込めていなければ、取りに行かせてから開く要求を送る。
 * @param {{fetchStatus: () => Promise<object|null>, postPrefetch: () => Promise<unknown>, enqueue: (req: object) => void}} deps
 * @returns {Promise<{ok: true} | {ok: false, reason: "unavailable"|"disabled"|"no-patient"}>}
 */
async function openNow(deps) {
  let status = null;
  try {
    status = await deps.fetchStatus();
  } catch {
    status = null;
  }
  if (!status) return { ok: false, reason: "unavailable" };
  if (status.enabled !== true || status.valid !== true) return { ok: false, reason: "disabled" };
  const p = status.patient;
  if (!p || typeof p.id !== "string" || p.id.length === 0) return { ok: false, reason: "no-patient" };
  const f = status.fetch || {};
  const fresh = f.patientId === p.id && f.latestReady === true;
  if (!fresh) {
    try {
      await deps.postPrefetch();
    } catch {
      // 取りに行けなくても、開く側が状態を見て、手元の検査に逃げる
    }
  }
  deps.enqueue({ ok: true, req: { patientId: p.id, latest: true } });
  return { ok: true };
}

module.exports = { POLL_MS, decide, createWatcher, openNow };
