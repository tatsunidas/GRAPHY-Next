/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * DB フォルダ間のコピー・移動（standalone のみ）。
 */
import { apiBase } from "../apiBase";
import { extractErrorMessage, httpGet, HttpError } from "../http";

export type TransferMode = "copy" | "move";

export interface TransferResult {
  id: string;
  mode: TransferMode;
  studies: number;
  files: number;
  bytes: number;
  sourceDeleted: boolean;
}

export interface InboxPackageResult {
  id: string;
  mode: TransferMode | null;
  sourceDbFolder: string | null;
  processedAt: string;
  imported: number;
  skippedExisting: number;
  failed: number;
  errors: string[];
  relatedInserted: number;
  relatedSame: number;
  conflicts: number;
}

export interface InboxStatus {
  running: boolean;
  results: InboxPackageResult[];
  stalePartials: string[];
}

/**
 * 大きな検査はコピーと照合に時間がかかるので、共通の 5 分の打ち切り（http.ts）ではなく 60 分にする。
 * 途中で打ち切ると、backend は続けているのに画面だけ失敗を出してしまう。
 */
const TRANSFER_TIMEOUT_MS = 60 * 60 * 1000;

export async function transferStudies(studyUids: string[], targetFolder: string, mode: TransferMode): Promise<TransferResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TRANSFER_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase()}/api/db-transfer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studyUids, targetFolder, mode }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new HttpError(await extractErrorMessage(res), res.status);
    return (await res.json()) as TransferResult;
  } finally {
    clearTimeout(timer);
  }
}

export const fetchInboxStatus = () => httpGet<InboxStatus>("/api/db-transfer/inbox");
