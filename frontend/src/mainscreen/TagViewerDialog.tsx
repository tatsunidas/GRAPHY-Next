/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useMemo, useState } from "react";
import { fetchInstances, fetchInstanceTags, type Series, type Study, type TagDumpRow } from "../api";
import { emitDbChanged } from "../dbEvents";
import { HttpError } from "../http";
import { useI18n } from "../i18n/i18n";
import { applyTagEdit, previewTagEdit, TagEditInvalid, type TagEditPreview, type TagEditScope } from "./tagEditApi";
import { addedKey, affectsRouting, buildEdits, rowKey, rowLock, type AddedRow, type Built, type Draft } from "./tagEditModel";

/**
 * TagViewer: MainScreen で表示中の画像（＝選択中シリーズの代表インスタンス）の DICOM 属性ダンプを表示する。
 * GRAPHY の DicomTagsViewer を踏襲。
 *
 * - 列: Tag / Name / VR / Value。
 * - シーケンス(SQ)のネストは深さ分のインデント＋ `>` プレフィックスで表現。
 * - 検索バーで一致箇所をハイライト（フィルタはせず全行表示のまま）。
 * - `editable`（standalone）のとき「編集」で値の変更・削除・追加ができる。範囲（この画像／このシリーズ／このスタディ）の
 *   全ファイルを書き換える（backend の TagEditService。全か無か・変更の記録付き）。UID・画素・幾何・患者タグなどは鍵付きで変えない。
 *
 * 注: 現在のスライス番号は SeriesViewer 内部状態のため、ここでは<b>シリーズ先頭</b>の
 * インスタンスを対象にする（exact-slice 連動は将来課題）。「この画像」もその 1 枚。
 */
export function TagViewerDialog({
  open,
  onClose,
  study,
  series,
  editable = false,
}: {
  open: boolean;
  onClose: () => void;
  study: Study | null;
  series: Series | null;
  /** standalone のときだけ true（web は PACS の値を書き換えないので読むだけ）。 */
  editable?: boolean;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState<TagDumpRow[] | null>(null);
  const [sopUid, setSopUid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [added, setAdded] = useState<AddedRow[]>([]);
  const [scopeLevel, setScopeLevel] = useState<TagEditScope["level"]>("series");
  const [serverProblems, setServerProblems] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{ built: Built; preview: TagEditPreview; scope: TagEditScope } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNoticeState] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    if (!open || !study || !series) return;
    setRows(null);
    setError(null);
    setSopUid(null);
    if (reloadKey === 0) setQuery("");
    let cancelled = false;
    (async () => {
      try {
        const insts = await fetchInstances(study.studyInstanceUid, series.seriesInstanceUid);
        if (cancelled) return;
        if (!insts || insts.length === 0) {
          setError(t("tagview.noImage"));
          return;
        }
        const sop = insts[0].sopInstanceUid;
        setSopUid(sop);
        const dump = await fetchInstanceTags(study.studyInstanceUid, series.seriesInstanceUid, sop);
        if (cancelled) return;
        setRows(dump);
      } catch (e) {
        if (!cancelled) setError(t("common.fetchError", { error: String(e) }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, study, series, t, reloadKey]);

  const matchCount = useMemo(() => {
    if (!rows || !query) return 0;
    const q = query.toLowerCase();
    return rows.filter((r) => rowMatches(r, q)).length;
  }, [rows, query]);

  const built = useMemo(() => (rows ? buildEdits(rows, drafts, added) : null), [rows, drafts, added]);
  const problems: Record<string, string> = { ...serverProblems, ...(built?.problems ?? {}) };
  const canSave = !!built && built.edits.length > 0 && Object.keys(built.problems).length === 0 && !busy;

  if (!open) return null;

  const setNotice = (text: string | null, error = true) => setNoticeState(text ? { text, error } : null);

  const resetEdit = () => {
    setDrafts({});
    setAdded([]);
    setServerProblems({});
    setConfirm(null);
  };

  const setDraft = (k: string, d: Draft | null) => {
    setServerProblems((p) => {
      const { [k]: _drop, ...rest } = p;
      return rest;
    });
    setDrafts((prev) => {
      const next = { ...prev };
      if (d) next[k] = d;
      else delete next[k];
      return next;
    });
  };

  const scopeOf = (): TagEditScope | null => {
    if (!study || !series || !sopUid) return null;
    return { level: scopeLevel, studyUid: study.studyInstanceUid, seriesUid: series.seriesInstanceUid, sopUid };
  };

  /** サーバーの理由を行へ戻す。 */
  const showServerProblems = (b: Built, e: TagEditInvalid) => {
    const map: Record<string, string> = {};
    for (const p of e.problems) {
      const k = p.index >= 0 ? b.keys[p.index] : undefined;
      if (k) map[k] = p.reason;
    }
    setServerProblems(map);
    if (Object.keys(map).length === 0) setNotice(t("tagedit.err.general", { reason: e.problems.map((p) => p.reason).join(", ") }));
  };

  const onPreview = async () => {
    const scope = scopeOf();
    if (!built || !scope) return;
    setBusy(true);
    setNotice(null);
    try {
      const preview = await previewTagEdit(scope, built.edits);
      setConfirm({ built, preview, scope });
    } catch (e) {
      if (e instanceof TagEditInvalid) showServerProblems(built, e);
      else setNotice(t("tagedit.saveFailed", { error: String(e instanceof Error ? e.message : e) }));
    } finally {
      setBusy(false);
    }
  };

  const onApply = async () => {
    if (!confirm || !study) return;
    setBusy(true);
    try {
      const r = await applyTagEdit(confirm.scope, confirm.built.edits);
      emitDbChanged({ reason: "tag-edit", studyUids: [study.studyInstanceUid] }, { includeSelf: true });
      resetEdit();
      setEditing(false);
      setNotice(t("tagedit.saved", { count: r.updatedFiles }), false);
      setReloadKey((v) => v + 1);
    } catch (e) {
      setConfirm(null);
      if (e instanceof TagEditInvalid) showServerProblems(confirm.built, e);
      else if (e instanceof HttpError && e.status === 409) setNotice(t("tagedit.error.atomic"));
      else setNotice(t("tagedit.saveFailed", { error: String(e instanceof Error ? e.message : e) }));
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (k: string): string => {
    if (!rows) return "";
    if (k.startsWith("r")) {
      const r = rows[Number(k.slice(1))];
      return r ? `${r.tag} ${r.name}` : "";
    }
    return added.find((a) => addedKey(a) === k)?.tag ?? "";
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div data-testid="tag-viewer-dialog" style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>{t("tagview.title")}</span>
          <button style={closeBtn} onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </div>

        {/* 対象画像 + 検索 */}
        <div style={toolbar}>
          <div style={{ fontSize: 12, color: "#556", marginRight: "auto" }}>
            {series?.seriesDescription || series?.modality || ""}
            {sopUid && <span style={{ color: "#8a98a6" }}> · SOP {sopUid}</span>}
          </div>
          <label style={{ fontSize: 13, color: "#445" }}>{t("tagview.search")}</label>
          <input
            data-testid="tag-viewer-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("tagview.search.placeholder")}
            style={searchInput}
            autoFocus
          />
          {query && (
            <span style={{ fontSize: 12, color: "#556" }}>{t("tagview.matches", { count: matchCount })}</span>
          )}
          {editable && rows && !editing && (
            <button data-testid="tag-edit-start" style={btn} onClick={() => { resetEdit(); setNotice(null); setEditing(true); }}>
              {t("tagedit.start")}
            </button>
          )}
        </div>

        <div style={tableWrap}>
          {!rows && !error && <div style={{ padding: 14, color: "#888" }}>{t("common.loading")}</div>}
          {error && <div style={{ padding: 14, color: "#b00020" }}>{error}</div>}
          {rows && (
            <table data-testid="tag-viewer-table" style={table}>
              <thead>
                <tr>
                  <Th w={170}>{t("tagview.col.tag")}</Th>
                  <Th w={260}>{t("tagview.col.name")}</Th>
                  <Th w={46}>{t("tagview.col.vr")}</Th>
                  <Th>{t("tagview.col.value")}</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const hit = !!query && rowMatches(r, query.toLowerCase());
                  const k = rowKey(i);
                  const d = drafts[k];
                  const lock = editing ? rowLock(r) : null;
                  const changed = !!d && (d.remove || (d.value !== undefined && d.value !== r.value));
                  const bg = changed ? "#e8f4ff" : hit ? "#fffbe6" : i % 2 ? "#fafbfc" : "#fff";
                  return (
                    <tr key={i} data-testid={`tag-row-${r.tag}`} style={{ background: bg }}>
                      <Td mono>
                        <span style={{ paddingLeft: r.depth * 16 }}>
                          {r.depth > 0 && <span style={{ color: "#b0b8c0" }}>{">".repeat(r.depth)} </span>}
                          <Highlight text={r.tag} q={query} />
                        </span>
                      </Td>
                      <Td>
                        <Highlight text={r.name} q={query} />
                      </Td>
                      <Td mono>
                        <Highlight text={r.vr} q={query} />
                      </Td>
                      <Td mono>
                        {!editing && <Highlight text={r.value} q={query} />}
                        {editing && lock && (
                          <span title={t(`tagedit.lock.${lock}`)}>
                            <Highlight text={r.value} q={query} />{" "}
                            <span data-testid="tag-lock" style={{ color: "#8a6d00", fontFamily: "system-ui, sans-serif" }}>
                              🔒 {t(`tagedit.lock.${lock}`)}
                            </span>
                          </span>
                        )}
                        {editing && !lock && (
                          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            {d?.remove ? (
                              <span style={{ textDecoration: "line-through", color: "#999", flex: 1 }}>{r.value}</span>
                            ) : (
                              <input
                                data-testid="tag-edit-input"
                                value={d?.value ?? r.value}
                                onChange={(e) => setDraft(k, { value: e.target.value })}
                                style={{ ...cellInput, borderColor: problems[k] ? "#c62828" : "#cdd5de" }}
                              />
                            )}
                            <button
                              style={iconBtn}
                              title={d?.remove ? t("tagedit.undoRemove") : t("tagedit.remove")}
                              onClick={() => setDraft(k, d?.remove ? null : { remove: true })}
                            >
                              {d?.remove ? "↺" : "🗑"}
                            </button>
                            {changed && !d?.remove && (
                              <button style={iconBtn} title={t("tagedit.revert")} onClick={() => setDraft(k, null)}>
                                ↺
                              </button>
                            )}
                          </span>
                        )}
                        {editing && problems[k] && (
                          <div style={problemText}>{t(`tagedit.err.${problems[k]}`)}</div>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {editing && rows && (
            <div style={{ padding: "8px 10px", borderTop: "1px solid #eef1f4" }}>
              {added.map((a) => {
                const k = addedKey(a);
                const upd = (patch: Partial<AddedRow>) => {
                  setServerProblems((p) => {
                    const { [k]: _drop, ...rest } = p;
                    return rest;
                  });
                  setAdded((list) => list.map((x) => (x.key === a.key ? { ...x, ...patch } : x)));
                };
                return (
                  <div key={a.key} style={{ marginBottom: 6 }}>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input
                        data-testid="tag-add-tag"
                        value={a.tag}
                        placeholder={t("tagedit.add.tagPlaceholder")}
                        onChange={(e) => upd({ tag: e.target.value })}
                        style={{ ...cellInput, width: 220, flex: "none" }}
                      />
                      <input
                        value={a.vr}
                        placeholder="VR"
                        title={t("tagedit.add.vrHint")}
                        onChange={(e) => upd({ vr: e.target.value })}
                        style={{ ...cellInput, width: 46, flex: "none" }}
                      />
                      <input
                        data-testid="tag-add-value"
                        value={a.value}
                        placeholder={t("tagview.col.value")}
                        onChange={(e) => upd({ value: e.target.value })}
                        style={{ ...cellInput, borderColor: problems[k] ? "#c62828" : "#cdd5de" }}
                      />
                      <button style={iconBtn} onClick={() => setAdded((list) => list.filter((x) => x.key !== a.key))}>
                        ✕
                      </button>
                    </div>
                    {problems[k] && <div style={problemText}>{t(`tagedit.err.${problems[k]}`)}</div>}
                  </div>
                );
              })}
              <button
                data-testid="tag-add"
                style={btn}
                onClick={() => setAdded((list) => [...list, { key: Date.now() + list.length, tag: "", vr: "", value: "" }])}
              >
                {t("tagedit.add")}
              </button>
            </div>
          )}
        </div>

        {confirm && (
          <div data-testid="tag-edit-confirm" style={confirmBox}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              {t("tagedit.confirm.title", { count: confirm.preview.files, scope: t(`tagedit.scope.${confirm.scope.level}`) })}
            </div>
            <table style={{ ...table, tableLayout: "auto" }}>
              <tbody>
                {confirm.built.edits.map((e, i) => {
                  const differing = confirm.preview.items[i]?.differing ?? 0;
                  return (
                    <tr key={i}>
                      <Td mono>{nameOf(confirm.built.keys[i])}</Td>
                      <Td mono>
                        {e.before || "∅"} → {e.op === "remove" ? t("tagedit.removed") : e.value || "∅"}
                      </Td>
                      <Td>
                        {differing > 0 && <span style={{ color: "#8a6d00" }}>{t("tagedit.confirm.differing", { count: differing })}</span>}
                        {affectsRouting(e.tag) && <div style={{ color: "#8a6d00" }}>{t("tagedit.confirm.routing")}</div>}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {confirm.preview.unreadable > 0 && (
              <div style={{ color: "#8a6d00", fontSize: 12 }}>{t("tagedit.confirm.unreadable", { count: confirm.preview.unreadable })}</div>
            )}
            <div style={{ fontSize: 12, color: "#667", margin: "6px 0" }}>{t("tagedit.confirm.note")}</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button data-testid="tag-edit-confirm-cancel" style={btn} onClick={() => setConfirm(null)} disabled={busy}>
                {t("tagedit.back")}
              </button>
              <button data-testid="tag-edit-confirm-ok" style={primaryBtn} onClick={onApply} disabled={busy}>
                {t("tagedit.save")}
              </button>
            </div>
          </div>
        )}

        <div style={footer}>
          <span style={{ fontSize: 12, color: notice ? (notice.error ? "#c62828" : "#2e5d34") : "#667" }} data-testid="tag-edit-notice">
            {notice?.text ?? (rows ? t("tagview.rowCount", { count: rows.length }) : "")}
          </span>
          {editing ? (
            <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "#445" }}>{t("tagedit.scope")}</span>
              {(["series", "instance", "study"] as const).map((lv) => (
                <label key={lv} style={{ fontSize: 12, display: "flex", gap: 3, alignItems: "center" }}>
                  <input
                    type="radio"
                    name="tag-edit-scope"
                    data-testid={`tag-edit-scope-${lv}`}
                    checked={scopeLevel === lv}
                    onChange={() => setScopeLevel(lv)}
                  />
                  {t(`tagedit.scope.${lv}`)}
                </label>
              ))}
              <span style={{ fontSize: 12, color: "#667" }}>{t("tagedit.changeCount", { count: built?.edits.length ?? 0 })}</span>
              <button style={btn} onClick={() => { resetEdit(); setEditing(false); }} disabled={busy}>
                {t("tagedit.cancel")}
              </button>
              <button data-testid="tag-edit-save" style={canSave ? primaryBtn : { ...primaryBtn, opacity: 0.5 }} disabled={!canSave} onClick={onPreview}>
                {t("tagedit.saveConfirm")}
              </button>
            </span>
          ) : (
            <button onClick={onClose} style={btn}>
              {t("common.close")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function rowMatches(r: TagDumpRow, qLower: string): boolean {
  return (
    r.tag.toLowerCase().includes(qLower) ||
    r.name.toLowerCase().includes(qLower) ||
    r.vr.toLowerCase().includes(qLower) ||
    r.value.toLowerCase().includes(qLower)
  );
}

/** text 内の q 一致部分を <mark> でハイライト（大文字小文字無視）。 */
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q || !text) return <>{text}</>;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  for (;;) {
    const idx = lower.indexOf(ql, i);
    if (idx < 0) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark key={key++} style={markStyle}>
        {text.slice(idx, idx + ql.length)}
      </mark>,
    );
    i = idx + ql.length;
  }
  return <>{parts}</>;
}

function Th({ children, w }: { children: React.ReactNode; w?: number }) {
  return (
    <th
      style={{
        position: "sticky",
        top: 0,
        background: "#eef2f6",
        textAlign: "left",
        padding: "6px 10px",
        fontWeight: 600,
        fontSize: 12,
        color: "#445",
        borderBottom: "1px solid #d6dde4",
        width: w,
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <td
      style={{
        padding: "3px 10px",
        verticalAlign: "top",
        fontFamily: mono ? "ui-monospace, monospace" : undefined,
        fontSize: 12,
        wordBreak: "break-all",
      }}
    >
      {children}
    </td>
  );
}

const markStyle: React.CSSProperties = { background: "#ffe27a", color: "inherit", padding: 0 };
const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};
const dialog: React.CSSProperties = {
  width: 900,
  maxWidth: "96vw",
  height: 640,
  maxHeight: "92vh",
  background: "#fff",
  borderRadius: 10,
  boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  fontFamily: "system-ui, sans-serif",
  color: "#1a1a1a",
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 16px",
  borderBottom: "1px solid #eee",
};
const toolbar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 16px",
  borderBottom: "1px solid #eef1f4",
};
const tableWrap: React.CSSProperties = { flex: 1, overflow: "auto" };
const table: React.CSSProperties = { borderCollapse: "collapse", width: "100%", tableLayout: "fixed" };
const footer: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "10px 16px",
  borderTop: "1px solid #eee",
};
const closeBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#666" };
const searchInput: React.CSSProperties = {
  padding: "5px 8px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  fontSize: 13,
  width: 240,
};
const btn: React.CSSProperties = { padding: "6px 14px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13 };
const primaryBtn: React.CSSProperties = { ...btn, background: "#1f5fa8", borderColor: "#1f5fa8", color: "#fff" };
const iconBtn: React.CSSProperties = { border: "none", background: "transparent", cursor: "pointer", fontSize: 13, padding: "0 2px", color: "#556" };
const cellInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "2px 6px",
  border: "1px solid #cdd5de",
  borderRadius: 4,
  fontSize: 12,
  fontFamily: "ui-monospace, monospace",
};
const problemText: React.CSSProperties = { color: "#c62828", fontSize: 11, fontFamily: "system-ui, sans-serif" };
const confirmBox: React.CSSProperties = {
  borderTop: "2px solid #1f5fa8",
  background: "#f5f9ff",
  padding: "10px 16px",
  maxHeight: 240,
  overflow: "auto",
  fontSize: 13,
};
