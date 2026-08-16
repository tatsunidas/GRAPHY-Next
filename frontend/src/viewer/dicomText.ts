/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * DICOM のテキスト値を SpecificCharacterSet に従って読む。
 *
 * <p><b>なぜ要るのか</b>: フロントは dicom-parser でタグを読むが、その {@code dataSet.string()} は
 * バイトを 1 つずつ {@code String.fromCharCode} するだけで、<b>SpecificCharacterSet (0008,0005) を
 * 一切見ない</b>。UTF-8（ISO_IR 192）の日本語は必ず化ける。
 *
 * <pre>
 *   "腹部 単純 CT" → UTF-8 16 バイト → "è¹é¨ åç´ CT"
 * </pre>
 *
 * <p>シリーズ一覧が正しく出るのは、あちらが backend の REST を通っており、dcm4che が
 * 文字セットを見て正しくデコードしているため。<b>同じ値が画面の場所によって化けたり化けなかったり</b>
 * するのはこの差による。
 *
 * <p><b>扱える範囲</b>: 単一バイト系（既定の ASCII / ISO_IR 100 等）と UTF-8 は正しく読む。
 * 日本語の ISO 2022 系（ISO 2022 IR 87 = JIS X 0208 等）はエスケープシーケンスで文字集合を
 * 切り替える方式で、{@code TextDecoder("iso-2022-jp")} に委ねる。DICOM の使い方は
 * ISO-2022-JP と完全には一致しないため、ここは<b>最善努力</b>であり、読めなければ
 * 従来どおりの読み方に落とす（化けはするが、例外で表示が消えるよりはよい）。
 */

/** dicom-parser の DataSet（型は持ち込まない）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DataSet = any;

/**
 * SpecificCharacterSet の値 → TextDecoder のエンコーディング名。
 *
 * <p>複数値（`\` 区切り）のときは、コード拡張を伴う 2 番目以降が本体になる。日本語データは
 * 先頭が空（＝既定の ASCII）で 2 番目に `ISO 2022 IR 87` が来る形が多い。
 */
export function charsetToEncoding(specificCharacterSet: string | null | undefined): string {
  if (!specificCharacterSet) return "ascii";
  const terms = specificCharacterSet
    .split("\\")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s !== "");
  // 明示された文字集合のうち、最初に判断できるものを採る
  for (const term of terms) {
    switch (term) {
      case "ISO_IR 192":
        return "utf-8";
      case "ISO_IR 6":
        return "ascii";
      case "ISO_IR 100":
      case "ISO 2022 IR 100":
        return "iso-8859-1";
      case "ISO_IR 101":
      case "ISO 2022 IR 101":
        return "iso-8859-2";
      case "ISO_IR 109":
      case "ISO 2022 IR 109":
        return "iso-8859-3";
      case "ISO_IR 110":
      case "ISO 2022 IR 110":
        return "iso-8859-4";
      case "ISO_IR 144":
      case "ISO 2022 IR 144":
        return "iso-8859-5";
      case "ISO_IR 127":
      case "ISO 2022 IR 127":
        return "iso-8859-6";
      case "ISO_IR 126":
      case "ISO 2022 IR 126":
        return "iso-8859-7";
      case "ISO_IR 138":
      case "ISO 2022 IR 138":
        return "iso-8859-8";
      case "ISO_IR 148":
      case "ISO 2022 IR 148":
        return "iso-8859-9";
      case "ISO_IR 166":
      case "ISO 2022 IR 166":
        return "windows-874"; // タイ語（TIS 620）
      case "ISO 2022 IR 13": // 日本語 半角カナ (JIS X 0201)
      case "ISO 2022 IR 87": // 日本語 (JIS X 0208)
      case "ISO 2022 IR 159": // 日本語 補助漢字 (JIS X 0212)
        return "iso-2022-jp";
      case "ISO 2022 IR 149":
        return "euc-kr"; // 韓国語
      case "ISO 2022 IR 58":
      case "GB18030":
        return "gb18030"; // 中国語
      default:
        break; // 判断できない項目は読み飛ばして次を見る
    }
  }
  return "ascii";
}

/**
 * バイト列を文字セットに従って文字列にする。
 *
 * <p>デコードできない場合は、1 バイト 1 文字の従来の読み方に落とす。表示が消えるより
 * 化けたまま出た方が、原因に気づける分ましなため。
 */
export function decodeDicomBytes(
  bytes: Uint8Array,
  specificCharacterSet: string | null | undefined,
): string {
  const encoding = charsetToEncoding(specificCharacterSet);
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
  }
}

/** DICOM のテキスト値は空白または NULL で偶数長に詰められる。 */
function trimPadding(s: string): string {
  return s.replace(/\0+$/, "").replace(/\s+$/, "");
}

/**
 * SpecificCharacterSet を見てタグの文字列値を読む。
 *
 * @param ds  dicom-parser の DataSet
 * @param tag 8 桁のタグ（例 "0008103E"。大文字小文字は問わない）
 */
export function readDicomString(ds: DataSet, tag: string): string | null {
  if (!ds) return null;
  const key = "x" + tag.toLowerCase();
  const element = ds.elements?.[key];
  const byteArray: Uint8Array | undefined = ds.byteArray;

  // 生バイトが取れないときは dicom-parser の読み方をそのまま使う（従来どおり）
  if (!element || !byteArray || typeof element.dataOffset !== "number" || !element.length) {
    const fallback = ds.string?.(key);
    return fallback == null || fallback === "" ? null : trimPadding(String(fallback));
  }

  // 文字セット自体は必ず ASCII なので dicom-parser の読み方で足りる
  const charset: string | undefined = ds.string?.("x00080005");
  const bytes = byteArray.subarray(element.dataOffset, element.dataOffset + element.length);
  const decoded = trimPadding(decodeDicomBytes(bytes, charset));
  return decoded === "" ? null : decoded;
}
