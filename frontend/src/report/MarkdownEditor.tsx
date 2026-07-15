/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "../i18n/i18n";

/** プレビュー再描画のデバウンス間隔(ms)。入力のたびに毎回パースし直すと、深いネスト箇条書き等の
 * 病的な Markdown で remark のパース時間が入力サイズに対し急激に悪化し（O(n^2)超）、キー入力ごとに
 * メインスレッドが長時間ブロックされてタブが「応答なし」になる（fw report bug: 記入中に強制終了）。
 * 入力を止めてからまとめて 1 回だけパースすることで、通常のタイピングでは毎回のブロックを避ける。 */
const PREVIEW_DEBOUNCE_MS = 400;

/**
 * Markdown プレビューの描画例外を本文入力から隔離する。アプリ全体を覆う {@link ErrorBoundary}
 * だけだと、プレビュー側の例外で入力中の本文ごと画面全体がクラッシュ表示に置き換わってしまうため、
 * ここでプレビュー欄だけに閉じ込める。{@code source} が変われば次の描画で自動的に再試行する。
 */
class MarkdownPreviewBoundary extends Component<
  { source: string; children: ReactNode },
  { error: Error | null; lastSource: string }
> {
  state = { error: null as Error | null, lastSource: this.props.source };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(
    props: { source: string },
    state: { error: Error | null; lastSource: string },
  ) {
    if (props.source !== state.lastSource) {
      return { error: null, lastSource: props.source };
    }
    return null;
  }

  render() {
    if (this.state.error) {
      return <div style={{ color: "#888", fontSize: 12 }}>プレビューを表示できませんでした</div>;
    }
    return this.props.children;
  }
}

/**
 * レポート本文の Markdown エディタ。左: ソース(textarea)＋書式ツールバー、右: ライブプレビュー
 * （`react-markdown`+`remark-gfm`）。旧 GRAPHY `MarkdownEditorPanel` の split-pane 構成を踏襲
 * （`fw/report-design.md` §5）。
 */
export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  readOnly,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  readOnly?: boolean;
}) {
  const { t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // プレビューは入力から切り離してデバウンスする（理由は PREVIEW_DEBOUNCE_MS のコメント参照）。
  const [previewSource, setPreviewSource] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setPreviewSource(value), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [value]);

  /** 選択範囲を before/after で囲む（例: 太字 `**text**`）。 */
  const wrapSelection = (before: string, after: string = before) => {
    const el = textareaRef.current;
    if (!el || readOnly) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = value.slice(start, end);
    const next = value.slice(0, start) + before + selected + after + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = start + before.length;
      el.selectionEnd = start + before.length + selected.length;
    });
  };

  /** 選択範囲を含む行群の先頭に prefix を付ける（見出し/箇条書き/引用）。 */
  const prefixLines = (prefix: string) => {
    const el = textareaRef.current;
    if (!el || readOnly) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const nextNl = value.indexOf("\n", end);
    const lineEnd = nextNl === -1 ? value.length : nextNl;
    const block = value.slice(lineStart, lineEnd);
    const withPrefix = block
      .split("\n")
      .map((l) => prefix + l)
      .join("\n");
    const next = value.slice(0, lineStart) + withPrefix + value.slice(lineEnd);
    onChange(next);
    requestAnimationFrame(() => el.focus());
  };

  const insertHr = () => {
    const el = textareaRef.current;
    if (!el || readOnly) return;
    const pos = el.selectionStart;
    const next = value.slice(0, pos) + "\n\n---\n\n" + value.slice(pos);
    onChange(next);
    requestAnimationFrame(() => el.focus());
  };

  return (
    <div style={wrap}>
      {!readOnly && (
        <div style={toolbar}>
          <ToolBtn label="H1" title={t("report.md.h1")} onClick={() => prefixLines("# ")} />
          <ToolBtn label="H2" title={t("report.md.h2")} onClick={() => prefixLines("## ")} />
          <ToolBtn label="H3" title={t("report.md.h3")} onClick={() => prefixLines("### ")} />
          <span style={sep} />
          <ToolBtn label="B" title={t("report.md.bold")} onClick={() => wrapSelection("**")} bold />
          <ToolBtn label="I" title={t("report.md.italic")} onClick={() => wrapSelection("*")} italic />
          <ToolBtn label="S" title={t("report.md.strike")} onClick={() => wrapSelection("~~")} />
          <span style={sep} />
          <ToolBtn label="•" title={t("report.md.ul")} onClick={() => prefixLines("- ")} />
          <ToolBtn label="1." title={t("report.md.ol")} onClick={() => prefixLines("1. ")} />
          <ToolBtn label="❝" title={t("report.md.quote")} onClick={() => prefixLines("> ")} />
          <ToolBtn label="</>" title={t("report.md.code")} onClick={() => wrapSelection("`")} />
          <ToolBtn label="―" title={t("report.md.hr")} onClick={insertHr} />
        </div>
      )}
      <div style={panes}>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          readOnly={readOnly}
          style={textareaStyle}
        />
        <div style={previewPane}>
          <MarkdownPreviewBoundary source={previewSource}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{previewSource || ""}</ReactMarkdown>
          </MarkdownPreviewBoundary>
        </div>
      </div>
    </div>
  );
}

function ToolBtn({
  label,
  title,
  onClick,
  bold,
  italic,
}: {
  label: string;
  title: string;
  onClick: () => void;
  bold?: boolean;
  italic?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{ ...toolBtn, fontWeight: bold ? 700 : 400, fontStyle: italic ? "italic" : "normal" }}
    >
      {label}
    </button>
  );
}

const wrap: React.CSSProperties = { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 };
const toolbar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 6px",
  border: "1px solid #dde3ea",
  borderBottom: "none",
  borderRadius: "6px 6px 0 0",
  background: "#f7f9fb",
};
const sep: React.CSSProperties = { width: 1, alignSelf: "stretch", background: "#dde4ea", margin: "0 4px" };
const toolBtn: React.CSSProperties = {
  minWidth: 26,
  padding: "3px 6px",
  border: "1px solid #d7dde3",
  borderRadius: 4,
  background: "#fff",
  cursor: "pointer",
  fontSize: 12,
};
const panes: React.CSSProperties = { display: "flex", flex: 1, minHeight: 0, gap: 0 };
const textareaStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  resize: "none",
  border: "1px solid #dde3ea",
  borderRight: "none",
  padding: 10,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 13,
  lineHeight: 1.5,
  outline: "none",
};
const previewPane: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "auto",
  border: "1px solid #dde3ea",
  borderRadius: "0 0 6px 0",
  padding: "10px 14px",
  background: "#fff",
  fontSize: 13,
  lineHeight: 1.6,
};
