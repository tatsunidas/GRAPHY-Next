/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { AiChatResult, AiProvenance } from "../desktopBridge";
import type { InverseStep } from "./actions/registry";

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

/** アシスタントが実行（または試みた）表示操作 1 件のカード。 */
export interface UiAction {
  /** モデルのツール呼び出し ID。 */
  id: string;
  name: string;
  params?: Record<string, unknown>;
  status: "running" | "done" | "failed" | "undone";
  error?: string;
  /** 実行時に 2D 窓が返した逆操作。無ければ元に戻せない。 */
  inverse?: InverseStep[];
}

/** データを変える作業の手順提案（実行はしない）。 */
export interface UiProposal {
  id: string;
  title: string;
  steps: string[];
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
  actions?: UiAction[];
  proposals?: UiProposal[];
  /** 直前までの往復で確定した本文の長さ（今のラウンドの差分はこの後ろに積む）。 */
  base?: number;
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
  | { type: "roundDone"; text?: string }
  | { type: "actionAdd"; action: UiAction }
  | { type: "actionUpdate"; id: string; patch: Partial<UiAction> }
  | { type: "proposalAdd"; proposal: UiProposal }
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
    case "roundDone": {
      // ツール呼び出しで終わったラウンド。最終本文があればそれで確定し、次のラウンドの差分はその後ろに積む。
      if (s.pending === null) return s;
      return {
        ...s,
        messages: s.messages.map((m) => {
          if (m.id !== s.pending) return m;
          const head = m.text.slice(0, m.base ?? 0);
          const round = a.text ?? m.text.slice(m.base ?? 0);
          const text = round ? `${head}${round}\n\n` : head;
          return { ...m, text, base: text.length };
        }),
      };
    }
    case "actionAdd":
      return s.pending === null ? s : { ...s, messages: s.messages.map((m) => (m.id === s.pending ? { ...m, actions: [...(m.actions ?? []), a.action] } : m)) };
    case "actionUpdate":
      return {
        ...s,
        messages: s.messages.map((m) =>
          m.actions?.some((x) => x.id === a.id) ? { ...m, actions: m.actions.map((x) => (x.id === a.id ? { ...x, ...a.patch } : x)) } : m,
        ),
      };
    case "proposalAdd":
      return s.pending === null ? s : { ...s, messages: s.messages.map((m) => (m.id === s.pending ? { ...m, proposals: [...(m.proposals ?? []), a.proposal] } : m)) };
    case "done":
      return patchPending(s, (m) =>
        a.result.ok
          ? {
              ...m,
              // ストリームで溜めた本文と最終本文が食い違うときは最終を採る（非ストリームの提供元もある）。
              // 前のラウンドで確定した本文（base まで）は残す。
              text: a.result.text !== undefined ? m.text.slice(0, m.base ?? 0) + a.result.text : m.text,
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
