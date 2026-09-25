/**
 * フレーム番号（**1-based**）の集合演算 — Java の `com.vis.uvs.common.Indices` の写し。
 *
 * <h3>なぜ写しを持つのか</h3>
 * しきい値のハンドルをドラッグするたびにサーバへ往復していては手が止まる。**再合成はフロントで
 * 即時に行う**（設計 §画面）。したがって合成規則は 2 か所に存在することになる——
 * 🔴 **正本は Java 側**であり、こちらはその写し。両者は共有テストベクタ
 * `testdata/summary-composer-cases.json` で縛る。
 *
 * <h3>🔴 1-based と 0-based を混ぜない</h3>
 * `Indices` / `SummaryComposer` の世界は **1-based**。一方 `cpr[]` / `mad[]` /
 * `sampleIndices[]`（JAR が返す配列）は **0-based**。取り違えると **1 フレームずれた、
 * それらしく見える要約**が出て、見て気付けない。型で分けて、変換は下の 2 関数だけを通す。
 */

declare const frame1Brand: unique symbol;

/** 1-based のフレーム番号（Indices / SummaryComposer の世界）。 */
export type Frame1 = number & { readonly [frame1Brand]: true };

/** 0-based のフレーム位置（JAR が返す配列の添字）。 */
export type Frame0 = number;

/** 0-based → 1-based。**ここ以外で +1 を書かない。** */
export const toFrame1 = (i: Frame0): Frame1 => (i + 1) as Frame1;

/** 1-based → 0-based。**ここ以外で −1 を書かない。** */
export const toFrame0 = (f: Frame1): Frame0 => f - 1;

/** 数値をそのまま 1-based として扱う（テストベクタ・利用者入力の取り込み用）。 */
export const asFrame1 = (n: number): Frame1 => n as Frame1;

const sortedUnique = (xs: Iterable<Frame1>): Frame1[] => [...new Set(xs)].sort((a, b) => a - b);

/** 和集合（昇順・重複なし）。null / undefined は空として扱う。 */
export function merge(a: readonly Frame1[] | null | undefined, b: readonly Frame1[] | null | undefined): Frame1[] {
  return sortedUnique([...(a ?? []), ...(b ?? [])]);
}

/** 差集合 `all - remove`（昇順・重複なし）。 */
export function subtract(
  all: readonly Frame1[] | null | undefined,
  remove: readonly Frame1[] | null | undefined,
): Frame1[] {
  const drop = new Set<number>(remove ?? []);
  return sortedUnique([...(all ?? [])].filter((x) => !drop.has(x)));
}

/** 補集合。`1..frameCount` のうち `list` に含まれないもの。`list` が null なら null。 */
export function oppose(list: readonly Frame1[] | null | undefined, frameCount: number): Frame1[] | null {
  if (list == null) return null;
  const has = new Set<number>(list);
  const out: Frame1[] = [];
  for (let i = 1; i <= frameCount; i++) if (!has.has(i)) out.push(i as Frame1);
  return out;
}

/** `1..frameCount` の全フレーム。 */
export function all(frameCount: number): Frame1[] {
  const out: Frame1[] = [];
  for (let i = 1; i <= frameCount; i++) out.push(i as Frame1);
  return out;
}

/**
 * `"1,5-8,12"` 形式を展開する（Swing の `Utils.str2indices` と同じ解釈）。
 * 数字・カンマ・ハイフン以外は読み飛ばす。壊れた区間は捨てる（例外にしない）。
 */
export function parse(spec: string | null | undefined): Frame1[] {
  if (!spec || !spec.trim()) return [];
  const sanitized = spec.replace(/[^0-9,\-]/g, "");
  const set = new Set<number>();
  for (const part of sanitized.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const dash = trimmed.indexOf("-");
    if (dash > 0) {
      const range = trimmed.split("-");
      if (range.length !== 2) continue;
      const start = Number.parseInt(range[0], 10);
      const end = Number.parseInt(range[1], 10);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) continue;
      for (let i = start; i <= end; i++) set.add(i);
    } else {
      const v = Number.parseInt(trimmed, 10);
      if (Number.isFinite(v)) set.add(v);
    }
  }
  return sortedUnique([...set] as Frame1[]);
}

/** インデックス列を `"1-3,5,8-10"` 形式へ畳む（Swing の `Utils.listToIndicesString` と同じ）。 */
export function format(indices: readonly Frame1[] | null | undefined): string {
  if (!indices || indices.length === 0) return "";
  const sorted = sortedUnique(indices);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i];
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    const end = sorted[j];
    parts.push(start === end ? String(start) : `${start}-${end}`);
    i = j + 1;
  }
  return parts.join(",");
}

/**
 * 間引かれたスコアを全フレーム長へ**区分線形補間**する（Swing の `Utils.interpolate` と同一）。
 *
 * <p>推論は `interval` フレームおきにしか走らないので、間を線形で埋めてから閾値を当てる。
 * 🔴 **`known` は「サンプル順の密配列」**。穴あきを渡してはいけない——Java 側も値の**並び順**
 * しか見ないので、1 つ欠けると以降がまるごと 1 サンプルぶんずれる（それらしい形のまま）。
 */
export function interpolate(known: readonly number[], size: number, interval: number): number[] {
  if (!known || known.length === 0) throw new Error("補間元のスコアが空です");
  if (size <= 0) return [];
  if (interval < 1) throw new Error(`interval は 1 以上である必要があります: ${interval}`);

  const result = new Array<number>(size);
  for (let i = 0; i < size; i++) {
    if (i === 0) {
      result[0] = known[0];
      continue;
    }
    if (i === size - 1) {
      result[size - 1] = known[known.length - 1];
      break;
    }
    const k = Math.floor(i / interval);
    if (i % interval === 0) {
      result[i] = k < known.length ? known[k] : known[known.length - 1];
    } else if (k >= known.length - 1) {
      result[i] = known[known.length - 1];
    } else {
      const start = known[k];
      const end = known[k + 1];
      const x1 = k * interval;
      result[i] = start + (end - start) * ((i - x1) / interval);
    }
  }
  return result;
}
