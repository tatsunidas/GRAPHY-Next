/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { splitDocs, type DocChunk } from "./docsIndex";

// ビルド時にユーザーマニュアル（docs/*.md）を同梱する。実行時に外部から取得しない。
const RAW = import.meta.glob("../../../docs/*.md", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

export const DOC_CHUNKS: DocChunk[] = splitDocs(RAW);
