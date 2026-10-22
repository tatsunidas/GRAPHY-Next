/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// アシスタントが操作案内に使う資料（docs/*.md）の分割と検索。埋め込みモデルは使わず、
// 見出し単位の断片に、質問との語の一致で点を付けて上位を返す（外部送信も索引ファイルも要らない）。

export interface DocChunk {
  /** 例: "viewer2d.md" */
  file: string;
  /** 見出しの並び（"2D ビューア › 画面の構成"）。出典表示に使う。 */
  heading: string;
  text: string;
}

export interface DocHit extends DocChunk {
  score: number;
}

/** `##` までの見出しで割る。それより深い見出しは本文に残す（細かく割ると文脈が痩せるため）。 */
export function splitDocs(files: Record<string, string>): DocChunk[] {
  const out: DocChunk[] = [];
  for (const [path, raw] of Object.entries(files)) {
    const file = path.split("/").pop() ?? path;
    let h1 = "";
    let h2 = "";
    let buf: string[] = [];
    const flush = () => {
      const text = buf.join("\n").trim();
      if (text) out.push({ file, heading: [h1, h2].filter(Boolean).join(" › ") || file, text });
      buf = [];
    };
    for (const line of raw.split(/\r?\n/)) {
      const m = /^(#{1,2})\s+(.*\S)\s*$/.exec(line);
      if (m) {
        flush();
        if (m[1].length === 1) {
          h1 = m[2];
          h2 = "";
        } else h2 = m[2];
      } else buf.push(line);
    }
    flush();
  }
  return out;
}


/** 英数字は語、日本語は連続部分の 2 文字組（形態素解析なしで語尾の揺れに強い）。 */
export function tokenize(s: string): string[] {
  const text = s.toLowerCase().normalize("NFKC");
  const out: string[] = [];
  for (const w of text.match(/[a-z0-9][a-z0-9_.-]*/g) ?? []) if (w.length >= 2) out.push(w);
  for (const run of text.match(/[぀-ヿ㐀-鿿]+/g) ?? []) {
    if (run.length === 1) continue;
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

/**
 * 全断片の半分以上に出る語は手掛かりにならない（「する」「ます」や「画面」など）ので無視する。
 * 0.5 は「過半数」という意味の線で、データから当てた値ではない。
 */
const COMMON_DF = 0.5;

export interface SearchOptions {
  k: number;
  /** 1 断片あたり返す最大文字数。 */
  maxChars: number;
  /** これ未満の点は返さない（無関係な質問に資料を添えないため）。 */
  minScore: number;
}

export function searchDocs(chunks: DocChunk[], query: string, opt: SearchOptions): DocHit[] {
  const q = Array.from(new Set(tokenize(query)));
  if (!q.length || !chunks.length) return [];
  const bodies = chunks.map((c) => new Set(tokenize(c.text)));
  const heads = chunks.map((c) => new Set(tokenize(c.heading)));
  const n = chunks.length;
  const df = (t: string) => bodies.reduce((a, b, i) => a + (b.has(t) || heads[i].has(t) ? 1 : 0), 0);
  const weights = q
    .map((t) => {
      const d = df(t);
      return { t, w: d === 0 || d / n > COMMON_DF ? 0 : Math.log(1 + n / d) };
    })
    .filter((x) => x.w > 0);
  const hits: DocHit[] = [];
  chunks.forEach((c, i) => {
    let score = 0;
    let matched = 0;
    for (const { t, w } of weights) {
      if (heads[i].has(t)) score += 2 * w;
      else if (bodies[i].has(t)) score += w;
      else continue;
      matched++;
    }
    // 2 文字組 1 つの偶然の一致（無関係な質問が資料に当たる）を弾くため、語が 2 つ以上一致することを求める。
    // 手掛かりになる語が 1 つしかない質問だけ 1 つで足りる。
    if (matched >= Math.min(2, weights.length) && score >= opt.minScore) hits.push({ ...c, text: c.text.slice(0, opt.maxChars), score });
  });
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, opt.k);
}

