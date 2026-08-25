/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * MPR ウィンドウ（P1）。1×3（AX | SAG | COR）で VolumeViewport を表示する。
 *
 * 起動: MainScreen が選択スタディ/シリーズを `localStorage("graphy-mpr-ctx")` に書き、
 * desktop=`openViewer("mpr")` / web=`window.open("#mpr")` で本画面（`App` の #mpr ルート）を開く。
 * ボリューム構築・チルト補正・ビューポート配線は `viewer/mpr.ts`。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { RenderingEngine, Enums, eventTarget } from "@cornerstonejs/core";
import {
  fetchSeries,
  fetchInstances,
  fetchSeriesLayout,
  prefetchSeries,
  type AppStatus,
  type Study,
  type Series,
} from "../api";
import { ensureCornerstoneInitialized } from "../viewer/cornerstoneSetup";
import { getAppliedVolumeMaxMb, isCacheSizeExceeded } from "../viewer/volumeMemory";
import { confirmVolumeMemory } from "../viewer/volumeMemoryGuard";
import { useDeviceClass } from "../mobile/useDeviceClass";
import { imageIdForInstance } from "../viewer/imageId";
import { stepViewportSlice } from "../viewer/sliceStep";
import { matchesShortcut } from "../shortcuts/registry";
import {
  buildMprVolume,
  setupMprViewports,
  teardownMpr,
  applyMprWl,
  resetMprWl,
  readMprOverlay,
  probeMpr,
  setMprTouchTool,
  type MprViewportIds,
  type MprOverlay,
  type MprProbe,
  type MprTouchTool,
} from "../viewer/mpr";
import { presetLabel } from "../viewer2d/wlPresets";
import { useWlPresets } from "../viewer2d/wlPresetStore";
import { useI18n } from "../i18n/i18n";

const ENGINE_ID = "graphy-mpr-engine";
const TOOL_GROUP_ID = "graphy-mpr-tg";
const VIEWPORT_IDS: MprViewportIds = {
  axial: "mpr-axial",
  sagittal: "mpr-sagittal",
  coronal: "mpr-coronal",
};

interface MprContext {
  study: Study;
  series?: Series;
  ts: number;
}

type Phase = "idle" | "loading" | "ready" | "error" | "unsupported";

/** 1 面表示のときに切り替える面（`fw/mobile-ui-design.md` §4.2）。 */
type PaneId = "axial" | "sagittal" | "coronal";
const PANES: { id: PaneId; labelKey: string }[] = [
  { id: "axial", labelKey: "mpr.axial" },
  { id: "sagittal", labelKey: "mpr.sagittal" },
  { id: "coronal", labelKey: "mpr.coronal" },
];

export function MprScreen({ status }: { status: AppStatus | null }) {
  const { t } = useI18n();
  const presets = useWlPresets();
  // 狭幅・タッチ端末では 3 面横並びが成立しないので 1 面＋面切替タブにする。
  // 判定は端末クラス（`mobile/useDeviceClass`）。手動でデスクトップ UI を選んでいれば 3 面のまま。
  const { uiMode } = useDeviceClass();
  const singlePane = uiMode === "mobile";
  const [activePane, setActivePane] = useState<PaneId>("axial");
  // モバイルの 1 本指タッチに割り当てるツール（ピンチ Zoom は常時有効・切替対象外）。
  const [touchTool, setTouchTool] = useState<MprTouchTool>("scroll");
  const axialRef = useRef<HTMLDivElement>(null);
  const sagittalRef = useRef<HTMLDivElement>(null);
  const coronalRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<RenderingEngine | null>(null);
  const startedRef = useRef(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string>("");
  const [title, setTitle] = useState<string>("");
  const [tilt, setTilt] = useState<number | null>(null);
  const [overlays, setOverlays] = useState<Record<string, MprOverlay>>({});
  const [probe, setProbe] = useState<MprProbe | null>(null);

  const mode = status?.mode === "standalone" ? "standalone" : "web";

  const elFor = useCallback(
    (id: string): HTMLDivElement | null => {
      if (id === VIEWPORT_IDS.axial) return axialRef.current;
      if (id === VIEWPORT_IDS.sagittal) return sagittalRef.current;
      return coronalRef.current;
    },
    [],
  );

  // 方位ラベル/スライス番号のオーバーレイを 3 面ぶん再計算する。
  const refreshOverlays = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const next: Record<string, MprOverlay> = {};
    for (const id of Object.values(VIEWPORT_IDS)) {
      const el = elFor(id);
      if (el) next[id] = readMprOverlay(engine, id, el);
    }
    setOverlays(next);
  }, [elFor]);

  /**
   * キーボードでのスライス送り（1 打鍵 = 1 スライス）。
   *
   * <p>ホイールは `StackScrollTool` が受けるが、こちらはツールを介さず直接送る。
   * ⚠️ Crosshairs で 3 面が連動するので、送ったあとは 3 面ぶんのオーバーレイを更新する。
   */
  const onCellKey = useCallback(
    (viewportId: string, e: React.KeyboardEvent<HTMLDivElement>) => {
      const prev = matchesShortcut("nav-prev-slice", e.nativeEvent);
      const next = matchesShortcut("nav-next-slice", e.nativeEvent);
      if (!prev && !next) return;
      e.preventDefault();
      const engine = engineRef.current;
      if (!engine) return;
      stepViewportSlice(engine.getViewport(viewportId), next ? 1 : -1);
      refreshOverlays();
    },
    [refreshOverlays],
  );

  const start = useCallback(async () => {
    // ctx 読み取り。
    let ctx: MprContext | null = null;
    try {
      const raw = localStorage.getItem("graphy-mpr-ctx");
      if (raw) ctx = JSON.parse(raw) as MprContext;
    } catch {
      ctx = null;
    }
    if (!ctx?.study) {
      setPhase("error");
      setMessage(t("mpr.noContext"));
      return;
    }
    // web も対応: imageId は BFF(WADO-RS) 経由の wadouri。ボリューム構築は cornerstone が
    // 各スライスを BFF から読み込む（standalone と同一経路）。

    setPhase("loading");
    setMessage(t("mpr.loading"));

    try {
      await ensureCornerstoneInitialized();

      // シリーズ解決: ctx にあればそれ、無ければ最多インスタンスのシリーズ。
      let series = ctx.series;
      if (!series) {
        const list = await fetchSeries(ctx.study.studyInstanceUid);
        series = list.slice().sort((a, b) => b.numberOfInstances - a.numberOfInstances)[0];
      }
      if (!series) {
        setPhase("error");
        setMessage(t("mpr.noSeries"));
        return;
      }
      setTitle(series.seriesDescription || series.seriesInstanceUid);

      const instances = await fetchInstances(ctx.study.studyInstanceUid, series.seriesInstanceUid);
      if (instances.length < 3) {
        setPhase("error");
        setMessage(t("mpr.needVolume"));
        return;
      }
      const imageIds = instances.map((i) =>
        imageIdForInstance(mode, i.sopInstanceUid, ctx.study.studyInstanceUid, series.seriesInstanceUid),
      );

      // ボリューム構築で確保しようとする量を先に見積もり、バジェットを超えるなら確認する
      // （fw/volume-memory-guard.md V2）。MPR は本来 layout を取らないが、面内サイズと
      // ピクセル形式が予測に要るためここで 1 回だけ取得する（失敗しても予測を諦めるだけ）。
      const guardLayout = await fetchSeriesLayout(
        ctx.study.studyInstanceUid,
        series.seriesInstanceUid,
      ).catch(() => null);
      const memDecision = await confirmVolumeMemory({
        layout: guardLayout,
        sliceCount: imageIds.length,
        modality: series.modality,
        target: "mpr",
        t18n: t,
      });
      if (!memDecision.proceed) {
        // キャンセル時は画面が空のままになるので、理由を出しておく。
        setPhase("error");
        setMessage(t("common.volumeMemCanceled"));
        return;
      }

      // web: 全スライスを 1 リクエストで BFF キャッシュに載せてから volume 構築（個別 WADO-RS 往復を回避）。
      if (mode === "web") {
        try {
          await prefetchSeries(ctx.study.studyInstanceUid, series.seriesInstanceUid);
        } catch {
          /* prefetch は最適化。失敗しても個別取得で続行 */
        }
      }

      const volumeId = `graphy-mpr-vol:${series.seriesInstanceUid}`;
      const built = await buildMprVolume(imageIds, series.modality, volumeId, {
        maxBytes: memDecision.enforceMaxBytes,
      });
      setTilt(built.corrected ? (built.tiltAngleDeg ?? null) : null);

      const els = axialRef.current && sagittalRef.current && coronalRef.current;
      if (!els) {
        setPhase("error");
        setMessage(t("mpr.error"));
        return;
      }

      const engine = new RenderingEngine(ENGINE_ID);
      engineRef.current = engine;
      await setupMprViewports(
        engine,
        ENGINE_ID,
        { axial: axialRef.current!, sagittal: sagittalRef.current!, coronal: coronalRef.current! },
        VIEWPORT_IDS,
        volumeId,
        TOOL_GROUP_ID,
      );
      setPhase("ready");
      // 初回オーバーレイ計算（レイアウト確定後に読む）。
      requestAnimationFrame(() => refreshOverlays());
    } catch (e) {
      setPhase("error");
      // キャッシュ上限超過は cornerstone の生メッセージ（CACHE_SIZE_EXCEEDED / is not cacheable）では
      // 利用者が対処できないため、対処を書いた案内に差し替える（fw/volume-memory-guard.md V1）。
      setMessage(
        isCacheSizeExceeded(e)
          ? t("common.volumeMemExceeded", { budgetMb: String(getAppliedVolumeMaxMb()) })
          : `${t("mpr.error")}: ${String(e)}`,
      );
    }
  }, [mode, t]);

  // status(=mode) が確定してから 1 度だけ起動する。マウント時は status=null のことが多く、
  // 早期に走らせると mode が "web" と誤判定されるため待つ。
  useEffect(() => {
    if (startedRef.current || !status) return;
    startedRef.current = true;
    void start();
  }, [status, start]);

  // アンマウント時のみ後片付け（status 変化で破棄しないよう分離）。
  useEffect(() => {
    return () => {
      teardownMpr(engineRef.current, TOOL_GROUP_ID);
      engineRef.current = null;
    };
  }, []);

  // カメラ変更（Crosshairs ジャンプ・スライス送り・pan/zoom）でオーバーレイを追従。
  useEffect(() => {
    if (phase !== "ready") return;
    const onCam = () => refreshOverlays();
    eventTarget.addEventListener(Enums.Events.CAMERA_MODIFIED, onCam);
    return () => eventTarget.removeEventListener(Enums.Events.CAMERA_MODIFIED, onCam);
  }, [phase, refreshOverlays]);

  // モバイル(singlePane)のみ: 1 本指タッチのツールをトグルに追従（ピンチ Zoom は常時）。
  // desktop では呼ばない（Crosshairs を Active Primary のまま保つ）。ツールグループ生成後にのみ効く。
  useEffect(() => {
    if (!singlePane || phase !== "ready") return;
    setMprTouchTool(TOOL_GROUP_ID, touchTool);
  }, [singlePane, phase, touchTool]);

  // マウス直下の実空間座標＋輝度値を上段に出す。
  const onCellMove = useCallback((viewportId: string, e: React.MouseEvent<HTMLDivElement>) => {
    const engine = engineRef.current;
    if (!engine) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const r = probeMpr(engine, viewportId, e.clientX - rect.left, e.clientY - rect.top);
    if (r) setProbe(r);
  }, []);

  const viewportIds = [VIEWPORT_IDS.axial, VIEWPORT_IDS.sagittal, VIEWPORT_IDS.coronal];
  const onPreset = (value: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    if (value === "default") {
      resetMprWl(engine, viewportIds);
    } else {
      const p = presets.find((x) => x.key === value);
      if (p) applyMprWl(engine, viewportIds, p.center, p.width);
    }
  };

  const busy = phase === "loading" || phase === "idle";

  return (
    <div style={root}>
      <div style={header}>
        {/* 狭幅では別ウィンドウではなく同一タブの hash 遷移で来るので、戻る導線を出す。 */}
        {singlePane && (
          <button
            style={backBtn}
            onClick={() => window.history.back()}
            aria-label={t("mobile.back")}
            data-testid="mpr-back"
          >
            ‹
          </button>
        )}
        <span style={hTitle}>{t("main.toolbar.mpr")}</span>
        {title && <span style={hSeries}>{title}</span>}
        {phase === "ready" && (
          <label style={wlWrap}>
            <span style={wlLabel}>{t("viewer2d.wl.preset")}</span>
            <select style={wlSelect} defaultValue="default" onChange={(e) => onPreset(e.target.value)}>
              <option value="default">{t("viewer2d.wl.default")}</option>
              {presets.map((p) => (
                <option key={p.key} value={p.key}>
                  {presetLabel(p, t)}
                </option>
              ))}
            </select>
          </label>
        )}
        {tilt !== null && (
          <span style={tiltChip} title={t("mpr.tiltCorrectedHint")}>
            {t("mpr.tiltCorrected", { deg: tilt.toFixed(1) })}
          </span>
        )}
      </div>
      {phase === "ready" && (
        <div style={readout}>
          {probe ? (
            <>
              <span style={roItem}>
                <b style={roKey}>X</b> {probe.world[0].toFixed(1)}
                <b style={roKey}>Y</b> {probe.world[1].toFixed(1)}
                <b style={roKey}>Z</b> {probe.world[2].toFixed(1)}
                <span style={roUnit}>mm</span>
              </span>
              {probe.ijk && (
                <span style={roItem}>
                  <b style={roKey}>{t("mpr.voxel")}</b> {probe.ijk[0]},{probe.ijk[1]},{probe.ijk[2]}
                </span>
              )}
              <span style={roItem}>
                <b style={roKey}>{t("mpr.value")}</b>{" "}
                {probe.value === null ? "—" : Math.round(probe.value)}
              </span>
            </>
          ) : (
            <span style={roHint}>{t("mpr.probeHint")}</span>
          )}
        </div>
      )}
      {/* 狭幅では 3 面横並びが成立しないので、面切替タブ＋1 面表示にする（fw/mobile-ui-design.md §4.2）。 */}
      {singlePane && (
        <div style={paneTabs} data-testid="mpr-pane-tabs">
          {PANES.map((p) => (
            <button
              key={p.id}
              style={p.id === activePane ? paneTabOn : paneTab}
              onClick={() => setActivePane(p.id)}
              data-testid={`mpr-pane-${p.id}`}
            >
              {t(p.labelKey)}
            </button>
          ))}
        </div>
      )}
      {/* モバイルのタッチ操作: 1 本指ツール（スライス送り/W-L/Pan）を切替。ピンチ=Zoom は常時（§3.3）。 */}
      {singlePane && phase === "ready" && (
        <div style={paneTabs} data-testid="mpr-touch-tools">
          {([
            ["scroll", "mpr.touch.scroll"],
            ["wl", "mpr.touch.wl"],
            ["pan", "mpr.touch.pan"],
          ] as [MprTouchTool, string][]).map(([id, key]) => (
            <button
              key={id}
              style={id === touchTool ? paneTabOn : paneTab}
              onClick={() => setTouchTool(id)}
              data-testid={`mpr-touch-${id}`}
            >
              {t(key)}
            </button>
          ))}
        </div>
      )}
      <div style={singlePane ? bodyStacked : body}>
        {/*
         * ⚠️ 1 面表示でも 3 つのビューポートは**必ずマウントしたまま**にする。
         * Crosshairs は 3 面が揃って初めて連動し、要素を外す/サイズ 0 にすると
         * cornerstone のリサイズが壊れる。非表示は visibility だけで行い、寸法は保つ。
         */}
        <Cell label={t("mpr.axial")} color="#00dc00" refEl={axialRef} overlay={overlays[VIEWPORT_IDS.axial]}
          stacked={singlePane} hidden={singlePane && activePane !== "axial"}
          onMove={(e) => onCellMove(VIEWPORT_IDS.axial, e)} onLeave={() => setProbe(null)}
          onKey={(e) => onCellKey(VIEWPORT_IDS.axial, e)} />
        <Cell label={t("mpr.sagittal")} color="#dcdc00" refEl={sagittalRef} overlay={overlays[VIEWPORT_IDS.sagittal]}
          stacked={singlePane} hidden={singlePane && activePane !== "sagittal"}
          onMove={(e) => onCellMove(VIEWPORT_IDS.sagittal, e)} onLeave={() => setProbe(null)}
          onKey={(e) => onCellKey(VIEWPORT_IDS.sagittal, e)} />
        <Cell label={t("mpr.coronal")} color="#00a0ff" refEl={coronalRef} overlay={overlays[VIEWPORT_IDS.coronal]}
          stacked={singlePane} hidden={singlePane && activePane !== "coronal"}
          onMove={(e) => onCellMove(VIEWPORT_IDS.coronal, e)} onLeave={() => setProbe(null)}
          onKey={(e) => onCellKey(VIEWPORT_IDS.coronal, e)} />
        {phase !== "ready" && (
          <div style={overlay}>
            <div style={overlayBox}>{busy ? t("mpr.loading") : message}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function Cell({
  label,
  color,
  refEl,
  overlay,
  stacked = false,
  hidden = false,
  onMove,
  onLeave,
  onKey,
}: {
  label: string;
  color: string;
  refEl: React.RefObject<HTMLDivElement>;
  overlay?: MprOverlay;
  /** 1 面表示: 3 面を重ねて配置する（寸法は全面のまま）。 */
  stacked?: boolean;
  /** 重ね配置のうち、いま表示しない面。**アンマウントも寸法 0 もしない**（上のコメント参照）。 */
  hidden?: boolean;
  onMove?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onLeave?: () => void;
  /** キーボードのスライス送り（↑↓ / テンキー 8・2）。面をクリックしてフォーカスしてから効く。 */
  onKey?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}) {
  const m = overlay?.markers ?? null;
  return (
    <div
      style={
        stacked
          ? { ...cellStacked, visibility: hidden ? "hidden" : "visible", zIndex: hidden ? 0 : 1 }
          : cell
      }
    >
      <div
        ref={refEl}
        style={vpEl}
        // クリックでフォーカスが乗り、↑↓ / テンキー 8・2 が届くようにする。
        tabIndex={0}
        onContextMenu={(e) => e.preventDefault()}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
        onKeyDown={onKey}
      />
      <span style={{ ...cellLabel, color }}>{label}</span>
      {overlay && overlay.total > 0 && (
        <span style={sliceLabel}>
          {overlay.slice + 1} / {overlay.total}
        </span>
      )}
      {m && (
        <>
          <span style={{ ...markTop }}>{m.top}</span>
          <span style={{ ...markBottom }}>{m.bottom}</span>
          <span style={{ ...markLeft }}>{m.left}</span>
          <span style={{ ...markRight }}>{m.right}</span>
        </>
      )}
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────
const root: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  background: "#000",
  color: "#e6eaee",
  fontFamily: "system-ui, sans-serif",
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "6px 12px",
  background: "#14181c",
  borderBottom: "1px solid #23292f",
  fontSize: 13,
};
const hTitle: React.CSSProperties = { fontWeight: 600 };
const hSeries: React.CSSProperties = { color: "#9aa6b2" };
const wlWrap: React.CSSProperties = { display: "flex", alignItems: "center", gap: 5, marginLeft: 8 };
const wlLabel: React.CSSProperties = { color: "#9aa6b2", fontSize: 12 };
const wlSelect: React.CSSProperties = {
  background: "#1b2126",
  color: "#e6eaee",
  border: "1px solid #2c343b",
  borderRadius: 5,
  fontSize: 12,
  padding: "2px 6px",
};
const tiltChip: React.CSSProperties = {
  marginLeft: "auto",
  fontSize: 11,
  color: "#ffd27a",
  border: "1px solid #5a4a2a",
  background: "#2a220f",
  borderRadius: 4,
  padding: "1px 7px",
};
const readout: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
  padding: "3px 12px",
  background: "#0d1013",
  borderBottom: "1px solid #23292f",
  fontSize: 12,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "#c7d0d8",
  minHeight: 22,
};
const roItem: React.CSSProperties = { whiteSpace: "nowrap" };
const roKey: React.CSSProperties = { color: "#7f8b96", fontWeight: 600, margin: "0 4px 0 0" };
const roUnit: React.CSSProperties = { color: "#7f8b96", marginLeft: 4 };
const roHint: React.CSSProperties = { color: "#5a6672" };
const body: React.CSSProperties = { position: "relative", flex: 1, display: "flex", minHeight: 0 };
/** 1 面表示: 3 面を同じ場所に重ねる（display:flex にしない）。 */
const bodyStacked: React.CSSProperties = { position: "relative", flex: 1, minHeight: 0 };
const cell: React.CSSProperties = {
  position: "relative",
  flex: 1,
  minWidth: 0,
  borderRight: "1px solid #23292f",
};
/** 重ね配置のセル。**寸法は常に全面**（0 にすると cornerstone のリサイズが壊れる）。 */
const cellStacked: React.CSSProperties = { position: "absolute", inset: 0 };
const backBtn: React.CSSProperties = {
  minWidth: 36,
  minHeight: 36,
  border: "none",
  background: "transparent",
  color: "#e6eaee",
  fontSize: 22,
  lineHeight: 1,
  cursor: "pointer",
};
const paneTabs: React.CSSProperties = {
  display: "flex",
  gap: 6,
  padding: "6px 8px",
  background: "#14181c",
  borderBottom: "1px solid #23292f",
};
const paneTab: React.CSSProperties = {
  flex: 1,
  minHeight: 44,
  border: "1px solid #2c343b",
  borderRadius: 8,
  background: "transparent",
  color: "#c7d0d8",
  fontSize: 13,
  cursor: "pointer",
};
const paneTabOn: React.CSSProperties = {
  ...paneTab,
  background: "#0b5cad",
  borderColor: "#2f6db5",
  color: "#fff",
};
// touchAction: none — 無いとタッチ端末で画像上のドラッグがページスクロールに奪われる
// （`fw/mobile-ui-design.md` §3.3）。マウス操作には影響しない。
const vpEl: React.CSSProperties = { position: "absolute", inset: 0, touchAction: "none" };
const cellLabel: React.CSSProperties = {
  position: "absolute",
  top: 6,
  left: 8,
  fontSize: 12,
  fontWeight: 600,
  textShadow: "0 0 3px #000",
  pointerEvents: "none",
};
const sliceLabel: React.CSSProperties = {
  position: "absolute",
  bottom: 6,
  left: 8,
  fontSize: 11,
  color: "#c7d0d8",
  textShadow: "0 0 3px #000",
  pointerEvents: "none",
};
const markBase: React.CSSProperties = {
  position: "absolute",
  color: "#e6eaee",
  fontSize: 12,
  fontWeight: 700,
  textShadow: "0 0 3px #000",
  pointerEvents: "none",
};
const markTop: React.CSSProperties = { ...markBase, top: 4, left: "50%", transform: "translateX(-50%)" };
const markBottom: React.CSSProperties = { ...markBase, bottom: 4, left: "50%", transform: "translateX(-50%)" };
const markLeft: React.CSSProperties = { ...markBase, left: 4, top: "50%", transform: "translateY(-50%)" };
const markRight: React.CSSProperties = { ...markBase, right: 4, top: "50%", transform: "translateY(-50%)" };
const overlay: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.55)",
};
const overlayBox: React.CSSProperties = {
  padding: "10px 18px",
  background: "#1b2126",
  border: "1px solid #2c343b",
  borderRadius: 8,
  fontSize: 13,
  maxWidth: "80%",
  textAlign: "center",
};
