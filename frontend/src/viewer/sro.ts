/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * DICOM SRO（Spatial Registration Object）の読み書き（設計 `fw/registration-design.md` R5）。
 *
 * <h3>アプリ内保存との違い</h3>
 *
 * <p>アプリ内保存（{@link ./registrationPersistence}）は「開き直せば同じ絵」を担うが、
 * GRAPHY のデータ領域を消せば失われ、他システムからは読めない。SRO は
 * <b>患者記録の一部</b>として検査の中に入り、媒体にも PACS にも載る。**どちらか一方では
 * 足りない**ので両方を持つ。
 *
 * <h3>向きの規約 ★</h3>
 *
 * <p>GRAPHY 内部の変換は `q = T(p)`（fixed → moving の pull-back）だが、SRO の行列は
 * 「その項目の FoR を登録先 RCS へ写す」ものなので<b>逆行列</b>が書かれる。
 * 変換は backend（{@code SpatialRegistrationCodec}）が行い、**この層は内部の向きのまま
 * 受け渡す**。両側で反転すると二重に戻って気付きにくいので、反転箇所は 1 つに絞ってある。
 *
 * <h3>読み込みで失われるもの</h3>
 *
 * <p>SRO には<b>変換しか入らない</b>。どの類似度で・どのパラメータで・どれだけ時間をかけて
 * 求めたかは残らない。したがって SRO から復元した結果は、アプリ内保存から復元したものと
 * 同じ絵にはなるが、**レシピを持たない**。監査ややり直しにはアプリ内保存の方が要る。
 * 読み込んだ結果の `metric` に `"sro"` を入れているのは、この出自を画面と記録に残すため。
 */

import { apiBase } from "../apiBase";
import type { RegistrationResult } from "./regResult";

export interface SroDvf {
  dims: [number, number, number];
  originMm: [number, number, number];
  spacingMm: [number, number, number];
  displacementsMm: number[];
}

/** backend が返す SRO 1 件（`SpatialRegistrationCodec.Parsed` に対応）。 */
export interface ParsedSro {
  sopInstanceUid: string;
  sopClassUid: string;
  seriesInstanceUid: string;
  contentLabel: string | null;
  contentDescription: string | null;
  contentDate: string | null;
  contentTime: string | null;
  fixedFrameOfReferenceUid: string;
  movingFrameOfReferenceUid: string;
  /** **内部の向き**（fixed → moving）。backend が逆行列から戻したもの。 */
  fixedToMoving: number[];
  deformable: boolean;
  dvf: SroDvf | null;
}

export interface CreateSroRequest {
  studyInstanceUid: string;
  /** 患者・検査属性の引き継ぎ元。SRO は fixed 側の検査に入る。 */
  fixedSeriesInstanceUid: string;
  fixedFrameOfReferenceUid: string;
  movingFrameOfReferenceUid: string;
  fixedToMoving: number[];
  dvf: SroDvf | null;
  contentLabel: string | null;
  contentDescription: string | null;
}

export interface CreateSroResult {
  sopInstanceUid: string;
  seriesInstanceUid: string;
  deformable: boolean;
}

async function failure(res: Response): Promise<string> {
  // backend は理由を本文に入れる（FoR が無い・同じ FoR どうし等）。握り潰すと
  // 利用者には「保存できません」としか見えず、直しようがなくなる。
  try {
    const body = (await res.json()) as { message?: string; detail?: string; error?: string };
    return body.message || body.detail || body.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export async function createSro(req: CreateSroRequest): Promise<CreateSroResult> {
  const res = await fetch(`${apiBase()}/api/sro`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(await failure(res));
  return (await res.json()) as CreateSroResult;
}

/** 検査の中の SRO を列挙する。読めない 1 件があっても残りは返る（backend 側の方針）。 */
export async function listSro(studyInstanceUid: string): Promise<ParsedSro[]> {
  const url = `${apiBase()}/api/sro?studyInstanceUid=${encodeURIComponent(studyInstanceUid)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(await failure(res));
  return (await res.json()) as ParsedSro[];
}

/** 現在の結果から SRO の生成要求を組み立てる。変換の向きはそのまま渡す。 */
export function sroRequestFromResult(
  result: RegistrationResult,
  ctx: {
    studyInstanceUid: string;
    fixedSeriesInstanceUid: string;
    fixedFrameOfReferenceUid: string;
    movingFrameOfReferenceUid: string;
    contentLabel: string | null;
    contentDescription: string | null;
  },
): CreateSroRequest {
  return {
    ...ctx,
    fixedToMoving: [...result.matrix],
    dvf: result.dvf
      ? {
          dims: result.dvf.dims,
          originMm: result.dvf.origin,
          spacingMm: result.dvf.spacing,
          // JSON には型付き配列が載らない。要素数は制御格子の 3 倍で、
          // 12mm 格子なら頭部で数万・全身でも数十万に収まる。
          displacementsMm: Array.from(result.dvf.displacements),
        }
      : null,
  };
}

/**
 * SRO を、表示に使える結果へ。
 *
 * <p>SRO に無い項目（回転中心・オイラー角・類似度・所要時間）は<b>作らない</b>。
 * `center` は `[0,0,0]` で構わない — 行列は絶対座標の 4×4 で、`linearTransform` の
 * `center` は表示用のメタデータに過ぎず、写像には使われないため。
 * ここで無理にオイラー角へ分解すると、**SRO に書かれていない情報を推定した値**が
 * 画面に出て、あたかも記録されていたかのように見えてしまう。
 */
export function sroToRegistrationResult(sro: ParsedSro): RegistrationResult {
  return {
    matrix: [...sro.fixedToMoving],
    center: [0, 0, 0],
    translationMm: [sro.fixedToMoving[3], sro.fixedToMoving[7], sro.fixedToMoving[11]],
    eulerDeg: [0, 0, 0],
    metric: "sro",
    metricValue: 0,
    elapsedMs: 0,
    sameFrameOfReference: sro.fixedFrameOfReferenceUid === sro.movingFrameOfReferenceUid,
    initialization: "sro",
    mode: sro.deformable ? "deformable" : "rigid",
    dvf: sro.dvf
      ? {
          displacements: Float32Array.from(sro.dvf.displacementsMm),
          dims: sro.dvf.dims,
          origin: sro.dvf.originMm,
          spacing: sro.dvf.spacingMm,
          // SRO は品質指標を持たない。0 埋めして「測った」ように見せない。
          jacobian: { min: NaN, max: NaN, negativeFraction: NaN },
          maxDisplacementMm: NaN,
        }
      : null,
  };
}

/**
 * 一覧に出す 1 行のラベル。
 *
 * <p>種別の文言は**呼び出し側から受け取る**。ここで "剛体" と直書きすると
 * 英語 UI に日本語が出る（i18n は ja/en 両方が要件）。
 */
export function sroLabel(sro: ParsedSro, kind: string): string {
  const when = sro.contentDate
    ? `${sro.contentDate.slice(0, 4)}-${sro.contentDate.slice(4, 6)}-${sro.contentDate.slice(6, 8)}`
    : "";
  const name = sro.contentDescription || sro.contentLabel || "";
  return [kind, when, name].filter(Boolean).join(" · ");
}
