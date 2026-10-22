/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchTagDictionary,
  seriesExtractCancel,
  seriesExtractDatasheet,
  seriesExtractJob,
  seriesExtractSubmitCopy,
  seriesExtractSubmitVerify,
  seriesExtractZip,
  type SeriesCondition,
  type SeriesExtractJobStatus,
  type SeriesVerifyResult,
  type TagDictEntry,
  type TagPath,
} from "../api";
import { desktop } from "../desktopBridge";
import { useI18n } from "../i18n/i18n";
import { NestedTagBuilder } from "./NestedTagBuilder";
import { exportPercent, runExportJob } from "./exportJob";
import {
  canRun,
  coerceOp,
  conditionError,
  daToInput,
  hasPath,
  inputToDa,
  isDateVr,
  isNumericVr,
  keepNumeric,
  opsForVr,
  usedSingleTags,
  visibleDict,
} from "./seriesCondUtil";
import { dictMap, ggggeeee, isSQ, normHex, parseConditions, pathDisplay, pathLabel, serializeConditions } from "./tagPathUtil";

const PLANES = ["AXIAL", "SAGITTAL", "CORONAL"];
const PRIVATE_VRS = ["LO", "SH", "CS", "DS", "IS", "US", "UL", "FL", "FD", "DA", "TM", "PN"];
const ROW_H = 26;

const download = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

type Phase = null | "scan" | "copy" | "zip" | "sheet";

/**
 * シリーズ抽出の本体（DB 管理のタブにも、メイン画面のダイアログにも載せる）。
 * 左: 辞書からタグを探す → 右: 条件を組む → 下: 実行（進捗・結果・データシート・抽出）。
 * 対象スタディは resolveStudyUids が決める（検索リスト全体／DB 全体）。失敗は Error の message で返す。
 */
export function SeriesExtractorPanel({
  active,
  scopeLabel,
  resolveStudyUids,
  mode,
}: {
  active: boolean;
  scopeLabel: string;
  resolveStudyUids: () => Promise<string[]>;
  mode: string;
}) {
  const { t } = useI18n();
  const isWeb = mode === "web";
  const [dict, setDict] = useState<TagDictEntry[]>([]);
  const dmap = useMemo(() => dictMap(dict), [dict]);

  const [conditions, setConditions] = useState<SeriesCondition[]>([]);
  const [planes, setPlanes] = useState<Set<string>>(new Set());
  const [sequentialRename, setSequentialRename] = useState(true);
  const [destination, setDestination] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [nested, setNested] = useState<{ open: boolean; initial?: string }>({ open: false });
  const [pv, setPv] = useState({ tag: "", name: "", creator: "", vr: "LO" });

  const [result, setResult] = useState<SeriesVerifyResult | null>(null);
  const [phase, setPhase] = useState<Phase>(null);
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!active || dict.length > 0) return;
    fetchTagDictionary().then(setDict).catch(() => setError(t("tagext.err.dict")));
  }, [active, dict.length, t]);

  const busy = phase !== null;
  const used = useMemo(() => usedSingleTags(conditions), [conditions]);
  const shown = useMemo(() => visibleDict(dict, query, used), [dict, query, used]);
  const runnable = canRun(conditions);

  // 条件を変えたら、前回の検証結果は古い。
  const touch = () => {
    setResult(null);
    setInfo(null);
  };

  const firstVr = (vr: string) => (vr || "").split(/[ ,/]/).filter(Boolean)[0] ?? "";

  const addCondition = (p: TagPath, vrOverride?: string) => {
    if (hasPath(conditions, p.segments)) {
      setError(t("seriesext.err.duplicate"));
      return;
    }
    const last = p.segments[p.segments.length - 1];
    const vr = vrOverride ?? firstVr(dmap.get(last.tag)?.vr ?? "");
    setError(null);
    touch();
    setConditions((cs) => [
      ...cs,
      { segments: p.segments, vr, exclude: false, op: opsForVr(vr)[0], value1: "", value2: "", label: p.label },
    ]);
  };

  const addFromDict = (e: TagDictEntry) => {
    if (isSQ(e)) {
      setNested({ open: true, initial: e.tag });
      return;
    }
    addCondition({ segments: [{ tag: e.tag }], label: pathLabel(dmap, [{ tag: e.tag }]) });
  };

  const addPrivate = () => {
    const hex = normHex(pv.tag);
    if (!hex) {
      setError(t("tagext.err.badTag", { tag: pv.tag }));
      return;
    }
    const creator = pv.creator.trim() || undefined;
    const label = pv.name.trim() || ggggeeee(hex);
    addCondition({ segments: [{ tag: hex, creator }], label }, pv.vr);
    setPv({ tag: "", name: "", creator: "", vr: pv.vr });
  };

  const updateCond = (i: number, patch: Partial<SeriesCondition>) => {
    touch();
    setConditions((cs) =>
      cs.map((c, idx) => {
        if (idx !== i) return c;
        const n = { ...c, ...patch };
        if (patch.vr !== undefined) n.op = coerceOp(n.op, n.vr);
        return n;
      }),
    );
  };
  const removeCond = (i: number) => {
    touch();
    setConditions((cs) => cs.filter((_, idx) => idx !== i));
  };
  const togglePlane = (p: string) => {
    touch();
    setPlanes((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  };

  const labelFor = (c: SeriesCondition) => c.label || pathLabel(dmap, c.segments);
  const buildReq = (studyUids: string[], withDest = false) => ({
    studyUids,
    conditions: conditions.map((c) => ({ ...c, label: labelFor(c) })),
    planes: [...planes],
    destination: withDest ? destination ?? undefined : undefined,
    sequentialRename,
  });

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const onStatus = (s: SeriesExtractJobStatus) => setProgress({ processed: s.processed, total: s.total });

  const verify = async () => {
    setPhase("scan");
    setError(null);
    setInfo(null);
    setProgress(null);
    cancelRef.current = false;
    try {
      const studyUids = await resolveStudyUids();
      const req = buildReq(studyUids);
      const fin = await runExportJob<SeriesExtractJobStatus>(
        { submit: () => seriesExtractSubmitVerify(req), get: seriesExtractJob, cancel: seriesExtractCancel },
        onStatus,
        () => cancelRef.current,
        300,
      );
      if (fin.state === "CANCELLED") {
        setInfo(t("seriesext.cancelled"));
      } else if (fin.state === "FAILED" || !fin.verify) {
        setError(fin.error ?? t("seriesext.err.failed"));
      } else {
        setResult(fin.verify);
        setInfo(t("seriesext.verified", { series: fin.verify.seriesCount, studies: fin.verify.studyCount }));
      }
    } catch (e) {
      fail(e);
    } finally {
      setPhase(null);
      setProgress(null);
    }
  };

  const datasheet = async () => {
    setPhase("sheet");
    setError(null);
    try {
      const studyUids = await resolveStudyUids();
      download(await seriesExtractDatasheet(buildReq(studyUids)), "series_datasheet.csv");
      setInfo(t("seriesext.sheetSaved"));
    } catch (e) {
      fail(e);
    } finally {
      setPhase(null);
    }
  };

  const pickDest = async () => {
    const d = desktop();
    if (d?.pickDirectory) {
      const p = await d.pickDirectory();
      if (p) setDestination(p);
    } else {
      setError(t("seriesext.err.noPicker"));
    }
  };

  const extract = async () => {
    setError(null);
    setInfo(null);
    cancelRef.current = false;
    try {
      const studyUids = await resolveStudyUids();
      if (isWeb) {
        setPhase("zip");
        const { blob, filename } = await seriesExtractZip(buildReq(studyUids));
        download(blob, filename);
        setInfo(t("seriesext.zipped"));
        return;
      }
      if (!destination) {
        setError(t("seriesext.err.noDest"));
        return;
      }
      setPhase("copy");
      setProgress(null);
      const req = buildReq(studyUids, true);
      const fin = await runExportJob<SeriesExtractJobStatus>(
        { submit: () => seriesExtractSubmitCopy(req), get: seriesExtractJob, cancel: seriesExtractCancel },
        onStatus,
        () => cancelRef.current,
        300,
      );
      if (fin.state === "CANCELLED") {
        setInfo(t("seriesext.cancelledCopy"));
      } else if (fin.state === "FAILED" || !fin.copy) {
        setError(fin.error ?? t("seriesext.err.failed"));
      } else {
        setInfo(t("seriesext.copied", { series: fin.copy.copiedSeries, files: fin.copy.copiedFiles }));
        if (fin.copy.errors.length > 0) setError(fin.copy.errors.slice(0, 3).join(" / "));
      }
    } catch (e) {
      fail(e);
    } finally {
      setPhase(null);
      setProgress(null);
    }
  };

  const saveConditions = () =>
    download(new Blob([serializeConditions(conditions, [...planes])], { type: "text/plain" }), "series-conditions.properties");
  const loadConditions = async (file: File) => {
    try {
      const { conditions: cs, planes: ps } = parseConditions(await file.text());
      // 読込結果にも重複禁止を適用する（手編集ファイル対策）。
      const uniq: SeriesCondition[] = [];
      for (const c of cs) if (!hasPath(uniq, c.segments)) uniq.push({ ...c, label: c.label ?? pathLabel(dmap, c.segments) });
      touch();
      setConditions(uniq);
      setPlanes(new Set(ps));
      setInfo(t("seriesext.loaded", { count: uniq.length }));
      setError(null);
    } catch (e) {
      fail(e);
    }
  };

  // 辞書一覧の窓表示（全件をスクロールできるが、描画するのは見えている行だけ）。
  const viewH = listRef.current?.clientHeight ?? 360;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
  const last = Math.min(shown.length, Math.ceil((scrollTop + viewH) / ROW_H) + 5);

  const canExtract = !busy && !!result && result.seriesCount > 0 && (isWeb || !!destination);
  const pct = progress ? exportPercent({ jobId: "", state: "RUNNING", total: progress.total, processed: progress.processed }) : null;

  return (
    <div data-testid="series-extractor-panel" style={root}>
      <div style={scopeBar}>{scopeLabel}</div>

      <div style={twoPane}>
        {/* ① タグを探す */}
        <section style={leftPane}>
          <div style={paneTitle}>
            <span style={stepBadge}>1</span>
            {t("seriesext.step.tags")}
          </div>
          <input
            data-testid="series-extractor-tag-search"
            style={inp}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setScrollTop(0);
              if (listRef.current) listRef.current.scrollTop = 0;
            }}
            placeholder={t("seriesext.tagSearch")}
            spellCheck={false}
          />
          <div style={hint}>{t("seriesext.tagCount", { shown: shown.length, hidden: used.size })}</div>
          <div
            ref={listRef}
            data-testid="series-extractor-tag-list"
            style={listBox}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            <div style={{ height: shown.length * ROW_H, position: "relative" }}>
              {shown.slice(first, last).map((e, k) => (
                <div
                  key={e.tag}
                  style={{ ...dictRow, top: (first + k) * ROW_H }}
                  onDoubleClick={() => addFromDict(e)}
                  title={t("seriesext.tagRowHint")}
                >
                  <span style={{ fontFamily: "monospace", color: "#556", flex: "none" }}>{ggggeeee(e.tag)}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.keyword}</span>
                  <span style={vrChip}>{isSQ(e) ? "SQ ▸" : firstVr(e.vr)}</span>
                  <button style={addBtn} onClick={() => addFromDict(e)} aria-label={t("common.add")}>
                    ＋
                  </button>
                </div>
              ))}
            </div>
          </div>
          <details style={{ marginTop: 6 }}>
            <summary style={summary}>{t("seriesext.privateTitle")}</summary>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginTop: 6 }}>
              <input style={inp} value={pv.tag} onChange={(e) => setPv({ ...pv, tag: e.target.value })} placeholder="gggg,eeee (0019,1001)" spellCheck={false} />
              <input style={inp} value={pv.name} onChange={(e) => setPv({ ...pv, name: e.target.value })} placeholder={t("tagext.private.name")} />
              <input style={inp} value={pv.creator} onChange={(e) => setPv({ ...pv, creator: e.target.value })} placeholder={t("tagext.private.creator")} />
              <select style={sel} value={pv.vr} onChange={(e) => setPv({ ...pv, vr: e.target.value })} title="VR">
                {PRIVATE_VRS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <button style={{ ...btn, marginTop: 4, width: "100%" }} onClick={addPrivate}>
              {t("seriesext.privateAdd")}
            </button>
          </details>
          <button style={{ ...btn, marginTop: 6 }} onClick={() => setNested({ open: true })}>
            {t("seriesext.nestedOpen")}
          </button>
        </section>

        {/* ② 条件 */}
        <section style={rightPane}>
          <div style={{ ...paneTitle, justifyContent: "space-between" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={stepBadge}>2</span>
              {t("seriesext.step.conditions")}
            </span>
            <span style={{ display: "flex", gap: 4 }}>
              <button style={miniBtn} onClick={saveConditions} disabled={conditions.length === 0 && planes.size === 0} title={t("seriesext.saveConditions")}>
                💾
              </button>
              <button style={miniBtn} onClick={() => fileInputRef.current?.click()} title={t("seriesext.loadConditions")}>
                📂
              </button>
              <button
                style={miniBtn}
                onClick={() => {
                  touch();
                  setConditions([]);
                  setPlanes(new Set());
                }}
                disabled={conditions.length === 0 && planes.size === 0}
                title={t("seriesext.clearAll")}
              >
                🗑
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".properties,.txt"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void loadConditions(f);
                  e.target.value = "";
                }}
              />
            </span>
          </div>

          <div data-testid="series-extractor-cond-list" style={condList}>
            {conditions.length === 0 && <div style={empty}>{t("seriesext.conditions.empty")}</div>}
            {conditions.map((c, i) => {
              const err = conditionError(c);
              const inDict = c.segments.length === 1 && dmap.has(c.segments[0].tag);
              const isRange = c.op === "RANGE";
              const num = isNumericVr(c.vr);
              return (
                <div key={`${i}:${c.segments.map((s) => s.tag).join("")}`} data-testid="series-extractor-cond" style={{ ...card, borderLeft: `4px solid ${c.exclude ? "#c62828" : "#2e7d32"}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={seg}>
                      <button style={segBtn(!c.exclude, "#2e7d32")} onClick={() => updateCond(i, { exclude: false })}>
                        {t("seriesext.include")}
                      </button>
                      <button style={segBtn(c.exclude, "#c62828")} onClick={() => updateCond(i, { exclude: true })}>
                        {t("seriesext.exclude")}
                      </button>
                    </span>
                    <span style={pathText} title={pathDisplay(dmap, { segments: c.segments, label: "" })}>
                      {c.segments.map((s) => dmap.get(s.tag)?.keyword || c.label || ggggeeee(s.tag)).join(" › ")}
                      <span style={{ color: "#8a98a6", marginLeft: 6, fontFamily: "monospace", fontSize: 11 }}>
                        {c.segments.map((s) => ggggeeee(s.tag)).join(" › ")}
                      </span>
                    </span>
                    <button style={{ ...miniBtn, color: "#b00020" }} onClick={() => removeCond(i)} aria-label={t("common.delete")}>
                      ✕
                    </button>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                    {!inDict && (
                      <select style={sel} value={c.vr} onChange={(e) => updateCond(i, { vr: e.target.value })} title="VR">
                        {[...new Set([c.vr, ...PRIVATE_VRS].filter(Boolean))].map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    )}
                    {inDict && <span style={vrChip}>{c.vr}</span>}
                    <select style={sel} value={c.op} onChange={(e) => updateCond(i, { op: e.target.value })}>
                      {opsForVr(c.vr).map((op) => (
                        <option key={op} value={op}>
                          {t(`seriesext.op.${op}`)}
                        </option>
                      ))}
                    </select>
                    <ValueInput c={c} which={1} num={num} onChange={(v) => updateCond(i, { value1: v })} placeholder={t("seriesext.value")} bad={!!err} />
                    {isRange && (
                      <>
                        <span style={{ color: "#8a98a6" }}>〜</span>
                        <ValueInput c={c} which={2} num={num} onChange={(v) => updateCond(i, { value2: v })} placeholder={t("seriesext.value2")} bad={!!err} />
                      </>
                    )}
                    {err && <span style={{ color: "#b00020", fontSize: 11.5 }}>{t(`seriesext.condErr.${err}`)}</span>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* ③ 撮像断面 */}
          <div style={planeBar}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#33404d" }}>
              <span style={stepBadge}>3</span> {t("seriesext.plane")}
            </span>
            {PLANES.map((p) => (
              <button key={p} data-testid={`series-extractor-plane-${p}`} style={chip(planes.has(p))} onClick={() => togglePlane(p)}>
                {t(`seriesext.plane.${p}`)}
              </button>
            ))}
            <span style={hint}>{planes.size === 0 ? t("seriesext.plane.none") : t("seriesext.plane.note")}</span>
          </div>
        </section>
      </div>

      {/* ④ 実行 */}
      <div style={runBar}>
        <span style={stepBadge}>4</span>
        <button data-testid="series-extractor-verify-btn" style={primaryBtn(runnable && !busy)} onClick={() => void verify()} disabled={!runnable || busy}>
          {phase === "scan" ? t("seriesext.verifying") : t("seriesext.verify")}
        </button>
        <button data-testid="series-extractor-datasheet-btn" style={btn} onClick={() => void datasheet()} disabled={busy || !result || result.seriesCount === 0} title={t("seriesext.datasheetHint")}>
          {t("seriesext.datasheet")}
        </button>
        <span style={{ flex: 1 }} />
        {!isWeb && (
          <>
            <button data-testid="series-extractor-pick-dest-btn" style={btn} onClick={() => void pickDest()} disabled={busy}>
              {t("seriesext.pickDest")}
            </button>
            <span
              data-testid="series-extractor-dest-label"
              style={{ fontSize: 12, color: destination ? "#33404d" : "#8a98a6", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={destination ?? ""}
            >
              {destination ?? t("seriesext.noDest")}
            </span>
          </>
        )}
        <label style={opt}>
          <input type="checkbox" checked={sequentialRename} onChange={(e) => setSequentialRename(e.target.checked)} disabled={busy} />
          {t("seriesext.sequential")}
        </label>
        <button data-testid="series-extractor-extract-btn" style={primaryBtn(canExtract)} onClick={() => void extract()} disabled={!canExtract}>
          {isWeb ? t("seriesext.downloadZip") : t("seriesext.extract")}
        </button>
      </div>

      {busy && (
        <div data-testid="series-extractor-progress" style={progressRow}>
          <div style={barOuter}>
            <div style={{ ...barInner, width: pct === null ? "30%" : `${pct}%`, animation: pct === null ? "none" : undefined }} />
          </div>
          <span style={{ fontSize: 12, minWidth: 130 }}>
            {phase === "scan" && t("seriesext.progress.scan", { n: progress?.processed ?? 0, total: progress && progress.total > 0 ? progress.total : "…" })}
            {phase === "copy" && t("seriesext.progress.copy", { pct: pct ?? 0 })}
            {phase === "zip" && t("seriesext.progress.zip")}
            {phase === "sheet" && t("seriesext.progress.sheet")}
          </span>
          {(phase === "scan" || phase === "copy") && (
            <button data-testid="series-extractor-cancel-btn" style={btn} onClick={() => (cancelRef.current = true)}>
              {t("common.cancel")}
            </button>
          )}
        </div>
      )}

      <div style={statusLine}>
        {info && <span style={{ color: "#2e5d27" }}>{info}</span>}
        {error && <span style={{ color: "#b00020" }}>{error}</span>}
      </div>

      {/* 結果 */}
      <div style={resultPane}>
        {!result && <div style={empty}>{t("seriesext.notVerified")}</div>}
        {result && (
          <div style={{ overflow: "auto", height: "100%" }}>
            <table data-testid="series-extractor-result-table" style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>{t("field.patientId")}</th>
                  <th style={th}>{t("qr.col.studyDate")}</th>
                  <th style={th}>{t("qr.col.modality")}</th>
                  <th style={th}>{t("seriesext.col.plane")}</th>
                  <th style={th}>{t("qr.col.seriesDesc")}</th>
                  <th style={th}>{t("qr.col.instances")}</th>
                  <th style={th}>{t("seriesext.folder")}</th>
                </tr>
              </thead>
              <tbody>
                {result.matched.map((m, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #eef1f4" }} title={m.seriesUid}>
                    <td style={td}>{m.patientId}</td>
                    <td style={td}>{m.studyDate}</td>
                    <td style={td}>{m.modality}</td>
                    <td style={td}>{m.plane ? t(`seriesext.plane.${m.plane}`) : "—"}</td>
                    <td style={td}>{m.seriesDescription}</td>
                    <td style={td}>{m.instances}</td>
                    <td style={td} title={m.folderName}>
                      {m.folderName}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {result.errors.length > 0 && (
              <div style={errBox}>
                <div style={{ fontWeight: 600 }}>{t("seriesext.skipped", { count: result.errors.length })}</div>
                {result.errors.slice(0, 30).map((e, i) => (
                  <div key={i}>{e}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <NestedTagBuilder
        open={nested.open}
        dict={dict}
        dictMapByTag={dmap}
        initialTag={nested.initial}
        onClose={() => setNested({ open: false })}
        onConfirm={(p) => {
          addCondition(p);
          setNested({ open: false });
        }}
      />
    </div>
  );
}

function ValueInput({
  c,
  which,
  num,
  onChange,
  placeholder,
  bad,
}: {
  c: SeriesCondition;
  which: 1 | 2;
  num: boolean;
  onChange: (v: string) => void;
  placeholder: string;
  bad: boolean;
}) {
  const v = which === 1 ? c.value1 : c.value2;
  if (isDateVr(c.vr)) {
    return <input type="date" style={{ ...inp, width: 140, borderColor: bad && v === "" ? "#b00020" : "#cdd5de" }} value={daToInput(v)} onChange={(e) => onChange(inputToDa(e.target.value))} />;
  }
  return (
    <input
      style={{ ...inp, width: 130, borderColor: bad ? "#b00020" : "#cdd5de" }}
      value={v}
      inputMode={num ? "decimal" : undefined}
      onChange={(e) => onChange(num ? keepNumeric(e.target.value) : e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
    />
  );
}

const root: React.CSSProperties = { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, gap: 8, fontFamily: "system-ui, sans-serif", color: "#1a1a1a" };
const scopeBar: React.CSSProperties = { fontSize: 12, color: "#556", background: "#f3f6f9", border: "1px solid #e1e7ee", borderRadius: 6, padding: "5px 10px" };
const twoPane: React.CSSProperties = { display: "flex", gap: 10, flex: "0 0 auto", height: 330, minHeight: 0 };
const leftPane: React.CSSProperties = { width: 320, flex: "none", display: "flex", flexDirection: "column", minHeight: 0, border: "1px solid #e1e7ee", borderRadius: 8, padding: 8 };
const rightPane: React.CSSProperties = { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0, border: "1px solid #e1e7ee", borderRadius: 8, padding: 8 };
const paneTitle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontWeight: 700, fontSize: 13, marginBottom: 6 };
const stepBadge: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, borderRadius: 9, background: "#0b5cad", color: "#fff", fontSize: 11, fontWeight: 700 };
const hint: React.CSSProperties = { fontSize: 11.5, color: "#8a98a6" };
const listBox: React.CSSProperties = { flex: 1, minHeight: 0, overflow: "auto", border: "1px solid #e1e7ee", borderRadius: 6, background: "#fff" };
const dictRow: React.CSSProperties = { position: "absolute", left: 0, right: 0, height: ROW_H, boxSizing: "border-box", display: "flex", alignItems: "center", gap: 6, padding: "0 6px", fontSize: 12.5, borderBottom: "1px solid #f1f3f5", cursor: "pointer" };
const vrChip: React.CSSProperties = { fontSize: 10.5, color: "#5b6b7a", background: "#eef2f6", borderRadius: 4, padding: "1px 5px", flex: "none" };
const addBtn: React.CSSProperties = { flex: "none", border: "1px solid #cdd5de", background: "#fff", borderRadius: 4, cursor: "pointer", fontSize: 12, lineHeight: "16px", padding: "0 5px", color: "#0b5cad" };
const summary: React.CSSProperties = { fontSize: 12, color: "#33404d", cursor: "pointer" };
const condList: React.CSSProperties = { flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 6, background: "#fafbfc", border: "1px solid #e1e7ee", borderRadius: 6, padding: 6 };
const card: React.CSSProperties = { background: "#fff", border: "1px solid #e1e7ee", borderRadius: 6, padding: "6px 8px" };
const seg: React.CSSProperties = { display: "inline-flex", border: "1px solid #cdd5de", borderRadius: 6, overflow: "hidden", flex: "none" };
const segBtn = (on: boolean, color: string): React.CSSProperties => ({ border: "none", padding: "3px 9px", fontSize: 12, cursor: "pointer", background: on ? color : "#fff", color: on ? "#fff" : "#556", fontWeight: on ? 700 : 400 });
const pathText: React.CSSProperties = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 600 };
const planeBar: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 6 };
const chip = (on: boolean): React.CSSProperties => ({ padding: "3px 12px", border: `1px solid ${on ? "#0b5cad" : "#cdd5de"}`, borderRadius: 14, background: on ? "#0b5cad" : "#fff", color: on ? "#fff" : "#33404d", cursor: "pointer", fontSize: 12.5 });
const runBar: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", flex: "none" };
const progressRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, flex: "none" };
const barOuter: React.CSSProperties = { flex: 1, height: 10, background: "#e8eef4", borderRadius: 5, overflow: "hidden" };
const barInner: React.CSSProperties = { height: "100%", background: "#0b5cad", transition: "width 0.2s" };
const statusLine: React.CSSProperties = { flex: "none", minHeight: 18, fontSize: 12 };
const resultPane: React.CSSProperties = { flex: 1, minHeight: 90, overflow: "hidden", border: "1px solid #e1e7ee", borderRadius: 8, padding: 6 };
const empty: React.CSSProperties = { color: "#8a98a6", fontSize: 12, padding: 6 };
const tableStyle: React.CSSProperties = { borderCollapse: "collapse", fontSize: 12, width: "100%", whiteSpace: "nowrap" };
const th: React.CSSProperties = { position: "sticky", top: 0, background: "#f7f9fb", border: "1px solid #e1e7ee", padding: "4px 8px", textAlign: "left", fontWeight: 600 };
const td: React.CSSProperties = { border: "1px solid #eef1f4", padding: "3px 8px", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" };
const errBox: React.CSSProperties = { marginTop: 8, padding: 8, background: "#fff8e6", border: "1px solid #f0dca0", borderRadius: 6, fontSize: 11.5, color: "#7a5b00" };
const btn: React.CSSProperties = { padding: "6px 14px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" };
const primaryBtn = (on: boolean): React.CSSProperties => ({ ...btn, background: on ? "#0b5cad" : "#9fb6cf", color: "#fff", border: "none", cursor: on ? "pointer" : "default" });
const miniBtn: React.CSSProperties = { minWidth: 26, padding: "3px 7px", border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 13 };
const sel: React.CSSProperties = { padding: "4px 6px", border: "1px solid #cdd5de", borderRadius: 5, fontSize: 12.5, background: "#fff" };
const inp: React.CSSProperties = { padding: "4px 7px", border: "1px solid #cdd5de", borderRadius: 5, fontSize: 12.5, boxSizing: "border-box" };
const opt: React.CSSProperties = { display: "flex", alignItems: "center", gap: 5, fontSize: 12.5, cursor: "pointer" };
