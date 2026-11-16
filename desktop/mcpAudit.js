// MCP 呼び出しの監査記録（本文なし）。設計: roadmap fw/mcp-server-design.md §7。electron に依存しない純モジュール。
//
// 🔴 **引数・結果の本文・患者識別子・トークンは残さない**。1 行の項目は許可リスト（`buildRecord`）だけを通す。
//    クライアントの自称名は外部の入力なので、制御文字を除いて 64 文字に切る。
const fs = require("node:fs");
const path = require("node:path");

/** 記録の上限。1 世代だけ残して上書きする（aiRequestLog と同じ）。 */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CODE_RE = /^[a-z0-9-]{1,40}$/;

const natural = (v) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const word = (v, re) => (typeof v === "string" && re.test(v) ? v : undefined);
function oneLine(s, max) {
  return String(s ?? "")
    .replace(new RegExp("[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]", "g"), " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function buildRecord(o) {
  const src = o && typeof o === "object" ? o : {};
  return {
    event: word(src.event, CODE_RE) ?? "call",
    tool: word(src.tool, NAME_RE),
    outcome: word(src.outcome, CODE_RE) ?? "other",
    bytes: natural(src.bytes),
    includePhi: src.includePhi === true,
    client: oneLine(src.client, 64),
  };
}

/** 記録器。書けなくても呼び出し側へ影響させない。 */
function createMcpAudit({ file, maxBytes = DEFAULT_MAX_BYTES, now = Date.now }) {
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
      /* 記録できなくても呼び出しは止めない */
    }
  }
  return { append };
}

module.exports = { buildRecord, createMcpAudit, oneLine };
