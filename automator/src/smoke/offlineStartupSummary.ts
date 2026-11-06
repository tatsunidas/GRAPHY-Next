/*
 * 起動時間の測定（offlineStartupWin.ts）の集計。純関数だけ（実機に触らない）。
 */

export interface LogLine {
  /** 起動の直前を 0 とした経過秒。 */
  t: number;
  text: string;
}

export interface StartupRun {
  version: string;
  /** normal=通常／fw-blocked=ファイアウォールでアプリの送信を遮断（接続は即失敗する）／dns-dead=DNS サーバーが応答しない（名前解決がタイムアウトまで待たされる）／pac-dead=プロキシの自動設定（PAC）の URL が応答しない。 */
  condition: "normal" | "fw-blocked" | "dns-dead" | "pac-dead";
  index: number;
  /** スプラッシュが見えた・/api/status が 200 になった・メイン画面が見えた時刻（秒。起動の直前が 0）。見えなければ null。 */
  splashAt: number | null;
  backendReadyAt: number | null;
  mainAt: number | null;
  timedOut: boolean;
  /** 追加の計測値（Chromium のプロキシ解決の所要時間 [ms] など）。 */
  extra?: Record<string, number>;
  lines: LogLine[];
}

/** 連続する 2 行の間隔が大きい所（待ちが起きた場所の手がかり）。大きい順に n 件。 */
export function longestGaps(lines: LogLine[], n = 3): { gap: number; after: string; before: string; at: number }[] {
  const out: { gap: number; after: string; before: string; at: number }[] = [];
  for (let i = 1; i < lines.length; i++) {
    out.push({ gap: lines[i].t - lines[i - 1].t, after: lines[i - 1].text, before: lines[i].text, at: lines[i - 1].t });
  }
  return out.sort((a, b) => b.gap - a.gap).slice(0, n);
}

export function median(a: number[]): number | null {
  if (a.length === 0) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
}

const fmt = (v: number | null): string => (v === null ? "—" : v.toFixed(1));
const cut = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Markdown の表（版 × 条件 × 回）と、条件ごとの中央値、最も長い間隔。 */
export function renderSummary(runs: StartupRun[]): string {
  const rows: string[] = [];
  rows.push("| 版 | 条件 | 回 | スプラッシュ | backend 応答 | メイン画面 | 最も長い間隔（前の行 → 次の行） |");
  rows.push("|---|---|---|---|---|---|---|");
  for (const r of runs) {
    const g = longestGaps(r.lines, 1)[0];
    const gap = g ? `${g.gap.toFixed(1)} s @${g.at.toFixed(1)}（${cut(g.after, 40)} → ${cut(g.before, 40)}）` : "—";
    const ex = r.extra && Object.keys(r.extra).length ? ` ${JSON.stringify(r.extra)}` : "";
    rows.push(`| ${r.version} | ${r.condition} | ${r.index} | ${fmt(r.splashAt)} | ${fmt(r.backendReadyAt)} | ${fmt(r.mainAt)}${r.timedOut ? "（時間切れ）" : ""} | ${gap}${ex} |`);
  }
  rows.push("");
  rows.push("| 版 | 条件 | backend 応答の中央値 [s] | メイン画面の中央値 [s] | 件数 |");
  rows.push("|---|---|---|---|---|");
  const keys = [...new Set(runs.map((r) => `${r.version}|${r.condition}`))];
  for (const k of keys) {
    const [version, condition] = k.split("|");
    const rs = runs.filter((r) => r.version === version && r.condition === condition);
    rows.push(`| ${version} | ${condition} | ${fmt(median(rs.map((r) => r.backendReadyAt).filter((x): x is number => x !== null)))} | ${fmt(median(rs.map((r) => r.mainAt).filter((x): x is number => x !== null)))} | ${rs.length} |`);
  }
  return rows.join("\n");
}
