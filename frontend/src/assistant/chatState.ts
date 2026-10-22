/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { AiChatResult, AiProvenance } from "../desktopBridge";

export interface UiImage {
  base64: string;
  mimeType: string;
  /** 表示用（`data:` URL）。 */
  url: string;
}

export interface UiSource {
  file: string;
  heading: string;
}

export interface UiMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  images?: UiImage[];
  /** assistant のみ。答えの根拠に添えた資料。 */
  sources?: UiSource[];
  provenance?: AiProvenance;
  degraded?: boolean;
  droppedImages?: number;
  /** 失敗・中止したターン。次の送信の履歴には載せない。 */
  error?: string;
  canceled?: boolean;
}

export interface ChatState {
  messages: UiMessage[];
  /** 応答を待っている assistant メッセージの id。無ければ送信可能。 */
  pending: number | null;
  nextId: number;
}

export const initialChatState: ChatState = { messages: [], pending: null, nextId: 1 };

export type ChatAction =
  | { type: "send"; text: string; images: UiImage[]; sources: UiSource[] }
  | { type: "delta"; text: string }
  | { type: "done"; result: AiChatResult }
  | { type: "cancel" }
  | { type: "clear" };

function patchPending(s: ChatState, f: (m: UiMessage) => UiMessage): ChatState {
  if (s.pending === null) return s;
  return { ...s, pending: null, messages: s.messages.map((m) => (m.id === s.pending ? f(m) : m)) };
}

export function chatReducer(s: ChatState, a: ChatAction): ChatState {
  switch (a.type) {
    case "send": {
      if (s.pending !== null) return s; // 二重送信は無視（main 側も busy を返す）
      const user: UiMessage = { id: s.nextId, role: "user", text: a.text, images: a.images.length ? a.images : undefined };
      const bot: UiMessage = { id: s.nextId + 1, role: "assistant", text: "", sources: a.sources.length ? a.sources : undefined };
      return { messages: [...s.messages, user, bot], pending: bot.id, nextId: s.nextId + 2 };
    }
    case "delta":
      if (s.pending === null) return s;
      return { ...s, messages: s.messages.map((m) => (m.id === s.pending ? { ...m, text: m.text + a.text } : m)) };
    case "done":
      return patchPending(s, (m) =>
        a.result.ok
          ? {
              ...m,
              // ストリームで溜めた本文と最終本文が食い違うときは最終を採る（非ストリームの提供元もある）
              text: a.result.text ?? m.text,
              provenance: a.result.provenance,
              degraded: a.result.degraded,
              droppedImages: a.result.droppedImages,
              ...(a.result.blockReason ? { error: `blocked: ${a.result.blockReason}` } : {}),
            }
          : a.result.error === "canceled"
            ? { ...m, canceled: true }
            : { ...m, error: a.result.error },
      );
    case "cancel":
      return patchPending(s, (m) => ({ ...m, canceled: true }));
    case "clear":
      return s.pending === null ? { ...initialChatState, nextId: s.nextId } : s;
  }
}
