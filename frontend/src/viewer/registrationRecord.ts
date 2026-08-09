/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 位置合わせ結果の保存形式と、入力の同一性検査（純関数・DOM も cornerstone も非依存）。
 *
 * <h3>なぜ「保存」なのか — 再現と再計算は別物 ★</h3>
 *
 * <ul>
 *   <li><b>再現（restore）</b>: 保存した変換を読み戻す。<b>常に同一</b>。臨床で要るのはこれ。</li>
 *   <li><b>再計算（recompute）</b>: 同じ手順をやり直す。エンジンやブラウザが変われば変わりうる。</li>
 * </ul>
 *
 * <p>エンジンは決定的に作ってある（シード固定・縮約順序固定。設計 §6）が、それは
 * <b>コードが同一である限り</b>の話である。バージョンが上がれば結果は変わりうるので、
 * <b>再現性を再計算に依存させてはいけない</b>。結果そのものを保存するのが唯一の担保になる。
 * 決定性は監査とデバッグのために別途価値がある。
 *
 * <h3>なぜ指紋が要るのか ★</h3>
 *
 * <p><b>同じ SeriesInstanceUID でも中身が違うことがある</b>（取り込み直し、匿名化、
 * 別 PACS からの再取得、C/T の構成変更）。気付かずに変換を当てると、
 * <b>もっともらしいが間違った重ね合わせ</b>が復元される。保存時に入力の指紋を残し、
 * 復元時に照合して、合わなければ<b>黙って適用しない</b>。
 */

import type { ManualAdjust } from "./regTransform";
import type { RegistrationResult } from "./regResult";

/** 保存形式の版。互換性の無い変更をしたら上げる。 */
export const REGISTRATION_RECORD_VERSION = 1;

/** 指紋の材料。`SeriesLayoutDto` から作れる範囲に限る（画素は読まない）。 */
export interface SeriesFingerprintInput {
  readonly seriesInstanceUid: string;
  /** スライス枚数（z 方向）。 */
  readonly sliceCount: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly pixelSpacingCol: number;
  readonly pixelSpacingRow: number;
  /** IOP 6 要素。無ければ空配列。 */
  readonly iop: readonly number[];
  /** 先頭と末尾のスライスの IPP。幾何が変わったことを最も安く検出できる。 */
  readonly firstIpp: readonly number[] | null;
  readonly lastIpp: readonly number[] | null;
}

export interface SeriesRef {
  readonly studyInstanceUid: string;
  readonly seriesInstanceUid: string;
  /** どの C/T を使ったか。5D シリーズでは変換の意味が C/T ごとに違う。 */
  readonly c: number;
  readonly t: number;
  readonly fingerprint: string;
}

/** 表示側（見た目まで同じに戻したいときに使う）。 */
export interface DisplayState {
  readonly opacity: number;
  readonly lutName: string | null;
  readonly wl: { center: number; width: number } | null;
}

export interface RegistrationRecord {
  readonly version: number;
  /** ISO 8601。いつの結果かが分からないと、どれを信じるか決められない。 */
  readonly savedAt: string;
  readonly fixed: SeriesRef;
  readonly moving: SeriesRef;
  /** 自動位置合わせの結果（手動だけのときは null）。 */
  readonly registration: RegistrationResult | null;
  /** 手動調整の 6 値。**合成の後段**なので、これが無いと同じ絵にならない。 */
  readonly adjust: ManualAdjust;
  readonly display?: DisplayState;
  /** どのアプリ版で作ったか（再計算の可否を判断する材料）。 */
  readonly appVersion?: string;
}

export interface RegistrationDocument {
  readonly version: number;
  readonly records: RegistrationRecord[];
}

// ── 指紋 ─────────────────────────────────────────────────────────────────

/** 数値を丸めて文字列化する（浮動小数の最下位ビットで指紋が変わらないように）。 */
function q(v: number | undefined | null, digits = 4): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return v.toFixed(digits);
}

/**
 * FNV-1a（64bit 相当を 2 本の 32bit で）。
 *
 * <p>暗号強度は要らない（改竄検出ではなく取り違え検出）。`crypto.subtle` は非同期で
 * 呼び出し側の形を縛るうえ、Worker からも使いたいので、同期の純関数にしてある。
 */
function hash(text: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/**
 * シリーズの指紋。
 *
 * <p>**UID だけでは足りない**。同じ UID で中身が入れ替わっている場合を検出したいので、
 * 幾何（枚数・画素寸法・IOP・端の IPP）まで含める。逆に、W/L や患者名のような
 * **変換の正しさに関係しない属性は含めない**（含めると、無害な編集で復元が拒否される）。
 */
export function seriesFingerprint(input: SeriesFingerprintInput): string {
  const parts = [
    input.seriesInstanceUid,
    `n=${input.sliceCount}`,
    `wh=${input.imageWidth}x${input.imageHeight}`,
    `ps=${q(input.pixelSpacingCol)},${q(input.pixelSpacingRow)}`,
    `iop=${input.iop.map((v) => q(v, 6)).join(",")}`,
    `ipp0=${(input.firstIpp ?? []).map((v) => q(v, 3)).join(",")}`,
    `ippN=${(input.lastIpp ?? []).map((v) => q(v, 3)).join(",")}`,
  ];
  return hash(parts.join("|"));
}

// ── 照合 ─────────────────────────────────────────────────────────────────

export type RestoreCheck =
  | { readonly status: "ok"; readonly record: RegistrationRecord }
  /** 記録はあるが入力が変わっている。**適用してはいけない**。 */
  | { readonly status: "stale"; readonly record: RegistrationRecord; readonly changed: ("fixed" | "moving")[] }
  | { readonly status: "none" };

/**
 * この fixed/moving の組に対する記録を探し、指紋を照合する。
 *
 * <p>同じ組の記録が複数あれば**最も新しいもの**を採る。
 */
export function findRecord(
  doc: RegistrationDocument | null | undefined,
  fixed: SeriesRef,
  moving: SeriesRef,
): RestoreCheck {
  const candidates = (doc?.records ?? []).filter(
    (r) => r.fixed.seriesInstanceUid === fixed.seriesInstanceUid
      && r.moving.seriesInstanceUid === moving.seriesInstanceUid
      && r.fixed.c === fixed.c && r.fixed.t === fixed.t
      && r.moving.c === moving.c && r.moving.t === moving.t,
  );
  if (candidates.length === 0) return { status: "none" };

  const record = candidates.reduce((a, b) => (a.savedAt >= b.savedAt ? a : b));
  const changed: ("fixed" | "moving")[] = [];
  if (record.fixed.fingerprint !== fixed.fingerprint) changed.push("fixed");
  if (record.moving.fingerprint !== moving.fingerprint) changed.push("moving");
  return changed.length > 0 ? { status: "stale", record, changed } : { status: "ok", record };
}

/** 記録を差し替えて（同じ組があれば置換して）新しい文書を返す。 */
export function upsertRecord(
  doc: RegistrationDocument | null | undefined,
  record: RegistrationRecord,
): RegistrationDocument {
  const rest = (doc?.records ?? []).filter(
    (r) => !(r.fixed.seriesInstanceUid === record.fixed.seriesInstanceUid
      && r.moving.seriesInstanceUid === record.moving.seriesInstanceUid
      && r.fixed.c === record.fixed.c && r.fixed.t === record.fixed.t
      && r.moving.c === record.moving.c && r.moving.t === record.moving.t),
  );
  return { version: REGISTRATION_RECORD_VERSION, records: [...rest, record] };
}

/** 同じ組の記録を消す。 */
export function removeRecord(
  doc: RegistrationDocument | null | undefined,
  fixed: SeriesRef,
  moving: SeriesRef,
): RegistrationDocument {
  const rest = (doc?.records ?? []).filter(
    (r) => !(r.fixed.seriesInstanceUid === fixed.seriesInstanceUid
      && r.moving.seriesInstanceUid === moving.seriesInstanceUid
      && r.fixed.c === fixed.c && r.fixed.t === fixed.t
      && r.moving.c === moving.c && r.moving.t === moving.t),
  );
  return { version: REGISTRATION_RECORD_VERSION, records: rest };
}

// ── 変位場の直列化 ───────────────────────────────────────────────────────

/**
 * 変位場は `Float32Array` なので JSON にそのまま載らない。
 *
 * <p>数値配列にすると桁数で肥大するので **Base64** にする。制御格子は粗い
 * （既定 12mm）ので、頭部で数十 KB、全身でも数百 KB に収まる。
 */
export function encodeFloat32(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = "";
  const chunk = 0x8000; // 引数の数に上限があるので分割する
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function decodeFloat32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/**
 * `SeriesLayoutDto` 相当の情報から指紋の材料を作る。
 *
 * <p>`SeriesLayoutDto` そのものを引数に取らないのは、この module を
 * **cornerstone にも api にも依存させない**ため（node の vitest から読める状態を保つ）。
 * 呼び出し側が必要な項目だけを抜き出して渡す。
 */
export function fingerprintFromLayout(
  seriesInstanceUid: string,
  layout: {
    nZ: number;
    imageWidth: number;
    imageHeight: number;
    pixelSpacingCol: number;
    pixelSpacingRow: number;
    imageOrientationPatient: readonly number[] | null;
    zSpatial: readonly { imagePositionPatient: readonly number[] }[] | null;
  },
): string {
  const z = layout.zSpatial ?? [];
  return seriesFingerprint({
    seriesInstanceUid,
    sliceCount: layout.nZ,
    imageWidth: layout.imageWidth,
    imageHeight: layout.imageHeight,
    pixelSpacingCol: layout.pixelSpacingCol,
    pixelSpacingRow: layout.pixelSpacingRow,
    iop: layout.imageOrientationPatient ?? [],
    firstIpp: z.length > 0 ? z[0].imagePositionPatient : null,
    lastIpp: z.length > 0 ? z[z.length - 1].imagePositionPatient : null,
  });
}
