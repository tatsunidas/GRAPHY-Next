/*
 * 自動更新の通し確認（updateE2e.ts）の純ロジック。実機に触らない。
 */

/** タグ（v0.6.2）から版（0.6.2）。 */
export function versionOfTag(tag: string): string {
  const v = tag.trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`版の形ではありません: ${tag}`);
  return v;
}

/** その版の、OS ごとの資産名（アプリ・リリースの CI が使う名前）。 */
export function assetNameFor(platform: "win32" | "linux", version: string): string {
  return platform === "win32" ? `GRAPHY-Next.Setup.${version}.exe` : `GRAPHY-Next-${version}.AppImage`;
}

/**
 * 署名（.minisig）の署名本体を 1 文字だけ変える（負例用）。形式は保ち（base64 のまま・長さも同じ）、鍵 ID とアルゴリズムの部分
 * （先頭 10 バイト＝約 14 文字）には触れない。→ 署名の検証が「bad-signature」で落ちる。
 */
export function tamperSignature(sigText: string): string {
  const lines = sigText.replace(/\r\n/g, "\n").split("\n");
  const idx = lines.findIndex((l, i) => i > 0 && !l.startsWith("untrusted comment:") && !l.startsWith("trusted comment:") && l.trim() !== "");
  if (idx < 0) throw new Error("署名行が見つかりません");
  const l = lines[idx];
  const pos = 40;
  const c = l[pos];
  const alt = c === "A" ? "B" : "A";
  lines[idx] = l.slice(0, pos) + alt + l.slice(pos + 1);
  return lines.join("\n");
}

export interface Check {
  label: string;
  ok: boolean | null; // null = 未達
  detail?: unknown;
}

/** 合格・失敗・未達の数。 */
export function tally(checks: Check[]): { pass: number; fail: number; pending: number } {
  return {
    pass: checks.filter((c) => c.ok === true).length,
    fail: checks.filter((c) => c.ok === false).length,
    pending: checks.filter((c) => c.ok === null).length,
  };
}

export function renderChecks(checks: Check[]): string {
  const rows = ["| 結果 | 項目 | 詳細 |", "|---|---|---|"];
  for (const c of checks) {
    rows.push(`| ${c.ok === true ? "合格" : c.ok === false ? "**失敗**" : "未達"} | ${c.label} | ${c.detail === undefined ? "" : JSON.stringify(c.detail).slice(0, 160)} |`);
  }
  const t = tally(checks);
  rows.push("", `合格 ${t.pass}・失敗 ${t.fail}・未達 ${t.pending}`);
  return rows.join("\n");
}
