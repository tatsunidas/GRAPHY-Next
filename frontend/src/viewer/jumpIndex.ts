/**
 * 「番号を指定して移動」の入力を、0 起点のインデックスへ直す。
 * 1 起点で入力される（画面の `n/N` 表示に合わせる）。範囲外は端に丸め、数字でなければ null。
 * 全角数字は半角として読む。count が 1 未満（移動先が無い）なら null。
 */
export function parseJumpIndex(text: string, count: number): number | null {
  if (count < 1) return null;
  const s = text.normalize("NFKC").trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Math.min(Math.max(n, 1), count) - 1;
}
