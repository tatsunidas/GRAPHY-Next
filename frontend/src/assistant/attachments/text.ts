/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { AttachError } from "./limits";

/** UTF-8 のテキスト。BOM は除く。UTF-8 として不正なバイト列（Shift_JIS など）は断る（文字化けを黙って渡さない）。 */
export function decodeText(buf: ArrayBuffer): string {
  let s: string;
  try {
    s = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new AttachError("unsupported");
  }
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  if (!s.trim()) throw new AttachError("empty");
  return s;
}
