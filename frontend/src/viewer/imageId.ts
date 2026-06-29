/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { apiBase } from "../apiBase";

export type ViewerMode = "standalone" | "web";

/**
 * SOP インスタンスから Cornerstone3D の imageId を組み立てる。
 * - standalone: backend の Part-10 配信を wadouri で読む（`/api/instances/{sop}/file`）。
 * - web: WADO-RS（wadors）経由。次フェーズで実装するため、ここでは呼び出さない。
 */
export function imageIdForInstance(mode: ViewerMode, sopUid: string): string {
  if (mode === "standalone") {
    return `wadouri:${apiBase()}/api/instances/${encodeURIComponent(sopUid)}/file`;
  }
  throw new Error("web mode の 2D ビューアは次フェーズで実装します");
}
