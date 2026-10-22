/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Fusion の演算結果（差分・乗算）を、画素値どうしの演算として新規シリーズに保存するダイアログ。
 *
 * <p>画面の「差分（表示）」「乗算（表示）」は見た目の合成で、画素値は変わらない。こちらは前景を背景の格子へ
 * 位置合わせ込みでリサンプルし、物理値（HU・SUV など）を直接演算して画像にする。保存形式の判断は
 * {@link planCalcStorage}（元のモダリティで持てるか／Modality=OT の Parametric Map にするか）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { metaData } from "@cornerstonejs/core";
import { useI18n } from "../i18n/i18n";
import type { Study, Series, Instance } from "../api";
import type { ViewerMode } from "../viewer/imageId";
import { loadRegVolume, type LoadedRegVolume } from "../viewer/regVolumeLoader";
import { GRID_EDGE_TOLERANCE, estimateGridBytes, resampleToGrid, type Grid } from "../viewer/gridResample";
import { composeTransforms, isZeroAdjust, manualAdjustToTransform, type ManualAdjust, type Vec3, type WorldTransform }
  from "../viewer/regTransform";
import { saveDerivedVolume } from "../viewer/derivedVolumeSave";
import { suvForImageId } from "../viewer/suvStore";
import { resolveValueUnit } from "../viewer/pixelCalibration";
import { getAppliedVolumeMaxMb } from "../viewer/volumeMemory";
import {
  FUSION_CALC_OPS, combineVolumes, countFinite, describeCalc, finiteMinOrNull, planCalcStorage,
  type FusionCalcOp,
} from "../viewer/fusionCalc";

export interface CalcSource {
  study: Study;
  series: Series;
  instances: Instance[];
  c: number;
  t: number;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function seriesName(s: Series): string {
  return s.seriesDescription || `#${s.seriesNumber ?? "?"} ${s.modality ?? ""}`.trim();
}

interface Loaded {
  readonly vol: LoadedRegVolume;
  readonly unit: string;
}

export function FusionCalcDialog({
  mode,
  background,
  foreground,
  registration,
  adjust,
  initialOp,
  onClose,
}: {
  mode: ViewerMode;
  /** 背景（タイルのシリーズ）。出力はこの格子・この患者・この検査に作る。 */
  background: CalcSource;
  /** 前景（Fusion のオーバーレイ）。背景の格子へリサンプルする。 */
  foreground: CalcSource;
  /** 自動位置合わせ（R3）の結果（fixed world → moving world）。無ければ null。 */
  registration: WorldTransform | null;
  /** 手動位置合わせ（R1）。 */
  adjust: ManualAdjust;
  initialOp: FusionCalcOp;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [bg, setBg] = useState<Loaded | null>(null);
  const [fg, setFg] = useState<Loaded | null>(null);
  const [loadMsg, setLoadMsg] = useState(t("resample.loading"));
  const [op, setOp] = useState<FusionCalcOp>(initialOp);
  const [descEdited, setDescEdited] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    (async () => {
      try {
        const load = async (src: CalcSource, label: string): Promise<Loaded | null> => {
          const vol = await loadRegVolume(mode, src.study.studyInstanceUid, src.series.seriesInstanceUid,
            src.instances, src.c, src.t,
            (n, all) => alive.current && setLoadMsg(`${label} ${t("resample.loading")} ${n}/${all}`));
          if (!vol) return null;
          return { vol, unit: vol.firstImageId ? resolveValueUnit(vol.firstImageId) : "" };
        };
        const b = await load(background, t("fusioncalc.bg"));
        if (!alive.current) return;
        if (!b) { setLoadMsg(`${t("fusioncalc.bg")}: ${t("resample.noGeometry")}`); setFailed(true); return; }
        const f = await load(foreground, t("fusioncalc.fg"));
        if (!alive.current) return;
        if (!f) { setLoadMsg(`${t("fusioncalc.fg")}: ${t("resample.noGeometry")}`); setFailed(true); return; }
        setBg(b);
        setFg(f);
      } catch (e) {
        if (alive.current) { setLoadMsg(`${t("resample.loadFailed")}: ${String(e)}`); setFailed(true); }
      }
    })();
    return () => { alive.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bgName = seriesName(background.series);
  const fgName = seriesName(foreground.series);
  const storage = useMemo(
    () => (bg && fg
      ? planCalcStorage(op, { unit: bg.unit, modality: bg.vol.modality }, { unit: fg.unit, modality: fg.vol.modality })
      : null),
    [bg, fg, op],
  );
  const defaultDesc = `${fgName} ${op === "mult" ? "x" : op === "absdiff" ? "|-|" : "-"} ${bgName}`.slice(0, 64);
  const description = descEdited ?? defaultDesc;

  // 出力の格子は背景そのもの（RegVolume は Grid の全項目を持つ）。
  const grid: Grid | null = bg ? bg.vol.volume : null;
  const mb = grid ? Math.round(estimateGridBytes(grid) / 1024 / 1024) : 0;

  const regNote = registration && !isZeroAdjust(adjust) ? t("fusioncalc.reg.both")
    : registration ? t("fusioncalc.reg.auto")
    : !isZeroAdjust(adjust) ? t("fusioncalc.reg.manual")
    : t("fusioncalc.reg.none");

  const onSave = async () => {
    if (!bg || !fg || !grid || !storage || busy) return;
    // 背景・前景（背景格子へ）・結果の 3 つが同時にメモリに載る。
    const limitMb = getAppliedVolumeMaxMb();
    const needMb = mb * 3;
    if (needMb > limitMb && !window.confirm(t("fusioncalc.confirmMemory", { mb: needMb, limit: limitMb }))) return;
    setBusy(true);
    setFailed(false);
    setMsg(t("resample.saving"));
    try {
      await tick(); // 「保存中」を描画してから重い計算に入る
      const fv = fg.vol.volume;
      // 手動調整の回転中心は前景ボリュームの中心（FusionOverlayViewer と同じ規約）。
      const m = fv.indexToWorld;
      const ci = (fv.dims[0] - 1) / 2, cj = (fv.dims[1] - 1) / 2, ck = (fv.dims[2] - 1) / 2;
      const center: Vec3 = [
        m[0] * ci + m[1] * cj + m[2] * ck + m[3],
        m[4] * ci + m[5] * cj + m[6] * ck + m[7],
        m[8] * ci + m[9] * cj + m[10] * ck + m[11],
      ];
      const manual = isZeroAdjust(adjust) ? null : manualAdjustToTransform(adjust, center);
      const composed = registration || manual ? composeTransforms(registration, manual) : null;
      const xf = composed && composed.kind !== "identity" ? composed : null;

      const fgOnBg = resampleToGrid(fv, xf, grid, GRID_EDGE_TOLERANCE);
      const result = combineVolumes(bg.vol.volume.data, fgOnBg, op);
      const overlap = countFinite(result);
      if (overlap === 0) { setMsg(t("fusioncalc.noOverlap")); setFailed(true); return; }

      const first = bg.vol.firstImageId ?? undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plane = first ? (metaData.get("imagePlaneModule", first) as any) : null;
      const th = Number(plane?.sliceThickness);
      const derivation = `${describeCalc(op, fgName, bgName)}. Registration: ${regNote}`;
      const common = {
        grid,
        data: result,
        studyUid: background.study.studyInstanceUid,
        seriesUid: background.series.seriesInstanceUid,
        seriesDescription: description.slice(0, 64),
        derivationDescription: derivation,
        sourceSliceThickness: Number.isFinite(th) && th > 0 ? th : null,
      };
      const res = storage.kind === "parametric"
        ? await saveDerivedVolume({
            ...common,
            background: NaN,
            parametricMap: {
              label: storage.label,
              explanation: describeCalc(op, fgName, bgName).slice(0, 64),
              unitCode: storage.unitCode,
              unitMeaning: storage.unitMeaning,
            },
          })
        : await saveDerivedVolume({
            ...common,
            // SUV 校正中の値は SUV。割り戻しは buildDerivedVolumeRequest が 1 回だけ行う（ResampleDialog と同じ契約）。
            suvScale: suvForImageId(first)?.scale ?? null,
            // 前景の範囲外（NaN）の埋め値。0 は「差が無い」に見えるので、有限な結果の最小値をパディングとして明示する。
            background: finiteMinOrNull(result) ?? 0,
          });
      if (alive.current) {
        const pct = Math.round((overlap / result.length) * 100);
        setMsg(t("fusioncalc.saved", { n: res.count, pct }));
      }
    } catch (e) {
      if (alive.current) { setMsg(`${t("resample.saveFailed")}: ${String(e)}`); setFailed(true); }
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const storageText = !storage ? ""
    : storage.kind === "derived"
      ? t("fusioncalc.store.derived", { modality: bg?.vol.modality ?? "", unit: bg?.unit || "-" })
      : t("fusioncalc.store.pm", { unit: storage.unitMeaning });

  return (
    <div style={backdrop} data-testid="fusion-calc-dialog">
      <div style={panel}>
        <div style={header}>{t("fusioncalc.title")}</div>
        <div style={note} data-testid="fusion-calc-note">{t("fusioncalc.note")}</div>
        <div style={{ fontSize: 12, color: "#c8d2dc" }} data-testid="fusion-calc-source">
          {bg && fg
            ? <>
                {t("fusioncalc.bg")}: {bgName} ({bg.vol.modality} / {bg.unit || "-"}) {bg.vol.volume.dims.join("×")}<br />
                {t("fusioncalc.fg")}: {fgName} ({fg.vol.modality} / {fg.unit || "-"})
              </>
            : loadMsg}
        </div>
        <div style={{ fontSize: 12, color: "#c8d2dc" }} data-testid="fusion-calc-reg">
          {t("fusioncalc.reg")}: {regNote}
        </div>
        {FUSION_CALC_OPS.map((o) => (
          <label key={o} style={row}>
            <input type="radio" checked={op === o} onChange={() => setOp(o)} disabled={busy}
              data-testid={`fusion-calc-op-${o}`} />
            {t(`fusioncalc.op.${o}`)}
          </label>
        ))}
        <label style={row}>
          {t("fusioncalc.desc")}
          <input style={{ ...num, flex: 1, width: "auto" }} value={description} maxLength={64} disabled={busy}
            onChange={(e) => setDescEdited(e.target.value)} data-testid="fusion-calc-desc" />
        </label>
        <div style={{ fontSize: 12, color: "#c8d2dc" }} data-testid="fusion-calc-output">
          {grid && storage
            ? <>{t("fusioncalc.output", { cols: grid.dims[0], rows: grid.dims[1], n: grid.dims[2], mb })}<br />{storageText}</>
            : ""}
        </div>
        {msg && (
          <div style={{ fontSize: 12, color: failed ? "#e8a0a0" : "#9fd0ff" }} data-testid="fusion-calc-message">{msg}</div>
        )}
        <div style={footer}>
          <button type="button" onClick={onClose} style={btn} data-testid="fusion-calc-close">{t("resample.close")}</button>
          <button type="button" onClick={onSave} disabled={!bg || !fg || busy} style={btnPrimary}
            data-testid="fusion-calc-save">
            {t("resample.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

const backdrop: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200,
};
const panel: React.CSSProperties = {
  background: "#1a2129", border: "1px solid #2c3742", borderRadius: 8, padding: 14,
  minWidth: 460, maxWidth: 560, display: "flex", flexDirection: "column", gap: 10, color: "#e8edf2",
};
const header: React.CSSProperties = { fontWeight: 600, fontSize: 14 };
const note: React.CSSProperties = {
  fontSize: 12, color: "#c8d2dc", background: "#212b35", border: "1px solid #2c3742", borderRadius: 4, padding: "6px 8px",
};
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontSize: 12 };
const num: React.CSSProperties = {
  width: 60, background: "#0f151b", color: "#e8edf2", border: "1px solid #2c3742", borderRadius: 4, padding: "2px 4px",
};
const footer: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 };
const btn: React.CSSProperties = {
  background: "#26303a", color: "#e8edf2", border: "1px solid #2c3742", borderRadius: 4, padding: "4px 12px", cursor: "pointer",
};
const btnPrimary: React.CSSProperties = { ...btn, background: "#2b8aef", border: "1px solid #2b8aef", color: "#fff" };
