/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// アシスタント窓（#assistant）。S1 は「答える・案内する」だけで、アプリは操作しない（tools は送らない）。
// 会話の口 aiChat は main が #assistant の窓にしか許さない（desktop/assistantSender.js）。
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { desktop, type AiChatMessage, type AiResolveResult } from "../desktopBridge";
import { useI18n } from "../i18n/i18n";
import { MarkdownPreviewBoundary } from "../report/MarkdownEditor";
import { chatReducer, initialChatState, type UiImage, type UiMessage } from "./chatState";
import { DOC_CHUNKS } from "./docsBundle";
import { searchDocs } from "./docsIndex";
import { buildSystemPrompt } from "./systemPrompt";

/** main の画像 1 枚の上限（desktop/aiGateway.js MAX_IMAGE_BYTES）と同じ。base64 文字数で数える。 */
const MAX_IMAGE_B64 = 8 * 1024 * 1024;
/** 1 メッセージの画像枚数。main の本文上限（20 MiB）に収めるための目安。 */
const MAX_IMAGES = 3;
/** 1 質問で添える資料の数と長さ。実測（assistantDocs.test.ts の質問例）で当たりが取れた最小に近い値。 */
const DOCS_K = 3;
const DOCS_MAX_CHARS = 1500;
const DOCS_MIN_SCORE = 2;
/** ストリーム表示の更新間隔。1 トークンごとに Markdown を組み直さない。 */
const FLUSH_MS = 80;

function newSessionId(): string {
  return `as-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readImage(file: File): Promise<UiImage | { error: "tooLarge" | "notImage" | "read" }> {
  if (!file.type.startsWith("image/")) return Promise.resolve({ error: "notImage" });
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onerror = () => resolve({ error: "read" });
    r.onload = () => {
      const url = String(r.result);
      const base64 = url.slice(url.indexOf(",") + 1);
      if (base64.length > MAX_IMAGE_B64) resolve({ error: "tooLarge" });
      else resolve({ base64, mimeType: file.type, url });
    };
    r.readAsDataURL(file);
  });
}

export function AssistantScreen() {
  const { t, locale } = useI18n();
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [input, setInput] = useState("");
  const [images, setImages] = useState<UiImage[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [resolved, setResolved] = useState<AiResolveResult | null>(null);
  const sessionId = useMemo(newSessionId, []);
  const bufRef = useRef("");
  const timerRef = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const bridge = desktop();
  const available = !!bridge?.aiChat;

  useEffect(() => {
    document.title = t("assistant.title");
  }, [t]);

  useEffect(() => {
    void bridge?.aiResolve?.("text-to-text").then(setResolved);
  }, [bridge]);

  const flush = useCallback(() => {
    timerRef.current = null;
    if (bufRef.current) {
      dispatch({ type: "delta", text: bufRef.current });
      bufRef.current = "";
    }
  }, []);

  useEffect(() => {
    const off = bridge?.onAiChatEvent?.((ev) => {
      if (ev.sessionId !== sessionId || ev.type !== "delta") return;
      bufRef.current += ev.text;
      if (timerRef.current === null) timerRef.current = window.setTimeout(flush, FLUSH_MS);
    });
    return () => {
      off?.();
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [bridge, sessionId, flush]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [state.messages]);

  const addFiles = useCallback(
    async (files: File[]) => {
      setNote(null);
      for (const f of files) {
        if (images.length >= MAX_IMAGES) {
          setNote(t("assistant.tooManyImages", { n: MAX_IMAGES }));
          return;
        }
        const r = await readImage(f);
        if ("error" in r) {
          setNote(t(`assistant.image.${r.error}`));
          continue;
        }
        setImages((cur) => (cur.length >= MAX_IMAGES ? cur : [...cur, r]));
      }
    },
    [images.length, t],
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || state.pending !== null || !bridge?.aiChat) return;
    const hits = searchDocs(DOC_CHUNKS, text, { k: DOCS_K, maxChars: DOCS_MAX_CHARS, minScore: DOCS_MIN_SCORE });
    // 過去の画像は履歴に載せない（会話が長くなるほど本文上限に近づくため）。今回の添付だけ送る。
    const history: AiChatMessage[] = state.messages
      .filter((m) => !m.error && !m.canceled && m.text)
      .map((m) => ({ role: m.role, text: m.text }));
    const req: AiChatMessage[] = [
      { role: "system", text: buildSystemPrompt(locale, hits) },
      ...history,
      { role: "user", text, images: images.length ? images.map((i) => ({ base64: i.base64, mimeType: i.mimeType })) : undefined },
    ];
    dispatch({ type: "send", text, images, sources: hits.map((h) => ({ file: h.file, heading: h.heading })) });
    setInput("");
    setImages([]);
    setNote(null);
    const result = await bridge.aiChat({ sessionId, messages: req, stream: true });
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      flush();
    }
    dispatch({ type: "done", result });
  }, [input, images, state.pending, state.messages, bridge, locale, sessionId, flush]);

  const stop = useCallback(() => {
    void bridge?.aiChatCancel?.(sessionId);
  }, [bridge, sessionId]);

  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    void addFiles(Array.from(e.dataTransfer.files));
  };

  // 用途が未設定、または鍵が要るのに鍵が無い提供元のときは送れない（送っても main が断る）。
  const notReady = !available || (resolved !== null && (!resolved.ok || !resolved.hasApiKey));
  const busy = state.pending !== null;

  return (
    <div style={S.root} onDragOver={(e) => e.preventDefault()} onDrop={onDrop} data-testid="assistant-root">
      <div style={S.header}>
        <strong>{t("assistant.title")}</strong>
        <span style={S.via} data-testid="assistant-via">
          {resolved?.ok ? `${resolved.label} · ${resolved.model}` : ""}
        </span>
        <button style={S.linkBtn} disabled={busy || !state.messages.length} onClick={() => dispatch({ type: "clear" })}>
          {t("assistant.clear")}
        </button>
      </div>

      <div ref={listRef} style={S.list} data-testid="assistant-list">
        {notReady ? (
          <div style={S.notice} data-testid="assistant-not-configured">
            {available ? t("assistant.notConfigured") : t("assistant.noDesktop")}
          </div>
        ) : !state.messages.length ? (
          <div style={S.hint}>{t("assistant.hint")}</div>
        ) : (
          state.messages.map((m) => <Bubble key={m.id} m={m} t={t} />)
        )}
      </div>

      {note && <div style={S.note}>{note}</div>}
      {images.length > 0 && (
        <div style={S.thumbs}>
          {images.map((im, i) => (
            <span key={i} style={S.thumb}>
              <img src={im.url} alt="" style={S.thumbImg} />
              <button style={S.x} onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))} aria-label={t("assistant.removeImage")}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={S.inputRow}>
        <textarea
          style={S.textarea}
          value={input}
          disabled={notReady}
          placeholder={t("assistant.placeholder")}
          rows={2}
          data-testid="assistant-input"
          onChange={(e) => setInput(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void addFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <div style={S.btnCol}>
          <button style={S.btn} disabled={notReady || busy} onClick={() => fileRef.current?.click()} data-testid="assistant-attach">
            {t("assistant.attach")}
          </button>
          {busy ? (
            <button style={S.btn} onClick={stop} data-testid="assistant-stop">
              {t("assistant.stop")}
            </button>
          ) : (
            <button style={S.btnPrimary} disabled={notReady || !input.trim()} onClick={() => void send()} data-testid="assistant-send">
              {t("assistant.send")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Bubble({ m, t }: { m: UiMessage; t: (k: string, v?: Record<string, string | number>) => string }) {
  const mine = m.role === "user";
  return (
    <div style={{ ...S.bubbleRow, justifyContent: mine ? "flex-end" : "flex-start" }}>
      <div style={{ ...S.bubble, ...(mine ? S.mine : S.theirs) }} data-testid={mine ? "assistant-msg-user" : "assistant-msg-bot"}>
        {m.images?.map((im, i) => <img key={i} src={im.url} alt="" style={S.msgImg} />)}
        {mine ? (
          <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
        ) : m.text ? (
          <div className="assistant-md">
            <style>{MD_CSS}</style>
            <MarkdownPreviewBoundary source={m.text}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
            </MarkdownPreviewBoundary>
          </div>
        ) : !m.error && !m.canceled ? (
          <span style={S.dim}>{t("assistant.thinking")}</span>
        ) : null}
        {m.canceled && <div style={S.dim}>{t("assistant.canceled")}</div>}
        {m.error && <div style={S.err}>{t("assistant.error", { error: m.error })}</div>}
        {m.droppedImages ? <div style={S.warn}>{t("assistant.dropped", { n: m.droppedImages })}</div> : null}
        {m.degraded && (
          <div style={S.warn} data-testid="assistant-degraded">
            {t("assistant.degraded", { from: m.provenance?.fallbackFrom ?? "" })}
          </div>
        )}
        {!mine && m.provenance && (
          <div style={S.meta}>
            {m.provenance.model} · {m.provenance.endpointHost}
            {m.provenance.plaintext ? ` · ${t("assistant.plaintext")}` : ""}
          </div>
        )}
        {!mine && m.sources && m.sources.length > 0 && (
          <div style={S.meta} data-testid="assistant-sources">
            {t("assistant.sources")}: {m.sources.map((s) => `${s.file} › ${s.heading}`).join(" / ")}
          </div>
        )}
      </div>
    </div>
  );
}

const MD_CSS = `
.assistant-md { line-height: 1.55; overflow-wrap: anywhere; }
.assistant-md p { margin: 0 0 8px; } .assistant-md ul, .assistant-md ol { margin: 0 0 8px; padding-left: 22px; }
.assistant-md pre { background: rgba(127,127,127,.15); padding: 8px; border-radius: 6px; overflow-x: auto; }
.assistant-md code { background: rgba(127,127,127,.15); padding: 1px 4px; border-radius: 4px; }
.assistant-md table { border-collapse: collapse; } .assistant-md th, .assistant-md td { border: 1px solid rgba(127,127,127,.4); padding: 3px 6px; }
`;

const S: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", height: "100vh", boxSizing: "border-box", font: "14px system-ui, sans-serif", background: "#1e1f22", color: "#e6e6e6" },
  header: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid #3a3b3f", flexWrap: "wrap" },
  via: { flex: 1, minWidth: 0, fontSize: 12, color: "#9aa0a6", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  linkBtn: { background: "none", border: "none", color: "#8ab4f8", cursor: "pointer", fontSize: 12 },
  list: { flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 10 },
  hint: { color: "#9aa0a6", margin: "auto", textAlign: "center", whiteSpace: "pre-wrap" },
  notice: { margin: "auto", padding: 16, border: "1px solid #5f6368", borderRadius: 8, maxWidth: 380, whiteSpace: "pre-wrap" },
  bubbleRow: { display: "flex" },
  bubble: { maxWidth: "88%", padding: "8px 10px", borderRadius: 10, minWidth: 0 },
  mine: { background: "#2f5fa8" },
  theirs: { background: "#2b2d31", border: "1px solid #3a3b3f" },
  msgImg: { maxWidth: "100%", maxHeight: 160, borderRadius: 6, display: "block", marginBottom: 6 },
  meta: { marginTop: 6, fontSize: 11, color: "#9aa0a6", overflowWrap: "anywhere" },
  dim: { color: "#9aa0a6" },
  err: { marginTop: 6, color: "#f28b82", overflowWrap: "anywhere" },
  warn: { marginTop: 6, color: "#fdd663", fontSize: 12 },
  note: { padding: "4px 12px", color: "#fdd663", fontSize: 12 },
  thumbs: { display: "flex", gap: 6, padding: "4px 12px", flexWrap: "wrap" },
  thumb: { position: "relative", display: "inline-block" },
  thumbImg: { height: 56, borderRadius: 6, display: "block" },
  x: { position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: 9, border: "none", cursor: "pointer", lineHeight: "16px", padding: 0 },
  inputRow: { display: "flex", gap: 8, padding: 12, borderTop: "1px solid #3a3b3f", alignItems: "stretch" },
  textarea: { flex: 1, minWidth: 0, resize: "none", background: "#2b2d31", color: "inherit", border: "1px solid #3a3b3f", borderRadius: 8, padding: 8, font: "inherit" },
  btnCol: { display: "flex", flexDirection: "column", gap: 6 },
  btn: { padding: "4px 10px", borderRadius: 6, border: "1px solid #5f6368", background: "transparent", color: "inherit", cursor: "pointer" },
  btnPrimary: { padding: "4px 10px", borderRadius: 6, border: "none", background: "#2f5fa8", color: "#fff", cursor: "pointer" },
};
