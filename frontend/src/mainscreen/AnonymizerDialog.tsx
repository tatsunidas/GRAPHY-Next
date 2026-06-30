/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  anonymizeCopy,
  anonymizeZip,
  fetchAnonProfiles,
  fetchStudies,
  fetchTagDictionary,
  type AnonOption,
  type AnonProfile,
  type AnonRequest,
  type StudyFilters,
  type TagDictEntry,
} from "../api";
import { desktop } from "../desktopBridge";
import { useI18n } from "../i18n/i18n";
import { dictMap, ggggeeee, normHex } from "./tagPathUtil";

const CLEAN_OPTS: AnonOption[] = [
  "CleanPixelData", "CleanRecognizableVisualFeatures", "CleanGraphics",
  "CleanStructuredContent", "CleanDescriptors",
];
const RETAIN_OPTS: AnonOption[] = [
  "RetainUIDs", "RetainSafePrivate", "RetainDeviceIdentity", "RetainInstitutionIdentity",
  "RetainPatientCharacteristics", "RetainLongitudinalTemporalInformationFullDates",
  "RetainLongitudinalTemporalInformationModifiedDates",
];

/**
 * Anonymizer（PS3.15）。検索リスト全体を匿名化（属性＋任意で Pixel 焼き込み）して ZIP/フォルダ出力。
 * オプション・新 PatientName/ID・個別保持/カスタム値・プロファイル保存/読込。
 */
export function AnonymizerDialog({
  open,
  onClose,
  filters,
  mode,
}: {
  open: boolean;
  onClose: () => void;
  filters: StudyFilters | null;
  mode: string;
}) {
  const { t } = useI18n();
  const isWeb = mode === "web";
  const [dict, setDict] = useState<TagDictEntry[]>([]);
  const dmap = useMemo(() => dictMap(dict), [dict]);
  const [profiles, setProfiles] = useState<AnonProfile[]>([]);

  const [options, setOptions] = useState<Set<AnonOption>>(new Set());
  const [patName, setPatName] = useState("de-identified");
  const [patId, setPatId] = useState("de-identified");
  const [seed, setSeed] = useState("");
  const [manualRetain, setManualRetain] = useState<string[]>([]);
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [burnIn, setBurnIn] = useState(false);
  const [destination, setDestination] = useState<string | null>(null);

  const [tagInput, setTagInput] = useState("");
  const [valInput, setValInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    if (dict.length === 0) fetchTagDictionary().then(setDict).catch(() => undefined);
    fetchAnonProfiles().then(setProfiles).catch(() => undefined);
  }, [open, dict.length]);

  if (!open) return null;

  const toggleOpt = (o: AnonOption) =>
    setOptions((s) => {
      const n = new Set(s);
      if (n.has(o)) n.delete(o);
      else n.add(o);
      return n;
    });

  const applyProfile = (p: AnonProfile) => setOptions(new Set(p.options));

  const addRetain = () => {
    const h = normHex(tagInput);
    if (!h) { setError(t("tagext.err.badTag", { tag: tagInput })); return; }
    setManualRetain((r) => (r.includes(h) ? r : [...r, h]));
    setTagInput("");
  };
  const addCustom = () => {
    const h = normHex(tagInput);
    if (!h) { setError(t("tagext.err.badTag", { tag: tagInput })); return; }
    setCustom((c) => ({ ...c, [h]: valInput }));
    setTagInput("");
    setValInput("");
  };

  const buildReq = (studyUids: string[]): AnonRequest => ({
    studyUids,
    options: [...options],
    replacePatientName: patName,
    replacePatientId: patId,
    randomSeed: seed.trim() === "" ? null : Number(seed),
    manualRetainTags: manualRetain,
    customReplacements: custom,
    burnIn: burnIn && options.has("CleanPixelData"),
    destination: destination ?? undefined,
  });

  const resolveStudyUids = async (): Promise<string[] | null> => {
    if (!filters) { setError(t("tagext.err.noSearch")); return null; }
    const studies = await fetchStudies(filters);
    if (studies.length === 0) { setError(t("tagext.err.noStudies")); return null; }
    return studies.map((s) => s.studyInstanceUid);
  };

  const runZip = async () => {
    setBusy(true); setError(null); setInfo(null);
    try {
      const ids = await resolveStudyUids();
      if (!ids) return;
      const { blob, filename } = await anonymizeZip(buildReq(ids));
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      setInfo(t("anon.zipped"));
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally { setBusy(false); }
  };

  const runCopy = async () => {
    if (!destination) { setError(t("anon.err.noDest")); return; }
    setBusy(true); setError(null); setInfo(null);
    try {
      const ids = await resolveStudyUids();
      if (!ids) return;
      const r = await anonymizeCopy(buildReq(ids));
      setInfo(t("anon.copied", { instances: r.instances, burned: r.burnedInstances }));
      if (r.errors.length) setError(r.errors.slice(0, 3).join(" / "));
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally { setBusy(false); }
  };

  const pickDest = async () => {
    const d = desktop();
    if (d?.pickDirectory) { const p = await d.pickDirectory(); if (p) setDestination(p); }
    else setError(t("seriesext.err.noPicker"));
  };

  const saveProfile = () => {
    const prof = { options: [...options], patName, patId, seed, manualRetain, custom };
    const blob = new Blob([JSON.stringify(prof, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "anon-profile.json"; document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };
  const loadProfile = async (f: File) => {
    try {
      const p = JSON.parse(await f.text());
      setOptions(new Set(p.options ?? []));
      setPatName(p.patName ?? "de-identified");
      setPatId(p.patId ?? "de-identified");
      setSeed(p.seed ?? "");
      setManualRetain(p.manualRetain ?? []);
      setCustom(p.custom ?? {});
      setInfo(t("anon.profileLoaded"));
    } catch (e) { setError(t("common.fetchError", { error: String(e) })); }
  };

  const label = (h: string) => dmap.get(h)?.keyword ?? "";

  return (
    <div style={overlay} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>{t("anon.title")}</span>
          <button style={closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={body}>
          <div style={{ fontSize: 12, color: "#6b7785" }}>{t("anon.scope")}</div>

          {/* プロファイル */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={lbl}>{t("anon.profile")}:</span>
            {profiles.map((p) => (
              <button key={p.name} style={chip} onClick={() => applyProfile(p)}>{t(`anon.profile.${p.name}`)}</button>
            ))}
            <span style={{ flex: 1 }} />
            <button style={miniBtn} onClick={saveProfile} title={t("anon.saveProfile")}>💾</button>
            <button style={miniBtn} onClick={() => fileRef.current?.click()} title={t("anon.loadProfile")}>📂</button>
            <input ref={fileRef} type="file" accept=".json" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadProfile(f); e.target.value = ""; }} />
          </div>

          {/* オプション */}
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
            <div>
              <div style={grpTitle}>{t("anon.clean")}</div>
              {CLEAN_OPTS.map((o) => (
                <label key={o} style={opt}>
                  <input type="checkbox" checked={options.has(o)} onChange={() => toggleOpt(o)} />
                  {t(`anon.opt.${o}`)}
                </label>
              ))}
            </div>
            <div>
              <div style={grpTitle}>{t("anon.retain")}</div>
              {RETAIN_OPTS.map((o) => (
                <label key={o} style={opt}>
                  <input type="checkbox" checked={options.has(o)} onChange={() => toggleOpt(o)} />
                  {t(`anon.opt.${o}`)}
                </label>
              ))}
            </div>
          </div>

          {/* 患者置換 + seed */}
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span style={lbl}>{t("anon.newName")}</span>
            <input style={inp} value={patName} onChange={(e) => setPatName(e.target.value)} />
            <span style={lbl}>{t("anon.newId")}</span>
            <input style={inp} value={patId} onChange={(e) => setPatId(e.target.value)} />
            <span style={lbl}>{t("anon.seed")}</span>
            <input style={{ ...inp, width: 90 }} value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="(任意)" />
          </div>

          {/* 焼き込み */}
          <label style={opt}>
            <input type="checkbox" checked={burnIn} disabled={!options.has("CleanPixelData")}
              onChange={(e) => setBurnIn(e.target.checked)} />
            {t("anon.burnIn")}
          </label>
          {options.has("CleanPixelData") && (
            <div style={{ fontSize: 11, color: "#8a98a6" }}>{t("anon.burnIn.note")}</div>
          )}

          {/* 個別上書き */}
          <details>
            <summary style={{ cursor: "pointer", fontSize: 12, color: "#33404d" }}>{t("anon.advanced")}</summary>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
              <input style={{ ...inp, width: 110 }} value={tagInput} onChange={(e) => setTagInput(e.target.value)} placeholder="0010,1010" />
              <button style={miniBtn} onClick={addRetain}>{t("anon.retainTag")}</button>
              <input style={{ ...inp, width: 120 }} value={valInput} onChange={(e) => setValInput(e.target.value)} placeholder={t("anon.customVal")} />
              <button style={miniBtn} onClick={addCustom}>{t("anon.customTag")}</button>
            </div>
            <div style={{ marginTop: 6, fontSize: 12 }}>
              {manualRetain.map((h) => (
                <span key={h} style={tag2}>K {ggggeeee(h)} {label(h)}
                  <b style={x} onClick={() => setManualRetain((r) => r.filter((y) => y !== h))}>×</b></span>
              ))}
              {Object.entries(custom).map(([h, v]) => (
                <span key={h} style={tag2}>D {ggggeeee(h)}={v}
                  <b style={x} onClick={() => setCustom((c) => { const n = { ...c }; delete n[h]; return n; })}>×</b></span>
              ))}
            </div>
          </details>
        </div>

        <div style={footer}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {info && <span style={{ color: "#2e5d27" }}>{info}</span>}
            {error && <span style={{ color: "#b00020" }}>{error}</span>}
            {isWeb && <span style={{ color: "#a85b00" }}>{t("anon.webNote")}</span>}
          </div>
          {!isWeb && (
            <>
              <button style={btn} onClick={() => void pickDest()} title={destination ?? ""}>{t("anon.pickDest")}</button>
              <button style={btn} onClick={() => void runCopy()} disabled={busy || !destination}>{t("anon.copy")}</button>
            </>
          )}
          <button style={btn} onClick={onClose}>{t("common.close")}</button>
          <button style={{ ...btn, background: busy ? "#9fb6cf" : "#0b5cad", color: "#fff", border: "none" }}
            onClick={() => void runZip()} disabled={busy}>
            {busy ? t("anon.running") : t("anon.zip")}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 };
const dialog: React.CSSProperties = { width: 760, maxWidth: "96vw", maxHeight: "92vh", background: "#fff", borderRadius: 10, boxShadow: "0 12px 40px rgba(0,0,0,0.3)", display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: "system-ui, sans-serif", color: "#1a1a1a" };
const header: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #eee" };
const closeBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#666" };
const body: React.CSSProperties = { padding: "12px 16px", display: "flex", flexDirection: "column", gap: 12, overflow: "auto" };
const grpTitle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "#33404d", marginBottom: 4 };
const opt: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, cursor: "pointer", padding: "1px 0" };
const lbl: React.CSSProperties = { fontSize: 12, color: "#556" };
const inp: React.CSSProperties = { padding: "5px 8px", border: "1px solid #cdd5de", borderRadius: 5, fontSize: 13 };
const footer: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderTop: "1px solid #eee" };
const btn: React.CSSProperties = { padding: "6px 14px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" };
const miniBtn: React.CSSProperties = { minWidth: 28, padding: "4px 8px", border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 12 };
const chip: React.CSSProperties = { padding: "3px 10px", border: "1px solid #d7dde3", borderRadius: 12, background: "#fff", cursor: "pointer", fontSize: 12 };
const tag2: React.CSSProperties = { display: "inline-block", margin: "2px 4px 2px 0", padding: "2px 8px", background: "#eef2f6", borderRadius: 10, fontSize: 11.5 };
const x: React.CSSProperties = { marginLeft: 6, cursor: "pointer", color: "#b00020" };
