/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Texture（Radiomics 可視化マップ）ダイアログ。SUV 校正ダイアログと同型の設定モーダル。
 *
 * <p>ターゲットシリーズ（＋任意マスク）と特徴・カーネル・stride・2D/3D を指定して
 * {@code POST /api/series/texture} を呼び、計算された可視化マップ（派生シリーズ）を保存する。
 * Radiomics の各種パラメータは環境設定 Settings ▸ Texture（{@code texture.*} キー）から取得する。
 * バッチ処理は対象外（単一マップのみ）。設計 {@code fw/texture-radiomics-design.md}。
 */
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { fetchSeries, fetchSeriesLayout, createTextureMap, type Series, type Study } from "../api";
import { fetchSettings } from "../settings/settingsApi";
import { TEXTURE_FAMILIES } from "./textureFeatures";

export function TextureDialog({
  study,
  series,
  onCreated,
  onClose,
}: {
  study: Study;
  series: Series;
  /** 生成成功時、新シリーズ UID を通知（呼び出し側でタイル表示）。 */
  onCreated: (seriesInstanceUid: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();

  const [familyKey, setFamilyKey] = useState(TEXTURE_FAMILIES[0].key);
  const family = useMemo(() => TEXTURE_FAMILIES.find((f) => f.key === familyKey)!, [familyKey]);
  const [feature, setFeature] = useState(TEXTURE_FAMILIES[0].features[0]);
  const [targetSeriesUid, setTargetSeriesUid] = useState(series.seriesInstanceUid);
  const [maskSeriesUid, setMaskSeriesUid] = useState<string>("");
  const [maskChannel, setMaskChannel] = useState(0);
  const [maskNC, setMaskNC] = useState(1);
  const [kernel, setKernel] = useState(7);
  const [stride, setStride] = useState(1);
  const [force2D, setForce2D] = useState(false); // 既定は 3D base
  const [channel, setChannel] = useState(0);
  const [timePoint, setTimePoint] = useState(0);
  const [nC, setNC] = useState(1);
  const [nT, setNT] = useState(1);

  const [allSeries, setAllSeries] = useState<Series[]>([series]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ターゲット候補＝同一 study の全シリーズ。マスク候補はターゲットを除いたもの。
  const maskCandidates = useMemo(
    () => allSeries.filter((s) => s.seriesInstanceUid !== targetSeriesUid),
    [allSeries, targetSeriesUid],
  );

  // study のシリーズ一覧＋保存済み Radiomics 設定を取得。
  useEffect(() => {
    let cancelled = false;
    void fetchSeries(study.studyInstanceUid)
      .then((list) => {
        if (!cancelled && list.length) setAllSeries(list);
      })
      .catch(() => {});
    void fetchSettings()
      .then((raw) => {
        if (cancelled) return;
        // "texture.<KEY>" → "<KEY>" に変換して backend へ渡す。
        const s: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw)) {
          if (k.startsWith("texture.")) s[k.slice("texture.".length)] = v;
        }
        setSettings(s);
        if (s.D3Basis !== undefined) setForce2D(s.D3Basis !== "true");
      })
      .catch(() => {});
  }, [study.studyInstanceUid]);

  // ターゲット変更でマルチ次元スタック（C/T）の有無を取得し、C/T を初期化。マスクがターゲットと一致したら解除。
  useEffect(() => {
    let cancelled = false;
    setChannel(0);
    setTimePoint(0);
    if (maskSeriesUid === targetSeriesUid) setMaskSeriesUid("");
    void fetchSeriesLayout(study.studyInstanceUid, targetSeriesUid)
      .then((layout) => {
        if (cancelled) return;
        setNC(Math.max(1, layout.nC));
        setNT(Math.max(1, layout.nT));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [study.studyInstanceUid, targetSeriesUid]);

  // マスク変更でマスクの C 次元数（SEG マルチセグメント）を取得。未選択は 1。
  useEffect(() => {
    let cancelled = false;
    setMaskChannel(0);
    if (!maskSeriesUid) {
      setMaskNC(1);
      return;
    }
    void fetchSeriesLayout(study.studyInstanceUid, maskSeriesUid)
      .then((layout) => {
        if (!cancelled) setMaskNC(Math.max(1, layout.nC));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [study.studyInstanceUid, maskSeriesUid]);

  // ファミリー変更で特徴を先頭にリセット。
  useEffect(() => {
    setFeature(family.features[0]);
  }, [family]);

  const onRun = async () => {
    setError(null);
    if (!(kernel >= 3 && kernel <= 99)) return setError(t("texture.err.kernel"));
    if (!(stride >= 1 && stride <= 32)) return setError(t("texture.err.stride"));
    setBusy(true);
    try {
      const res = await createTextureMap({
        studyInstanceUid: study.studyInstanceUid,
        sourceSeriesUid: targetSeriesUid,
        maskSeriesUid: maskSeriesUid || null,
        maskChannel,
        feature: `${family.key}_${feature}`,
        filterSize: kernel,
        stride,
        force2D,
        channel,
        timePoint,
        settings,
        seriesDescription: null,
        seriesNumber: null,
      });
      onCreated(res.seriesInstanceUid);
      onClose();
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const seriesLabel = (s: Series) =>
    `#${s.seriesNumber ?? "?"} ${s.modality ?? ""} ${s.seriesDescription ?? ""}`.trim();

  return (
    <div style={overlay} onMouseDown={busy ? undefined : onClose}>
      <div style={panel} onMouseDown={(e) => e.stopPropagation()}>
        <div style={header}>{t("texture.title")}</div>

        <Field label={t("texture.field.target")}>
          <select value={targetSeriesUid} onChange={(e) => setTargetSeriesUid(e.target.value)} disabled={busy} style={input}>
            {allSeries.map((s) => (
              <option key={s.seriesInstanceUid} value={s.seriesInstanceUid}>{seriesLabel(s)}</option>
            ))}
          </select>
        </Field>

        {/* ターゲットが C/T 次元を持つ場合のみ、Target 直下に選択欄を表示。 */}
        {nC > 1 && (
          <Field label={t("texture.field.targetC")}>
            <select value={channel} onChange={(e) => setChannel(Number(e.target.value))} disabled={busy} style={input}>
              {Array.from({ length: nC }, (_, i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </Field>
        )}
        {nT > 1 && (
          <Field label={t("texture.field.targetT")}>
            <select value={timePoint} onChange={(e) => setTimePoint(Number(e.target.value))} disabled={busy} style={input}>
              {Array.from({ length: nT }, (_, i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </Field>
        )}

        <Field label={t("texture.field.mask")}>
          <select value={maskSeriesUid} onChange={(e) => setMaskSeriesUid(e.target.value)} disabled={busy} style={input}>
            <option value="">{t("texture.mask.none")}</option>
            {maskCandidates.map((s) => (
              <option key={s.seriesInstanceUid} value={s.seriesInstanceUid}>{seriesLabel(s)}</option>
            ))}
          </select>
        </Field>

        {/* マスクがマルチチャンネル（DICOM SEG マルチセグメント等）のときのみ選択可能に。 */}
        {maskSeriesUid !== "" && maskNC > 1 && (
          <Field label={t("texture.field.maskChannel")}>
            <select value={maskChannel} onChange={(e) => setMaskChannel(Number(e.target.value))} disabled={busy} style={input}>
              {Array.from({ length: maskNC }, (_, i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </Field>
        )}

        <Field label={t("texture.field.family")}>
          <select value={familyKey} onChange={(e) => setFamilyKey(e.target.value)} disabled={busy} style={input}>
            {TEXTURE_FAMILIES.map((f) => (
              <option key={f.key} value={f.key}>{f.label}</option>
            ))}
          </select>
        </Field>
        <Field label={t("texture.field.feature")}>
          <select value={feature} onChange={(e) => setFeature(e.target.value)} disabled={busy} style={input}>
            {family.features.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </Field>

        <Field label={t("texture.field.kernel")}>
          <input type="number" min={3} max={99} step={2} value={kernel}
            onChange={(e) => setKernel(Number(e.target.value))} disabled={busy} style={input} />
        </Field>
        <Field label={t("texture.field.stride")}>
          <input type="number" min={1} max={32} value={stride}
            onChange={(e) => setStride(Number(e.target.value))} disabled={busy} style={input} />
        </Field>
        <Field label={t("texture.field.dim")}>
          <select value={force2D ? "2d" : "3d"} onChange={(e) => setForce2D(e.target.value === "2d")} disabled={busy} style={input}>
            <option value="2d">{t("texture.dim.2d")}</option>
            <option value="3d">{t("texture.dim.3d")}</option>
          </select>
        </Field>

        <div style={{ color: "#6b7785", fontSize: 11, marginTop: 6 }}>{t("texture.paramsNote")}</div>
        {error && <div style={errText}>{error}</div>}

        {/* 計算中の不定プログレスバー（同期 POST のため進捗は不定）。 */}
        {busy && (
          <div style={progressTrack}>
            <div style={progressBar} />
            <style>{"@keyframes texbar{0%{left:-40%}100%{left:100%}}"}</style>
          </div>
        )}

        <div style={{ display: "flex", gap: 6, marginTop: 12, justifyContent: "flex-end" }}>
          <button onClick={onClose} disabled={busy} style={btn}>{t("common.cancel")}</button>
          <button onClick={onRun} disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }}>
            {busy ? t("texture.running") : t("texture.run")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={fieldRow}>
      <span style={fieldLabel}>{label}</span>
      <span style={fieldValue}>{children}</span>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,0.35)",
  display: "flex", alignItems: "center", justifyContent: "center",
};
const panel: React.CSSProperties = {
  width: 420, maxHeight: "90vh", overflowY: "auto",
  background: "#fff", border: "1px solid #cfd8e2", borderRadius: 8,
  boxShadow: "0 12px 40px rgba(0,0,0,0.25)", padding: 16, fontSize: 12, color: "#222",
};
const header: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: "#0b5cad", marginBottom: 10 };
const fieldRow: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "4px 0" };
const fieldLabel: React.CSSProperties = { color: "#5a6672", flex: "none", minWidth: 150 };
const fieldValue: React.CSSProperties = { flex: 1, textAlign: "right" };
const input: React.CSSProperties = { width: "100%", boxSizing: "border-box", border: "1px solid #cdd5de", borderRadius: 4, fontSize: 12, padding: "3px 6px" };
const errText: React.CSSProperties = { color: "#b00020", marginTop: 8 };
const progressTrack: React.CSSProperties = {
  position: "relative", height: 6, marginTop: 10, borderRadius: 3,
  background: "#e1e7ee", overflow: "hidden",
};
const progressBar: React.CSSProperties = {
  position: "absolute", top: 0, height: "100%", width: "40%", borderRadius: 3,
  background: "#0b5cad", animation: "texbar 1.1s linear infinite",
};
const btn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, padding: "5px 12px" };
const btnPrimary: React.CSSProperties = { ...btn, background: "#0b5cad", border: "1px solid #0b5cad", color: "#fff" };
