/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// ROI 統計ダイアログの「体積の見積り」。径から球・楕円体の体積を見積もる（計算は viewer/volumeEstimate.ts）。
//
// 🔴 見積りは仮定（球・回転楕円体）に依存する。値の隣に仮定を必ず出し、診断に使わない旨を添える。
// 楕円体の 3 つ目の径（スライス方向）は ROI からは分からないので、利用者が入れる。
// 短径と同じにする選択肢は用意するが、既定にはしない（黙って仮定を足さない）。

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n/i18n";
import type { RoiGeometryStats } from "../viewer/roiStats";
import { getRoiMaskMeta, setRoiMaskMeta } from "../viewer/roiMaskStore";
import { describeEstimate, estimate, type EstimateKind } from "../viewer/volumeEstimate";
import { emitToast } from "../viewer/toast";

const toText = (v: number | undefined): string => (v === undefined || !Number.isFinite(v) ? "" : String(Number(v.toFixed(2))));
const toNum = (s: string): number => (s.trim() === "" ? NaN : Number(s));

export function VolumeEstimateBlock({ uid, geometry }: { uid: string; geometry: RoiGeometryStats }) {
  const { t, locale } = useI18n();
  const lang: "ja" | "en" = locale === "en" ? "en" : "ja";
  // 径の候補: 形状 ROI は長径・短径、線（開）は折れ線長。
  const longMm = geometry.longAxisMm ?? (geometry.kind === "line" ? geometry.perimeterMm : undefined);
  const shortMm = geometry.shortAxisMm;
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<EstimateKind>("ellipsoid");
  const [d1, setD1] = useState(toText(longMm));
  const [a, setA] = useState(toText(longMm));
  const [b, setB] = useState(toText(shortMm));
  const [c, setC] = useState("");
  const [savedTick, setSavedTick] = useState(0);

  // ROI を切り替えたら入力をその ROI の径で入れ直す（前の ROI の径を引きずらない）。
  useEffect(() => {
    setD1(toText(longMm));
    setA(toText(longMm));
    setB(toText(shortMm));
    setC("");
  }, [uid, longMm, shortMm]);

  const result = useMemo(
    () => (kind === "sphere" ? estimate("sphere", [toNum(d1)]) : estimate("ellipsoid", [toNum(a), toNum(b), toNum(c)])),
    [kind, d1, a, b, c],
  );
  const saved = useMemo(() => getRoiMaskMeta(uid)?.custom?.volumeEstimate, [uid, savedTick]);

  if (longMm === undefined && shortMm === undefined && !saved) return null; // 径が取れない ROI（点・未校正）には出さない

  const save = () => {
    if (!result) return;
    setRoiMaskMeta(uid, { custom: { volumeEstimate: describeEstimate(result, lang) } });
    setSavedTick((n) => n + 1);
    emitToast(t("roiStats.volEst.saved"));
  };

  return (
    <div style={box} data-testid="vol-estimate">
      <button style={head} onClick={() => setOpen((o) => !o)} data-testid="vol-estimate-toggle">
        {open ? "▾" : "▸"} {t("roiStats.volEst.title")}
      </button>
      {saved && <div style={dim} data-testid="vol-estimate-saved">{t("roiStats.volEst.savedValue")}: {saved}</div>}
      {open && (
        <>
          <div style={row}>
            <label style={lab}>
              <input type="radio" checked={kind === "sphere"} onChange={() => setKind("sphere")} data-testid="vol-kind-sphere" />
              {t("roiStats.volEst.sphere")}
            </label>
            <label style={lab}>
              <input type="radio" checked={kind === "ellipsoid"} onChange={() => setKind("ellipsoid")} data-testid="vol-kind-ellipsoid" />
              {t("roiStats.volEst.ellipsoid")}
            </label>
          </div>
          {kind === "sphere" ? (
            <div style={row}>
              <Field label={t("roiStats.volEst.diameter")} value={d1} onChange={setD1} testid="vol-d" />
            </div>
          ) : (
            <div style={row}>
              <Field label="a" value={a} onChange={setA} testid="vol-a" />
              <Field label="b" value={b} onChange={setB} testid="vol-b" />
              <Field label={t("roiStats.volEst.third")} value={c} onChange={setC} testid="vol-c" />
              <button style={mini} onClick={() => setC(b)} disabled={!b} data-testid="vol-c-eq-b">
                {t("roiStats.volEst.sameAsShort")}
              </button>
            </div>
          )}
          <div style={{ ...line, color: result ? "#1a3d1a" : "#8a6d00" }} data-testid="vol-result">
            {result ? describeEstimate(result, lang) : t(kind === "ellipsoid" ? "roiStats.volEst.needThird" : "roiStats.volEst.needDiameter")}
          </div>
          <div style={dim}>{t("roiStats.volEst.note")}</div>
          <div style={row}>
            <button style={mini} onClick={save} disabled={!result} data-testid="vol-save">
              {t("roiStats.volEst.save")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Field({ label, value, onChange, testid }: { label: string; value: string; onChange: (v: string) => void; testid: string }) {
  return (
    <label style={lab}>
      {label}
      <input
        type="number"
        min={0}
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={inp}
        data-testid={testid}
      />
      mm
    </label>
  );
}

const box: React.CSSProperties = { borderTop: "1px dashed #d5dbe1", marginTop: 6, paddingTop: 6, display: "flex", flexDirection: "column", gap: 4 };
const head: React.CSSProperties = { alignSelf: "flex-start", border: "none", background: "transparent", cursor: "pointer", fontWeight: 600, color: "#33404d", padding: 0 };
const row: React.CSSProperties = { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" };
const lab: React.CSSProperties = { display: "inline-flex", gap: 4, alignItems: "center" };
const inp: React.CSSProperties = { width: 72 };
const mini: React.CSSProperties = { padding: "2px 8px", cursor: "pointer" };
const line: React.CSSProperties = { lineHeight: 1.5, fontWeight: 600 };
const dim: React.CSSProperties = { color: "#8a95a1", lineHeight: 1.5 };
