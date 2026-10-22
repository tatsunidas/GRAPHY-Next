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
import { chatReducer, initialChatState, type UiAction, type UiImage, type UiMessage } from "./chatState";
import { buildTools } from "./actions/registry";
import { runToolLoop } from "./toolLoop";
import { DOC_CHUNKS } from "./docsBundle";
import { searchDocs } from "./docsIndex";
import { buildSystemPrompt } from "./systemPrompt";
import { AttachError, MAX_ATTACHMENTS, classify } from "./attachments/limits";
import { composeUserText, ingest, type Attachment, type IngestDeps } from "./attachments";
import { loadPdfjs } from "./attachments/pdfLoader";
import { extractVideoFrames } from "./attachments/video";
import { MAX_RECORD_SEC } from "./voice/voiceFlow";
import { useVoiceInput } from "./voice/useVoiceInput";

const INGEST_DEPS: IngestDeps = { loadPdfjs, extractVideo: extractVideoFrames };

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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [ingesting, setIngesting] = useState(0);
  const [askConfirm, setAskConfirm] = useState(false);
  const confirmedRef = useRef(false);
  const [note, setNote] = useState<string | null>(null);
  const [resolved, setResolved] = useState<AiResolveResult | null>(null);
  const sessionId = useMemo(newSessionId, []);
  const bufRef = useRef("");
  const timerRef = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortedRef = useRef(false);

  const bridge = desktop();
  const available = !!bridge?.aiChat;
  const voice = useVoiceInput({ t, setInput, setNote });

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
      let imgCount = images.length;
      let attCount = attachments.length;
      for (const f of files) {
        if (classify(f.name, f.type) === "image") {
          if (imgCount >= MAX_IMAGES) {
            setNote(t("assistant.tooManyImages", { n: MAX_IMAGES }));
            continue;
          }
          const r = await readImage(f);
          if ("error" in r) {
            setNote(t(`assistant.image.${r.error}`));
            continue;
          }
          imgCount++;
          setImages((cur) => (cur.length >= MAX_IMAGES ? cur : [...cur, r]));
          continue;
        }
        if (attCount >= MAX_ATTACHMENTS) {
          setNote(t("assistant.attach.tooMany", { n: MAX_ATTACHMENTS }));
          return;
        }
        attCount++;
        setIngesting((n) => n + 1);
        try {
          const a = await ingest(f, INGEST_DEPS);
          setAttachments((cur) => [...cur, a]);
        } catch (e) {
          attCount--;
          setNote(`${f.name}: ${t(`assistant.attach.err.${e instanceof AttachError ? e.code : "read"}`)}`);
        } finally {
          setIngesting((n) => n - 1);
        }
      }
    },
    [images.length, attachments.length, t],
  );

  const send = useCallback(async () => {
    const typed = input.trim();
    if ((!typed && !attachments.length) || ingesting > 0 || state.pending !== null || !bridge?.aiChat) return;
    // 添付の内容は宛先へ出ていく。この PC の外へ出るときは、会話ごとに最初の 1 回だけ確認する。
    if (attachments.length && resolved?.ok && !resolved.local && !confirmedRef.current) {
      setAskConfirm(true);
      return;
    }
    setAskConfirm(false);
    const text = typed || t("assistant.attach.defaultAsk");
    const composed = composeUserText(text, attachments, resolved?.ok === true && resolved.local === true);
    const frameImages = attachments.flatMap((a) => a.images);
    const allImages = [...images, ...frameImages];
    const hits = searchDocs(DOC_CHUNKS, text, { k: DOCS_K, maxChars: DOCS_MAX_CHARS, minScore: DOCS_MIN_SCORE });
    // 過去の画像は履歴に載せない（会話が長くなるほど本文上限に近づくため）。今回の添付だけ送る。
    const history: AiChatMessage[] = state.messages
      .filter((m) => !m.error && !m.canceled && m.text)
      .map((m) => ({ role: m.role, text: m.text }));
    // ツールを送るのは、使える口があり、提供元がツール呼び出しに対応するとき（toolMode:none は案内のみ）。
    const canOperate = !!bridge.assistantViewerCmd && !!resolved?.ok && resolved.toolMode !== "none";
    const req: AiChatMessage[] = [
      { role: "system", text: buildSystemPrompt(locale, hits, { canOperate }) },
      ...history,
      { role: "user", text: composed.text, images: allImages.length ? allImages.map((i) => ({ base64: i.base64, mimeType: i.mimeType })) : undefined },
    ];
    const shown = attachments.length ? `${attachments.map((a) => `📎 ${a.name}`).join("\n")}\n${text}` : text;
    dispatch({ type: "send", text: shown, images: allImages, sources: hits.map((h) => ({ file: h.file, heading: h.heading })) });
    setInput("");
    setImages([]);
    setAttachments([]);
    setNote(composed.truncated ? t("assistant.attach.truncated") : null);
    abortedRef.current = false;
    const viewer = (cmd: { kind: "action" | "getState"; id?: string; params?: unknown }) =>
      bridge.assistantViewerCmd!(sessionId, cmd);
    const result = await runToolLoop(req, canOperate ? buildTools() : [], {
      chat: (messages, tools) => bridge.aiChat!({ sessionId, messages, tools: tools.length ? tools : undefined, stream: true }),
      viewer,
      onAction: (action) => dispatch({ type: "actionAdd", action }),
      onActionUpdate: (id, patch) => dispatch({ type: "actionUpdate", id, patch }),
      onProposal: (proposal) => dispatch({ type: "proposalAdd", proposal }),
      onRoundDone: (roundText) => {
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        flush();
        dispatch({ type: "roundDone", text: roundText });
      },
      aborted: () => abortedRef.current,
    });
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      flush();
    }
    dispatch({ type: "done", result });
  }, [input, images, attachments, ingesting, resolved, t, state.pending, state.messages, bridge, locale, sessionId, flush]);

  const stop = useCallback(() => {
    abortedRef.current = true;
    void bridge?.aiChatCancel?.(sessionId);
  }, [bridge, sessionId]);

  /** 実行時に 2D 窓が返した逆操作を、同じ口（main 中継・再検証つき）で実行して元に戻す。 */
  const undoAction = useCallback(
    async (a: UiAction) => {
      if (!a.inverse?.length || !bridge?.assistantViewerCmd) return;
      for (const step of a.inverse) {
        const r = await bridge.assistantViewerCmd(sessionId, { kind: "action", id: step.id, params: step.params });
        if (!r.ok) {
          dispatch({ type: "actionUpdate", id: a.id, patch: { error: r.error } });
          return;
        }
      }
      dispatch({ type: "actionUpdate", id: a.id, patch: { status: "undone", error: undefined } });
    },
    [bridge, sessionId],
  );

  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
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
          state.messages.map((m) => <Bubble key={m.id} m={m} t={t} onUndo={undoAction} busy={busy} />)
        )}
      </div>

      {note && <div style={S.note}>{note}</div>}
      {attachments.length > 0 && !(resolved?.ok && resolved.local) && (
        <div style={S.note} data-testid="assistant-attach-dest">
          {t("assistant.attach.dest", { host: resolved?.ok ? resolved.endpointHost : "?" })}
        </div>
      )}
      {askConfirm && (
        <div style={S.confirm} data-testid="assistant-attach-confirm">
          <span>{t("assistant.attach.confirm", { host: resolved?.ok ? resolved.endpointHost : "?" })}</span>
          <button
            style={S.btnPrimary}
            data-testid="assistant-attach-confirm-yes"
            onClick={() => {
              confirmedRef.current = true;
              void send();
            }}
          >
            {t("assistant.attach.confirmYes")}
          </button>
          <button style={S.btn} onClick={() => setAskConfirm(false)}>
            {t("assistant.attach.confirmNo")}
          </button>
        </div>
      )}
      {(attachments.length > 0 || ingesting > 0) && (
        <div style={S.thumbs} data-testid="assistant-attachments">
          {attachments.map((a) => (
            <span key={a.id} style={S.chip} data-testid="assistant-attach-chip">
              📎 {a.name}（{a.kind}・{t("assistant.attach.chars", { n: a.totalChars })}
              {a.images.length ? `・${t("assistant.attach.frames", { n: a.images.length })}` : ""}）
              {a.identifiers && (
                <span style={S.warnInline} data-testid="assistant-attach-phi" title={t("assistant.attach.phiHelp")}>
                  ⚠ {t("assistant.attach.phi")}
                </span>
              )}
              <button style={S.chipX} onClick={() => setAttachments((cur) => cur.filter((x) => x.id !== a.id))} aria-label={t("assistant.attach.remove")}>
                ×
              </button>
            </span>
          ))}
          {ingesting > 0 && <span style={S.dim}>{t("assistant.attach.reading")}</span>}
        </div>
      )}
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
      {voice.available && (
        <div style={S.voiceRow} data-testid="assistant-voice-status">
          {voice.phase === "confirm" && voice.readiness.kind === "ready" ? (
            <span style={S.confirm} data-testid="assistant-voice-confirm">
              <span>{t("assistant.voice.confirm", { host: voice.readiness.host })}</span>
              <button style={S.btnPrimary} onClick={() => void voice.answerConfirm(true)} data-testid="assistant-voice-confirm-yes">
                {t("assistant.voice.confirmYes")}
              </button>
              <button style={S.btn} onClick={() => void voice.answerConfirm(false)} data-testid="assistant-voice-confirm-no">
                {t("assistant.voice.confirmNo")}
              </button>
            </span>
          ) : voice.phase === "recording" ? (
            <span style={S.recording} data-testid="assistant-voice-recording">
              ● {t("assistant.voice.recording", { sec: voice.elapsed, max: MAX_RECORD_SEC })}
            </span>
          ) : voice.phase === "transcribing" ? (
            <span style={S.dim} data-testid="assistant-voice-transcribing">{t("assistant.voice.transcribing")}</span>
          ) : voice.readiness.kind === "ready" ? (
            <span style={S.dim} data-testid="assistant-voice-dest">
              🎙 {voice.readiness.local ? t("assistant.voice.destLocal") : t("assistant.voice.dest", { host: voice.readiness.host })}
            </span>
          ) : (
            <span style={S.dim} data-testid="assistant-voice-unavailable">
              🎙 {voice.readiness.kind === "noKey" ? t("assistant.voice.notReady", { label: voice.readiness.label }) : t("assistant.voice.noProvider")}
            </span>
          )}
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
          accept="image/*,video/*,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.tsv,.json,.log,.xml,.yaml,.yml,.ini"
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
          {voice.available && (voice.phase === "recording" || voice.phase === "transcribing") ? (
            <>
              {voice.phase === "recording" && (
                <button style={S.btnRec} onClick={() => void voice.toggle()} data-testid="assistant-voice-stop">
                  ■ {t("assistant.voice.stop")}
                </button>
              )}
              <button style={S.btn} onClick={voice.cancel} data-testid="assistant-voice-cancel">
                {t("assistant.voice.cancel")}
              </button>
            </>
          ) : voice.available ? (
            <button
              style={S.btn}
              disabled={notReady || busy || voice.phase === "confirm" || voice.readiness.kind !== "ready"}
              onClick={() => void voice.toggle()}
              title={t("assistant.voice.start")}
              aria-label={t("assistant.voice.start")}
              data-testid="assistant-voice"
            >
              🎙 {t("assistant.voice.start")}
            </button>
          ) : null}
          {busy ? (
            <button style={S.btn} onClick={stop} data-testid="assistant-stop">
              {t("assistant.stop")}
            </button>
          ) : (
            <button style={S.btnPrimary} disabled={notReady || ingesting > 0 || (!input.trim() && !attachments.length)} onClick={() => void send()} data-testid="assistant-send">
              {t("assistant.send")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Bubble({
  m,
  t,
  onUndo,
  busy,
}: {
  m: UiMessage;
  t: (k: string, v?: Record<string, string | number>) => string;
  onUndo: (a: UiAction) => void;
  busy: boolean;
}) {
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
        {m.actions?.map((a) => (
          <div key={a.id} style={S.card} data-testid={`assistant-action-${a.name}`} data-status={a.status}>
            <span>
              {t(`assistant.act.${a.name}`)}
              {a.params && Object.keys(a.params).length ? ` ${Object.entries(a.params).map(([k, v]) => `${k}=${String(v)}`).join(" ")}` : ""}
            </span>
            <span style={a.status === "failed" ? S.err : S.dim} data-testid="assistant-action-status">
              {t(`assistant.actionState.${a.status}`)}
              {a.error ? ` (${a.error})` : ""}
            </span>
            {a.status === "done" && a.inverse?.length ? (
              <button style={S.linkBtn} disabled={busy} onClick={() => onUndo(a)} data-testid="assistant-undo">
                {t("assistant.undo")}
              </button>
            ) : null}
          </div>
        ))}
        {m.proposals?.map((p) => (
          <div key={p.id} style={{ ...S.card, flexDirection: "column", alignItems: "flex-start", gap: 2 }} data-testid="assistant-proposal">
            <strong>{p.title}</strong>
            <div style={S.dim}>{t("assistant.proposalNote")}</div>
            <ol style={{ margin: "4px 0 0", paddingLeft: 20 }}>
              {p.steps.map((st, i) => (
                <li key={i}>{st}</li>
              ))}
            </ol>
          </div>
        ))}
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
  card: { marginTop: 6, padding: "6px 8px", border: "1px solid #3a3b3f", borderRadius: 6, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 12 },
  confirm: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "6px 12px", background: "#3b3320", fontSize: 12 },
  chip: { display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 8px", border: "1px solid #5f6368", borderRadius: 12, fontSize: 12 },
  chipX: { border: "none", background: "none", color: "inherit", cursor: "pointer", padding: 0 },
  warnInline: { color: "#fdd663" },
  note: { padding: "4px 12px", color: "#fdd663", fontSize: 12 },
  thumbs: { display: "flex", gap: 6, padding: "4px 12px", flexWrap: "wrap" },
  thumb: { position: "relative", display: "inline-block" },
  thumbImg: { height: 56, borderRadius: 6, display: "block" },
  x: { position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: 9, border: "none", cursor: "pointer", lineHeight: "16px", padding: 0 },
  inputRow: { display: "flex", gap: 8, padding: 12, borderTop: "1px solid #3a3b3f", alignItems: "stretch" },
  textarea: { flex: 1, minWidth: 0, resize: "none", background: "#2b2d31", color: "inherit", border: "1px solid #3a3b3f", borderRadius: 8, padding: 8, font: "inherit" },
  btnCol: { display: "flex", flexDirection: "column", gap: 6 },
  btn: { padding: "4px 10px", borderRadius: 6, border: "1px solid #5f6368", background: "transparent", color: "inherit", cursor: "pointer" },
  voiceRow: { padding: "2px 12px", fontSize: 12 },
  recording: { color: "#f28b82" },
  btnRec: { padding: "4px 10px", borderRadius: 6, border: "none", background: "#c5221f", color: "#fff", cursor: "pointer" },
  btnPrimary: { padding: "4px 10px", borderRadius: 6, border: "none", background: "#2f5fa8", color: "#fff", cursor: "pointer" },
};
