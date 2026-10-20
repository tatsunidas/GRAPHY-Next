/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// タグの編集の API（standalone）。決まりに合わない編集は 400 で行ごとの理由が返るので、共通の http ラッパ
// （本文をメッセージ 1 つにまとめる）ではなく、ここで本文を読む。
import { apiBase } from "../apiBase";
import { extractErrorMessage, HttpError } from "../http";

export interface TagEditScope {
  level: "instance" | "series" | "study";
  studyUid: string;
  seriesUid?: string;
  sopUid?: string;
}

export interface TagEdit {
  /** "(gggg,eeee)" かキーワード。 */
  tag: string;
  /** プライベートタグのときだけ要る（標準のタグは辞書の VR を使う）。 */
  vr?: string;
  op: "set" | "remove";
  /** 画面に見えていた値（確認で「異なる画像の数」を数える）。 */
  before?: string;
  value?: string;
}

export interface TagEditProblem {
  /** edits の何番目か（-1 は全体）。 */
  index: number;
  tag: string;
  reason: string;
}

export interface TagEditPreview {
  files: number;
  unreadable: number;
  items: { tag: string; differing: number }[];
}

export interface TagEditResult {
  updatedFiles: number;
  indexColumns: string[];
}

/** 決まりに合わない（400）。何も書かれていない。 */
export class TagEditInvalid extends Error {
  constructor(readonly problems: TagEditProblem[]) {
    super("invalid-tag-edit");
    this.name = "TagEditInvalid";
  }
}

async function post<T>(path: string, scope: TagEditScope, edits: TagEdit[]): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope, edits }),
  });
  if (res.status === 400) {
    const body = await res.clone().json().catch(() => null);
    if (body && body.error === "invalid-tag-edit" && Array.isArray(body.problems)) {
      throw new TagEditInvalid(body.problems as TagEditProblem[]);
    }
  }
  if (!res.ok) throw new HttpError(await extractErrorMessage(res), res.status);
  return (await res.json()) as T;
}

export const previewTagEdit = (scope: TagEditScope, edits: TagEdit[]) =>
  post<TagEditPreview>("/api/dbadmin/tags/preview", scope, edits);

export const applyTagEdit = (scope: TagEditScope, edits: TagEdit[]) =>
  post<TagEditResult>("/api/dbadmin/tags/apply", scope, edits);
