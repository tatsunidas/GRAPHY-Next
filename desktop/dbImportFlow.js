// 外付けドライブなどの荷物を、今の DB に取り込む流れ（画面の「荷物を取り込む」と MCP が使う）。
//
// 取り込み元のフォルダは、利用者が main のダイアログで選んだものだけを backend の内部経路へ渡す。
// **フォルダの場所はこのモジュールの外（レンダラ・AI）へ返さない。** electron に依存しない（ダイアログは呼ぶ側が渡す）。

const BASE = "/api/internal/db-transfer/import";
const OUTCOMES = ["imported", "too-new", "invalid-manifest", "incomplete", "damaged", "failed"];

function formatBytes(n) {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  return `${Math.ceil(n / 1024)} KB`;
}

function pluginNoteText(n, ja) {
  if (n.kind === "missing") {
    return ja ? `プラグイン「${n.id}」はこの PC に入っていません（記録は取り込みます）。` : `Plug-in "${n.id}" is not installed here (its records are still imported).`;
  }
  if (n.kind === "different") {
    return ja ? `プラグイン「${n.id}」の版が違います（移し元 ${n.sourceVersion}・この PC ${n.localVersion}）。` : `Plug-in "${n.id}" versions differ (source ${n.sourceVersion}, here ${n.localVersion}).`;
  }
  return ja ? `プラグイン「${n.id}」の移し元の版は分かりません。` : `The source version of plug-in "${n.id}" is unknown.`;
}

/** 確認ダイアログに出す要約。荷物の中の文字列は、版と id だけを使う。 */
function summaryText(scan, ja) {
  const ok = scan.packages.filter((p) => !p.problem);
  const bad = scan.packages.length - ok.length;
  const sum = (k) => ok.reduce((a, p) => a + p[k], 0);
  const lines = [
    ja
      ? `荷物 ${ok.length} 個・検査 ${sum("studies")} 件・画像 ${sum("files")} 枚・${formatBytes(sum("bytes"))}`
      : `${ok.length} package(s), ${sum("studies")} study(ies), ${sum("files")} image(s), ${formatBytes(sum("bytes"))}`,
  ];
  if (bad > 0) lines.push(ja ? `⚠ 取り込めない荷物が ${bad} 個あります（目録が壊れているか、新しい版で作られています）。` : `⚠ ${bad} package(s) cannot be imported (broken manifest or made by a newer version).`);
  if (scan.stalePartials > 0) lines.push(ja ? `⚠ 途中で止まった荷物が ${scan.stalePartials} 個あります（取り込みません）。` : `⚠ ${scan.stalePartials} interrupted package(s) will be skipped.`);
  const notes = new Map();
  for (const p of ok) for (const n of p.pluginNotes || []) notes.set(pluginNoteText(n, ja), true);
  lines.push(...notes.keys());
  lines.push("", ja ? "今の DB にあるデータは上書きしません。取り込み元は変更しません。" : "Existing data is never overwritten. The source is not modified.");
  return lines.join("\n");
}

/** backend の結果から、画面と AI に返してよいものだけを取り出す（パス・移し元の DB の場所・エラーの本文は返さない）。 */
function publicStatus(job) {
  return {
    state: job.state,
    studies: (job.studyUids || []).length,
    studyUids: job.studyUids || [],
    packages: (job.packages || []).map((p) => {
      const r = p.result || {};
      return {
        outcome: OUTCOMES.includes(p.outcome) ? p.outcome : "failed",
        imported: r.imported || 0,
        skippedExisting: r.skippedExisting || 0,
        failed: r.failed || 0,
        relatedInserted: r.relatedInserted || 0,
        relatedSame: r.relatedSame || 0,
        conflicts: r.conflicts || 0,
        pluginNotes: (r.pluginNotes || []).map((n) => ({ id: n.id, sourceVersion: n.sourceVersion, localVersion: n.localVersion, kind: n.kind })),
      };
    }),
  };
}

/** backend の理由（"not-enough-space: 1 / 2" など）を、記号だけにする。 */
function reasonOf(r) {
  const m = r && r.body && typeof r.body.message === "string" ? /^[a-z0-9-]+/.exec(r.body.message) : null;
  if (m) return m[0];
  return r && r.status ? `backend-${r.status}` : (r && r.error) || "backend-unreachable";
}

/**
 * @param deps { call(method, path, body, timeoutMs), pickDirectory(): Promise<string|null>,
 *               confirm(detail): Promise<boolean>, ja(): boolean }
 */
function createDbImportFlow(deps) {
  let choosing = false;

  /** フォルダを選ばせ、中身を見せて確かめてから、取り込みを始める。 */
  async function start(overrides = {}) {
    if (choosing) return { ok: false, reason: "busy" };
    choosing = true;
    try {
      const pick = overrides.pickDirectory || deps.pickDirectory;
      const confirm = overrides.confirm || deps.confirm;
      const folder = await pick();
      if (!folder) return { ok: false, canceled: true };
      const scan = await deps.call("POST", `${BASE}/scan`, { folder }, 120000);
      if (!scan.ok || !scan.body) return { ok: false, reason: reasonOf(scan) };
      const s = scan.body;
      if (!s.packages.some((p) => !p.problem)) {
        const problem = s.packages[0] && s.packages[0].problem;
        return { ok: false, reason: problem || (s.stalePartials > 0 ? "only-interrupted" : "no-packages") };
      }
      if (!s.enoughSpace) return { ok: false, reason: "not-enough-space", requiredBytes: s.requiredBytes, freeBytes: s.freeBytes };
      if (!(await confirm(summaryText(s, overrides.ja ?? deps.ja())))) return { ok: false, canceled: true };
      const r = await deps.call("POST", BASE, { folder }, 120000);
      if (!r.ok || !r.body || !r.body.jobId) return { ok: false, reason: reasonOf(r) };
      return { ok: true, jobId: r.body.jobId };
    } finally {
      choosing = false;
    }
  }

  async function status(jobId) {
    if (!/^[0-9a-f-]{36}$/.test(String(jobId))) return { ok: false, reason: "job-not-found" };
    const r = await deps.call("GET", `${BASE}/${jobId}`, null, 15000);
    if (!r.ok || !r.body) return { ok: false, reason: reasonOf(r) };
    return { ok: true, ...publicStatus(r.body) };
  }

  return { start, status };
}

module.exports = { createDbImportFlow, summaryText, publicStatus, reasonOf };
