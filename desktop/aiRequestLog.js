// AI への要求の記録（本文なし）。設計: roadmap AS-QA-001。electron に依存しない純モジュール（結線は main.js）。
//
// 目的: クラウドのモデルが黙って更新されたとき、動作の変化に気づき原因を調べられるようにする。
// 🔴 **プロンプト・返答本文・ツールの引数と結果・画像・患者識別子・鍵・エラーの自由文は残さない**。
//    1 行の項目は許可リスト（下の `buildRecord`）だけを通し、入力がそれ以外を持っていても出力に現れない。
// 取れない値（トークン数など）は null＝不明。0 で埋めない。
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** 記録の上限。1 世代だけ残して上書きする。暫定値（利用実績で見直す）。 */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

const CODE_RE = /^[a-z0-9-]{1,40}$/;
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9._\-\/:]{1,120}$/;
const MAX_TOOL_CALLS = 16;

const natural = (v) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
/** 最近順位法（p = ⌈q·n⌉ 番目、昇順）。空なら null（0 にしない）。 */
function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(1, Math.ceil(q * sorted.length)) - 1];
}
const word = (v, re) => (typeof v === "string" && re.test(v) ? v : undefined);

/**
 * 1 行の形に整える。`o` は gateway が持つ値（提供元・モデル・usage・所要時間・結果・ツール名・添付の数）。
 * 許可リスト以外のキー・形式に合わない値は捨てる。
 */
function buildRecord(o) {
  const src = o && typeof o === "object" ? o : {};
  const usage = src.usage && typeof src.usage === "object" ? { in: natural(src.usage.in), out: natural(src.usage.out) } : null;
  const outcome = src.outcome === "ok" ? "ok" : word(src.outcome, CODE_RE) ?? "other";
  const images = src.attachments && src.attachments.images && typeof src.attachments.images === "object" ? src.attachments.images : {};
  const temperature = typeof src.temperature === "number" && Number.isFinite(src.temperature) ? src.temperature : undefined;
  const toolCalls = (Array.isArray(src.toolCalls) ? src.toolCalls : [])
    .map((n) => word(n, NAME_RE))
    .filter((n) => n !== undefined)
    .slice(0, MAX_TOOL_CALLS);
  return {
    sessionId: word(src.sessionId, NAME_RE),
    provider: word(src.provider, NAME_RE),
    kind: word(src.kind, NAME_RE),
    modelId: word(src.modelId, ID_RE),
    ...(word(src.modelVersion, ID_RE) ? { modelVersion: src.modelVersion } : {}),
    destination: src.destination === "local" ? "local" : "external",
    ...(word(src.fallbackFrom, NAME_RE) ? { fallbackFrom: src.fallbackFrom } : {}),
    params: temperature === undefined ? {} : { temperature },
    usage: usage && (usage.in !== null || usage.out !== null) ? usage : null,
    latencyMs: natural(Math.round(Number(src.latencyMs))),
    outcome,
    toolsOffered: natural(src.toolsOffered) ?? 0,
    toolCalls,
    attachments: { images: { count: natural(images.count) ?? 0, bytes: natural(images.bytes) ?? 0 } },
  };
}

/** 記録器。書けなくても呼び出し側へ影響させない（会話を止めない）。 */
function createRequestLog({ file, maxBytes = DEFAULT_MAX_BYTES, now = Date.now }) {
  function append(o) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        if (fs.statSync(file).size >= maxBytes) fs.renameSync(file, `${file}.1`);
      } catch {
        /* まだ無い */
      }
      fs.appendFileSync(file, JSON.stringify({ ts: new Date(now()).toISOString(), ...buildRecord(o) }) + "\n");
    } catch {
      /* 記録できなくても会話は止めない */
    }
  }

  function readAll() {
    const rows = [];
    for (const f of [`${file}.1`, file]) {
      let text = "";
      try {
        text = fs.readFileSync(f, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          if (e && typeof e === "object") rows.push(e);
        } catch {
          /* 壊れた行 */
        }
      }
    }
    return rows;
  }

  /** 件数、モデル別（要求数・入出力トークン合計・トークン不明の件数）、直近 `limit` 件（新しい順）。 */
  function summary(limit = 20) {
    const rows = readAll();
    const byModel = new Map();
    for (const r of rows) {
      const key = `${r.provider ?? "?"}\u0000${r.modelVersion ?? r.modelId ?? "?"}`;
      const m = byModel.get(key) ?? { provider: r.provider ?? null, model: r.modelVersion ?? r.modelId ?? null, requests: 0, tokensIn: 0, tokensOut: 0, unknownUsage: 0, latencies: [] };
      m.requests++;
      // 応答時間は成功した要求だけ（失敗・中断は応答の速さでない）
      if (r.outcome === "ok" && natural(r.latencyMs) !== null) m.latencies.push(r.latencyMs);
      // 合計は取れた値だけ。片方でも不明な要求は unknownUsage に数える（合計が下限であることが分かるように）
      if (r.usage && r.usage.in !== null) m.tokensIn += r.usage.in;
      if (r.usage && r.usage.out !== null) m.tokensOut += r.usage.out;
      if (!r.usage || r.usage.in === null || r.usage.out === null) m.unknownUsage++;
      byModel.set(key, m);
    }
    const models = [...byModel.values()].map(({ latencies, ...m }) => {
      const sorted = latencies.sort((a, b) => a - b);
      return { ...m, latency: sorted.length === 0 ? null : { n: sorted.length, p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95) } };
    });
    return { ok: true, count: rows.length, byModel: models, recent: rows.slice(-limit).reverse() };
  }

  function clear() {
    for (const f of [file, `${file}.1`]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* 無い */
      }
    }
    return { ok: true };
  }

  return { append, summary, clear };
}

// ── 回帰評価の結果（固定質問セットの実行結果）。形を許可リストで検査して保存する。 ──
const EVAL_MAX_BYTES = 512 * 1024;
const EVAL_ID_RE = /^[a-z0-9-]{1,24}$/;
const MAX_EVAL_CASES = 200;
const MAX_EVAL_LATENCY_MS = 60 * 60 * 1000;

/**
 * レンダラから届いた評価結果を保存できる形に整える（許可リスト）。形が違えば null。
 * 質問の本文・ツールの引数・返答は保存しない（質問 id と一致/不一致だけ）。
 */
function buildEvalRecord(o) {
  if (!o || typeof o !== "object" || !Array.isArray(o.cases) || o.cases.length === 0 || o.cases.length > MAX_EVAL_CASES) return null;
  const cases = [];
  for (const c of o.cases) {
    if (!c || typeof c.id !== "string" || !EVAL_ID_RE.test(c.id) || typeof c.pass !== "boolean") return null;
    // 応答時間は任意。範囲外・非整数はこの項目だけ捨てる（質問の合否は残す）
    const ms = natural(c.latencyMs);
    cases.push(ms !== null && ms <= MAX_EVAL_LATENCY_MS ? { id: c.id, pass: c.pass, latencyMs: ms } : { id: c.id, pass: c.pass });
  }
  // 合計は 1 問でも欠ければ不明（欠けを 0 として足さない）
  const totalLatencyMs = cases.every((c) => c.latencyMs !== undefined) ? cases.reduce((a, c) => a + c.latencyMs, 0) : null;
  const passed = cases.filter((c) => c.pass).length;
  const suiteVersion = natural(o.suiteVersion);
  if (suiteVersion === null || suiteVersion < 1) return null;
  const meta = o.meta && typeof o.meta === "object" ? o.meta : {};
  return {
    suiteVersion,
    provider: word(meta.provider, NAME_RE) ?? null,
    modelId: word(meta.modelId, ID_RE) ?? null,
    modelVersion: word(meta.modelVersion, ID_RE) ?? null,
    total: cases.length,
    passed,
    totalLatencyMs,
    cases,
  };
}

function createEvalStore({ file, maxBytes = EVAL_MAX_BYTES, now = Date.now }) {
  function append(o) {
    const rec = buildEvalRecord(o);
    if (!rec) return { ok: false, error: "bad-eval" };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        if (fs.statSync(file).size >= maxBytes) fs.renameSync(file, `${file}.1`);
      } catch {
        /* まだ無い */
      }
      fs.appendFileSync(file, JSON.stringify({ ts: new Date(now()).toISOString(), ...rec }) + "\n");
      return { ok: true };
    } catch {
      return { ok: false, error: "write-failed" };
    }
  }
  /** 新しい順に最大 `limit` 件。壊れた行・形の違う行は飛ばす。 */
  function list(limit = 20) {
    const rows = [];
    for (const f of [`${file}.1`, file]) {
      let text = "";
      try {
        text = fs.readFileSync(f, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          // 保存した行は由来が平らに入っている（buildEvalRecord の入力は meta の中）
          const rec = buildEvalRecord({ ...e, meta: { provider: e.provider, modelId: e.modelId, modelVersion: e.modelVersion } });
          if (rec && typeof e.ts === "string") rows.push({ ts: e.ts.slice(0, 40), ...rec });
        } catch {
          /* 壊れた行 */
        }
      }
    }
    return { ok: true, runs: rows.slice(-limit).reverse() };
  }
  function clear() {
    for (const f of [file, `${file}.1`]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* 無い */
      }
    }
    return { ok: true };
  }
  return { append, list, clear };
}

module.exports = { buildRecord, createRequestLog, buildEvalRecord, createEvalStore, DEFAULT_MAX_BYTES };
