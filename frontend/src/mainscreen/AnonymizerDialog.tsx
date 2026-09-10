/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  anonymizeCopy,
  anonymizeZip,
  clearAnonMask,
  fetchAnonMasks,
  fetchAnonProfiles,
  fetchSeries,
  fetchStudies,
  fetchTagDictionary,
  registerAnonMask,
  type AnonMaskPolygon,
  type AnonOption,
  type AnonProfile,
  type AnonRequest,
  type AnonSeriesMask,
  type Series,
  type Study,
  type StudyFilters,
  type TagDictEntry,
} from "../api";
import { HttpError } from "../http";
import { desktop } from "../desktopBridge";
import { useI18n } from "../i18n/i18n";
import { dictMap, ggggeeee, normHex } from "./tagPathUtil";
import { CLEAN_OPTS, DEFAULT_ANON_OPTIONS, RETAIN_OPTS, sanitizeAnonOptions, toggleAnonOption } from "./anonDefaults";
import { loadAnonRoiCandidates, type AnonRoiCandidate, type AnonRoiSkip } from "./anonRoiCandidates";

/**
 * その ROI の多角形が**いま登録されているか**。チェックの初期状態をここから起こす。
 *
 * <p>頂点はサブピクセルのまま往復する（丸めない）ので、厳密一致でよい。丸め幅を持たせると
 * 「別の場所を塗るマスク」を同一と見なしかねない。
 */
function isRegistered(c: AnonRoiCandidate, registered: readonly AnonSeriesMask[]): boolean {
  const m = registered.find((x) => x.seriesUid === c.seriesUid);
  return (m?.polygons ?? []).some(
    (p) =>
      p.xs.length === c.polygon.xs.length &&
      p.xs.every((v, i) => v === c.polygon.xs[i]) &&
      p.ys.every((v, i) => v === c.polygon.ys[i]) &&
      String(p.sopInstanceUids) === String(c.polygon.sopInstanceUids) &&
      String(p.frames) === String(c.polygon.frames),
  );
}

/**
 * Anonymizer（PS3.15）。検索リスト全体を匿名化（属性＋任意で Pixel 焼き込み）して ZIP/フォルダ出力。
 * オプション・新 PatientName/ID・個別保持/カスタム値・プロファイル保存/読込。
 */
export function AnonymizerDialog({
  open,
  onClose,
  study,
  filters,
  mode,
}: {
  open: boolean;
  onClose: () => void;
  /** 匿名化の対象スタディ（MainScreen で選択中の 1 件）。未選択なら null。 */
  study: Study | null;
  filters: StudyFilters | null;
  mode: string;
}) {
  const { t } = useI18n();
  const isWeb = mode === "web";
  const [dict, setDict] = useState<TagDictEntry[]>([]);
  const dmap = useMemo(() => dictMap(dict), [dict]);
  const [profiles, setProfiles] = useState<AnonProfile[]>([]);

  const [options, setOptions] = useState<Set<AnonOption>>(new Set(DEFAULT_ANON_OPTIONS));
  const [patName, setPatName] = useState("de-identified");
  const [patId, setPatId] = useState("de-identified");
  const [seed, setSeed] = useState("");
  const [manualRetain, setManualRetain] = useState<string[]>([]);
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [burnIn, setBurnIn] = useState(false);
  // 既定は「選択中のスタディ 1 件」。検索結果全体を一括で処理したいときだけ明示的に ON にする。
  const [wholeList, setWholeList] = useState(false);
  const [destination, setDestination] = useState<string | null>(null);
  /**
   * 登録済みの焼き込みマスク（旧 GRAPHY の "Mask ROIs" リストに相当）。
   *
   * ⚠ backend のプロセス内メモリにしか無く**再起動で消える**。一覧が無いと「消えたこと」に
   * 気づけないので、件数 0 も含めて必ず見せる。
   */
  const [masks, setMasks] = useState<AnonSeriesMask[]>([]);
  const [seriesList, setSeriesList] = useState<Series[]>([]);
  /**
   * 焼き込みに使える保存済み ROI（2D ビューアで描いた面 ROI）。
   *
   * <p>以前は 2D ビューアの ROI マネージャから登録していたが、匿名化をする画面はここなので
   * **この画面で選べるようにした**。ROI は患者単位で自動保存されているので、
   * ウィンドウを跨がずに読める（`anonRoiCandidates.ts`）。
   */
  const [roiCands, setRoiCands] = useState<AnonRoiCandidate[]>([]);
  const [roiSkips, setRoiSkips] = useState<AnonRoiSkip[]>([]);
  const [roiChecked, setRoiChecked] = useState<Set<string>>(new Set());
  const [roiLoading, setRoiLoading] = useState(false);

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

  // 選択中スタディのシリーズを引き、そのシリーズに付いているマスクを読む。
  // 🔴 マスクはシリーズ単位なので、スタディの外に登録されたマスクはここには出ない
  //    （出しても対象外なので、黙って効くことはない）。
  const reloadMasks = useCallback(async (): Promise<AnonSeriesMask[]> => {
    const studyUid = study?.studyInstanceUid;
    if (!studyUid) { setSeriesList([]); setMasks([]); return []; }
    try {
      const ss = await fetchSeries(studyUid);
      setSeriesList(ss);
      const uids = ss.map((x) => x.seriesInstanceUid);
      const found = uids.length ? await fetchAnonMasks(uids) : [];
      setMasks(found);
      // 登録内容は ROI 一覧のチェック状態の出どころでもあるので、呼び出し側へ返す
      // （state を読み直すと 1 レンダ遅れて「登録したのにチェックが付かない」ように見える）。
      return found;
    } catch {
      setSeriesList([]);
      setMasks([]);
      return [];
    }
  }, [study?.studyInstanceUid]);

  useEffect(() => {
    if (!open) return;
    void reloadMasks();
  }, [open, reloadMasks]);

  /**
   * 保存済み ROI を読み直し、**いま登録されているマスクと一致する ROI にチェックを入れる**。
   *
   * <p>チェックの初期状態を登録内容から起こすので、ダイアログを開き直しても
   * 「何が焼き込まれるのか」が画面と一致する。backend を再起動してマスクが消えていれば
   * チェックも外れて見える＝**消えたことに気付ける**。
   */
  const reloadRoiCandidates = useCallback(async (registered: AnonSeriesMask[]) => {
    if (!study || isWeb) { setRoiCands([]); setRoiSkips([]); setRoiChecked(new Set()); return; }
    setRoiLoading(true);
    try {
      const ss = seriesList.length ? seriesList : await fetchSeries(study.studyInstanceUid);
      const { candidates, skipped } = await loadAnonRoiCandidates(study, ss);
      setRoiCands(candidates);
      setRoiSkips(skipped);
      const already = new Set(
        candidates.filter((c) => isRegistered(c, registered)).map((c) => c.roiUid),
      );
      setRoiChecked(already);
    } catch {
      // ROI が 1 件も保存されていない患者では 200 で空が返るので、ここに来るのは通信不良。
      setRoiCands([]);
      setRoiSkips([]);
      setRoiChecked(new Set());
    } finally {
      setRoiLoading(false);
    }
  }, [study, isWeb, seriesList]);

  // 焼き込み節が出るときだけ ROI を読む（Clean Pixel Data を使わない人には要らない問い合わせ）。
  const cleanPixel = options.has("CleanPixelData");
  useEffect(() => {
    if (!open || !cleanPixel) return;
    void (async () => {
      const registered = await reloadMasks();
      await reloadRoiCandidates(registered);
    })();
    // reloadRoiCandidates は seriesList に依存するが、ここで依存に入れると
    // reloadMasks が seriesList を更新するたびに読み直しが走って往復し続ける。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cleanPixel, study?.studyInstanceUid]);

  if (!open) return null;

  // 日付の 2 つだけは相互排他（両方 ON にすると加工が保持に勝ち、日付が潰れる）。
  // 判定は anonDefaults の純関数へ（.tsx は vitest の対象外なのでここには書けない）。
  const toggleOpt = (o: AnonOption) => setOptions((s) => toggleAnonOption(s, o));

  const applyProfile = (p: AnonProfile) => setOptions(applySanitized(p.options ?? []));

  /** 排他規則に合わせて直しつつ、直したことを利用者に見せる。 */
  const applySanitized = (opts: AnonOption[]): Set<AnonOption> => {
    const { options: next, dropped } = sanitizeAnonOptions(opts);
    if (dropped.length) setInfo(t("anon.dateOpts.adjusted"));
    return next;
  };

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

  /**
   * 匿名化の対象 studyUid を決める。
   *
   * 🔴 既定は**選択中のスタディ 1 件だけ**（2026-08-20 に変更）。
   * それ以前は常に「検索結果全体」で、スタディを 1 件選んで開いても**リスト全部**が
   * 出力されていた（実測で 6170 インスタンス／83MB が一度に出た）。選択したものだけが
   * 処理されると誤解しやすく、意図しない症例まで書き出す事故につながるため既定を変えた。
   * 一括処理は `wholeList` を明示的に ON にしたときだけ。
   */
  const resolveStudyUids = async (): Promise<string[] | null> => {
    if (!wholeList) {
      if (!study) { setError(t("anon.err.noStudy")); return null; }
      return [study.studyInstanceUid];
    }
    if (!filters) { setError(t("tagext.err.noSearch")); return null; }
    const studies = await fetchStudies(filters);
    if (studies.length === 0) { setError(t("tagext.err.noStudies")); return null; }
    return studies.map((s) => s.studyInstanceUid);
  };

  const maskCount = masks.reduce((n, m) => n + (m.polygons?.length ?? 0) + (m.rects?.length ?? 0), 0);

  /** マスクのシリーズを人が読める形に（UID だけでは対象が分からない）。 */
  const seriesLabel = (seriesUid: string): string => {
    const se = seriesList.find((x) => x.seriesInstanceUid === seriesUid);
    if (!se) return seriesUid;
    const num = se.seriesNumber != null ? `${se.seriesNumber}: ` : "";
    return `${num}${se.seriesDescription ?? se.modality ?? seriesUid}`;
  };


  /**
   * チェックした ROI を**シリーズ単位で置き換え**登録する。
   *
   * <p>🔴 追記ではなく置き換え。以前の「押すたびに追記」では同じ ROI を二度押すと多角形が
   * 重複し、**個別に外す手段が無かった**（シリーズ丸ごと消すしかなかった）。
   * チェックを外して押せば減る、が守れるのは置き換えだけ。
   *
   * <p>候補が 1 件も無いシリーズには触らない（この画面の外で登録されたマスクを巻き込まない）。
   */
  const applyRoiMasks = async () => {
    setBusy(true);
    setError(null);
    try {
      const bySeries = new Map<string, AnonMaskPolygon[]>();
      for (const c of roiCands) {
        if (!bySeries.has(c.seriesUid)) bySeries.set(c.seriesUid, []);
        if (roiChecked.has(c.roiUid)) bySeries.get(c.seriesUid)!.push(c.polygon);
      }
      for (const [seriesUid, polygons] of bySeries) {
        await registerAnonMask({ seriesUid, frames: [], rects: [], polygons });
      }
      const fresh = await reloadMasks();
      await reloadRoiCandidates(fresh);
      setInfo(t("anon.masks.applied", { count: roiChecked.size }));
    } catch (e) {
      showFailure(e);
    } finally {
      setBusy(false);
    }
  };

  /** マスクを消す（seriesUid 省略で全消去）。 */
  const removeMasks = async (seriesUid?: string) => {
    setBusy(true);
    try {
      await clearAnonMask(seriesUid);
      await reloadMasks();
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally { setBusy(false); }
  };

  /**
   * 失敗の見せ方。
   *
   * 🔴 **意図して止めたもの（400/409）を「取得に失敗しました」と出さない。** マスク未登録や
   * 設定の矛盾で中止したのは異常ではなく、こちらが安全側に倒した結果。backend が本文の
   * {message} に日本語の理由を載せているので、それをそのまま見せる（実機で「生の JSON が
   * 途中で切れて理由が読めない」状態になっていたのを直した・2026-09-07）。
   */
  const showFailure = (e: unknown) => {
    if (e instanceof HttpError && e.status >= 400 && e.status < 500) {
      setError(e.message);
      return;
    }
    setError(t("common.fetchError", { error: String(e) }));
  };

  const runZip = async () => {
    setBusy(true); setError(null); setInfo(null);
    try {
      const ids = await resolveStudyUids();
      if (!ids) return;
      const { blob, filename, instances, problems } = await anonymizeZip(buildReq(ids));
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      // revoke はダウンロード開始後まで遅らせる（即時に revoke すると環境によって 0 バイトになる）。
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setInfo(t("anon.zipped.count", { instances, bytes: blob.size }));
      if (problems > 0) setError(t("anon.err.problems", { problems }));
    } catch (e) {
      showFailure(e);
    } finally { setBusy(false); }
  };

  const runCopy = async () => {
    if (!destination) { setError(t("anon.err.noDest")); return; }
    setBusy(true); setError(null); setInfo(null);
    try {
      const ids = await resolveStudyUids();
      if (!ids) return;
      const r = await anonymizeCopy(buildReq(ids));
      let done = t("anon.copied", { instances: r.instances, burned: r.burnedInstances });
      // 日付をずらしたなら、使った種を必ず見せる。控えていないと後日の追加出力で
      // 日付が別方向にずれ、前回の出力と時間軸が合わなくなる。
      if (options.has("RetainLongitudinalTemporalInformationModifiedDates")) {
        done += " " + t("anon.usedSeed", { seed: r.usedSeed });
      }
      setInfo(done);
      // 焼き込みを頼まれたのに塗れなかったぶんは、出力に焼き込み文字が残っている。
      // 申告していないので DICOM としては正直だが、利用者は気づけないので必ず出す。
      // ⚠ errors と両方出うるので、片方で上書きしない（警告のほうが重要度が高い）。
      const notes: string[] = [];
      if (r.notBurnedInstances > 0) {
        notes.push(t("anon.burnIn.warn.notBurned", { count: r.notBurnedInstances }));
      }
      if (r.errors.length) notes.push(r.errors.slice(0, 3).join(" / "));
      if (notes.length) setError(notes.join(" / "));
    } catch (e) {
      showFailure(e);
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
      setOptions(applySanitized(p.options ?? []));
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
      <div data-testid="anonymizer-dialog" style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>{t("anon.title")}</span>
          <button data-testid="dialog-close-button" style={closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={body}>
          {/* 対象の明示。何が出力されるのかを押す前に読めるようにする。 */}
          <div style={{ fontSize: 12, color: "#6b7785" }}>
            <div data-testid="anon-scope-text">
              {wholeList
                ? t("anon.scope.wholeList")
                : study
                  ? t("anon.scope.study", {
                      patientId: study.patientId || "—",
                      description: study.studyDescription || study.studyDate || study.studyInstanceUid,
                    })
                  : t("anon.scope.none")}
            </div>
            <label style={{ ...opt, marginTop: 4 }}>
              <input data-testid="anon-whole-list" type="checkbox" checked={wholeList}
                onChange={(e) => setWholeList(e.target.checked)} />
              {t("anon.scope.wholeListToggle")}
            </label>
          </div>

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
                  <input data-testid={`anon-opt-${o}`} type="checkbox" checked={options.has(o)} onChange={() => toggleOpt(o)} />
                  {t(`anon.opt.${o}`)}
                </label>
              ))}
            </div>
          </div>

          {/* 患者置換 + seed */}
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span style={lbl}>{t("anon.newName")}</span>
            <input data-testid="anon-new-name-input" style={inp} value={patName} onChange={(e) => setPatName(e.target.value)} />
            <span style={lbl}>{t("anon.newId")}</span>
            <input data-testid="anon-new-id-input" style={inp} value={patId} onChange={(e) => setPatId(e.target.value)} />
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
          {options.has("CleanPixelData") && !isWeb && (
            <div style={maskBox} data-testid="anon-mask-roi-list">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <b style={{ fontSize: 12 }}>{t("anon.masks.fromRoi")}</b>
                <span>
                  <button
                    style={{ ...btn, padding: "2px 8px" }}
                    disabled={busy || roiLoading}
                    onClick={() => void (async () => { const r = await reloadMasks(); await reloadRoiCandidates(r); })()}
                  >
                    {t("anon.masks.reload")}
                  </button>
                  <button
                    style={{ ...btn, padding: "2px 8px", marginLeft: 6 }}
                    data-testid="anon-mask-apply"
                    disabled={busy || roiLoading || roiCands.length === 0}
                    onClick={() => void applyRoiMasks()}
                  >
                    {t("anon.masks.apply")}
                  </button>
                </span>
              </div>
              {roiLoading && <div style={{ fontSize: 11, color: "#8a98a6", marginTop: 4 }}>{t("common.loading")}</div>}
              {!roiLoading && roiCands.length === 0 && (
                <div style={{ fontSize: 11, color: "#8a98a6", marginTop: 4 }}>{t("anon.masks.roiEmpty")}</div>
              )}
              {roiCands.map((c) => (
                <label key={c.roiUid} style={maskRow} data-testid="anon-mask-roi-row">
                  <input
                    type="checkbox"
                    checked={roiChecked.has(c.roiUid)}
                    disabled={busy}
                    onChange={(e) => setRoiChecked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(c.roiUid); else next.delete(c.roiUid);
                      return next;
                    })}
                  />
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }} title={c.tool}>
                    {c.label}
                  </span>
                  <span style={{ color: "#8a98a6" }}>{c.seriesLabel}</span>
                </label>
              ))}
              {roiSkips.length > 0 && (
                <div style={{ fontSize: 11, color: "#8a98a6", marginTop: 4 }}>
                  {t("anon.masks.roiSkipped", { count: roiSkips.length })}
                </div>
              )}
            </div>
          )}
          {options.has("CleanPixelData") && (
            <div style={maskBox}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <b style={{ fontSize: 12 }}>{t("anon.masks")} ({maskCount})</b>
                <button style={{ ...btn, padding: "2px 8px" }} disabled={busy || maskCount === 0}
                  onClick={() => void removeMasks()}>{t("anon.masks.clear")}</button>
              </div>
              {maskCount === 0 ? (
                <div style={{ fontSize: 11, color: "#8a98a6", marginTop: 4 }}>{t("anon.masks.empty")}</div>
              ) : (
                masks.map((m) => (
                  <div key={m.seriesUid} style={maskRow}>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}
                      title={m.seriesUid}>{seriesLabel(m.seriesUid)}</span>
                    <span style={{ color: "#8a98a6" }}>
                      {t("anon.masks.shapes", { count: (m.polygons?.length ?? 0) + (m.rects?.length ?? 0) })}
                    </span>
                    <button style={{ ...btn, padding: "2px 8px" }} disabled={busy}
                      onClick={() => void removeMasks(m.seriesUid)}>{t("common.delete")}</button>
                  </div>
                ))
              )}
            </div>
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
          {/*
            🔴 折り返す。以前は nowrap + ellipsis で 1 行に詰めていたため、
            「なぜ中止したか」の説明が途中で切れて読めなかった（実機で発覚・2026-09-07）。
            止めた理由が読めないと、利用者は不具合と区別できない。
          */}
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, overflowWrap: "anywhere" }}>
            {info && <span data-testid="anon-info-message" style={{ color: "#2e5d27" }}>{info}</span>}
            {error && <span data-testid="anon-error-message" style={{ color: "#b00020" }}>{error}</span>}
            {isWeb && <span style={{ color: "#a85b00" }}>{t("anon.webNote")}</span>}
          </div>
          {!isWeb && (
            <>
              <button data-testid="anon-pick-dest-btn" style={btn} onClick={() => void pickDest()} title={destination ?? ""}>{t("anon.pickDest")}</button>
              <button data-testid="anon-copy-btn" style={btn} onClick={() => void runCopy()} disabled={busy || !destination}>{t("anon.copy")}</button>
            </>
          )}
          <button style={btn} onClick={onClose}>{t("common.close")}</button>
          <button data-testid="anon-zip-btn" style={{ ...btn, background: busy ? "#9fb6cf" : "#0b5cad", color: "#fff", border: "none" }}
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
const maskBox: React.CSSProperties = {
  border: "1px solid #2c3a47", borderRadius: 4, padding: 6, marginTop: 4,
};
const maskRow: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, fontSize: 11, padding: "2px 0",
};
const opt: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, cursor: "pointer", padding: "1px 0" };
const lbl: React.CSSProperties = { fontSize: 12, color: "#556" };
const inp: React.CSSProperties = { padding: "5px 8px", border: "1px solid #cdd5de", borderRadius: 5, fontSize: 13 };
const footer: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderTop: "1px solid #eee" };
const btn: React.CSSProperties = { padding: "6px 14px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" };
const miniBtn: React.CSSProperties = { minWidth: 28, padding: "4px 8px", border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 12 };
const chip: React.CSSProperties = { padding: "3px 10px", border: "1px solid #d7dde3", borderRadius: 12, background: "#fff", cursor: "pointer", fontSize: 12 };
const tag2: React.CSSProperties = { display: "inline-block", margin: "2px 4px 2px 0", padding: "2px 8px", background: "#eef2f6", borderRadius: 10, fontSize: 11.5 };
const x: React.CSSProperties = { marginLeft: 6, cursor: "pointer", color: "#b00020" };
