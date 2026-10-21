import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { utilities as csUtilities } from "@cornerstonejs/core";
import { AngleTool, LengthTool, PanTool, ProbeTool, WindowLevelTool, ZoomTool } from "@cornerstonejs/tools";
import { SeriesViewer } from "../../src/viewer/SeriesViewer";
import { ensureCornerstoneInitialized } from "../../src/viewer/cornerstoneSetup";
import { imageIdForInstance } from "../../src/viewer/imageId";
import { runViewerCommand, queryViewerCommand, type ViewerViewState } from "../../src/viewer/viewerCommands";
import { runSeriesCommand } from "../../src/viewer/seriesCommands";
import { DEFAULT_PRESETS } from "../../src/viewer2d/wlPresets";
import { useI18n } from "../../src/i18n/i18n";
import type { DicomDirModel, SeriesRec, StudyRec, PatientRec } from "../../portable/src/dicomdir";
import { indexSeries, instancesOf, layoutFor, registerModel } from "./data";
import * as I from "./icons";
import "./style.css";

type LayoutId = "1x1" | "1x2" | "2x2";
const LAYOUTS: Record<LayoutId, { rows: number; cols: number }> = { "1x1": { rows: 1, cols: 1 }, "1x2": { rows: 1, cols: 2 }, "2x2": { rows: 2, cols: 2 } };

const TOOLS = [
  { id: "wl", name: WindowLevelTool.toolName, key: "w", icon: <I.IcWL />, ja: "ウィンドウ幅・レベル", en: "Window / Level" },
  { id: "pan", name: PanTool.toolName, key: "p", icon: <I.IcPan />, ja: "パン", en: "Pan" },
  { id: "zoom", name: ZoomTool.toolName, key: "z", icon: <I.IcZoom />, ja: "ズーム", en: "Zoom" },
  "sep",
  { id: "len", name: LengthTool.toolName, key: "l", icon: <I.IcLength />, ja: "長さ", en: "Length" },
  { id: "ang", name: AngleTool.toolName, key: "a", icon: <I.IcAngle />, ja: "角度", en: "Angle" },
  { id: "probe", name: ProbeTool.toolName, key: "r", icon: <I.IcProbe />, ja: "プローブ", en: "Probe" },
] as const;
type ToolDef = Exclude<(typeof TOOLS)[number], "sep">;
const toolDefs = TOOLS.filter((t): t is ToolDef => t !== "sep");

const tileKey = (i: number) => `ptile-${i}`;

interface SeriesMeta { n: number; axis: "z" | "t" }

function allSeries(m: DicomDirModel): { p: PatientRec; s: StudyRec; se: SeriesRec }[] {
  return m.patients.flatMap((p) => p.studies.flatMap((s) => s.series.map((se) => ({ p, s, se }))));
}

function Thumb({ series, ready }: { series: SeriesRec; ready: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const first = series.images[0];
    if (!ready || !first || !ref.current) return;
    let alive = true;
    const imageId = imageIdForInstance("standalone", first.sopUid, "", series.seriesUid);
    csUtilities
      .loadImageToCanvas({ canvas: ref.current, imageId, thumbnail: true, imageAspect: true })
      .then(() => {
        const c = ref.current;
        if (!alive || !c) return;
        const k = 64 / Math.max(c.width || 1, c.height || 1);
        c.style.width = `${Math.round(c.width * k)}px`;
        c.style.height = `${Math.round(c.height * k)}px`;
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [series, ready]);
  return <canvas ref={ref} width={96} height={96} />;
}

export function App({ model }: { model: DicomDirModel }) {
  const { locale, setLocale } = useI18n();
  const tx = useCallback((ja: string, en: string) => (locale === "ja" ? ja : en), [locale]);
  const list = useMemo(() => allSeries(model), [model]);
  const firstImage = list.find((x) => x.se.images.length > 0);

  const [csReady, setCsReady] = useState(false);
  const [layout, setLayout] = useState<LayoutId>("1x1");
  const [assign, setAssign] = useState<(string | null)[]>([firstImage?.se.seriesUid ?? null, null, null, null]);
  const [active, setActive] = useState(0);
  const [tool, setTool] = useState<string>(WindowLevelTool.toolName);
  const [sync, setSync] = useState(true);
  const [more, setMore] = useState(false);
  const [help, setHelp] = useState(false);
  const [view, setView] = useState<ViewerViewState | null>(null);
  const [dims, setDims] = useState<Record<number, { z: number; t: number }>>({});
  const [metas, setMetas] = useState<Record<string, SeriesMeta>>({});
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(10);
  const [dropTile, setDropTile] = useState<number | null>(null);

  useEffect(() => {
    registerModel(model);
    indexSeries(model);
    void ensureCornerstoneInitialized().then(() => setCsReady(true));
  }, [model]);

  const tiles = LAYOUTS[layout].rows * LAYOUTS[layout].cols;
  const keys = useMemo(() => Array.from({ length: tiles }, (_, i) => tileKey(i)), [tiles]);
  const activeUid = assign[active] ?? null;
  const activeSeries = list.find((x) => x.se.seriesUid === activeUid)?.se ?? null;

  // シリーズ長（スライダー用）。レイアウトは本体と同じ DTO から得る。
  useEffect(() => {
    for (const uid of assign.slice(0, tiles)) {
      const se = list.find((x) => x.se.seriesUid === uid)?.se;
      if (!se || metas[se.seriesUid]) continue;
      void layoutFor(se).then((dto) => {
        const axis = dto.axes?.stackAxis === "t" ? "t" : "z";
        setMetas((m) => ({ ...m, [se.seriesUid]: { n: axis === "t" ? dto.nT : dto.nZ, axis } }));
      }).catch(() => setMetas((m) => ({ ...m, [se.seriesUid]: { n: se.images.length, axis: "z" } })));
    }
  }, [assign, tiles, list, metas]);

  // ツールの適用（左ドラッグ）。タイルが組み上がるのを待って流す。
  useEffect(() => {
    if (!csReady) return;
    const id = window.setTimeout(() => runViewerCommand(keys, (c) => c.setActiveTool(tool)), 500);
    return () => window.clearTimeout(id);
  }, [csReady, tool, keys, assign, layout]);

  // W/L・倍率の表示（アクティブなタイル）。
  useEffect(() => {
    const id = window.setInterval(() => setView(queryViewerCommand(tileKey(active), (c) => c.getViewState())), 300);
    return () => window.clearInterval(id);
  }, [active]);

  const meta = activeUid ? metas[activeUid] : undefined;
  const pos = meta ? (meta.axis === "t" ? dims[active]?.t : dims[active]?.z) ?? 0 : 0;
  const posRef = useRef(0);
  posRef.current = pos;
  const goTo = useCallback((i: number) => {
    const m = activeUid ? metas[activeUid] : undefined;
    if (!m) return;
    runSeriesCommand([tileKey(active)], (c) => c.goTo(m.axis === "t" ? { t: i } : { z: i }));
  }, [active, activeUid, metas]);

  useEffect(() => {
    if (!playing || !meta || meta.n < 2) return;
    const id = window.setInterval(() => goTo((posRef.current + 1) % meta.n), Math.round(1000 / Math.max(1, fps)));
    return () => window.clearInterval(id);
  }, [playing, meta, fps, goTo]);

  const showSeries = useCallback((uid: string, tile = active) => {
    setAssign((a) => a.map((v, i) => (i === tile ? uid : v)));
    setActive(tile);
    setPlaying(false);
  }, [active]);

  const setLayoutAndFill = (id: LayoutId) => {
    setLayout(id);
    const n = LAYOUTS[id].rows * LAYOUTS[id].cols;
    // 空いたタイルには、まだ出していないシリーズを順に入れる。
    setAssign((a) => {
      const used = new Set(a.slice(0, n).filter(Boolean));
      const rest = list.filter((x) => x.se.images.length > 0 && !used.has(x.se.seriesUid)).map((x) => x.se.seriesUid);
      return a.map((v, i) => (i < n && !v ? rest.shift() ?? null : v));
    });
    if (active >= n) setActive(0);
  };

  const saveImage = (copy: boolean) => {
    const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>(`[data-pv-tile="${active}"] canvas`));
    const c = canvases.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!c) return;
    c.toBlob((b) => {
      if (!b) return;
      if (copy) void navigator.clipboard?.write([new ClipboardItem({ "image/png": b })]).catch(() => undefined);
      else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b);
        a.download = "image.png";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }
    }, "image/png");
  };

  const cmd = (fn: Parameters<typeof runViewerCommand>[1]) => runViewerCommand([tileKey(active)], fn);

  // ショートカット
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const td = toolDefs.find((d) => d.key === k);
      if (td) { setTool(td.name); return; }
      if (k === " ") { e.preventDefault(); setPlaying((p) => !p); }
      else if (k === "f") cmd((c) => c.fit());
      else if (k === "i") cmd((c) => c.invert());
      else if (k === "?" || k === "/") setHelp((h) => !h);
      else if (k === "escape") { setHelp(false); setMore(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const patient = list[0]?.p;
  const study = list[0]?.s;
  const isCt = activeSeries?.modality === "CT";
  const wlRef = useRef<{ w: HTMLInputElement | null; l: HTMLInputElement | null }>({ w: null, l: null });
  const applyWl = () => {
    const w = Number(wlRef.current.w?.value), l = Number(wlRef.current.l?.value);
    if (Number.isFinite(w) && Number.isFinite(l) && w > 0) cmd((c) => c.setWindowLevel(l, w));
  };
  const fmt = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? "" : String(Math.round(v * 10) / 10));

  return (
    <div className="pv-app">
      <header className="pv-top">
        <div className="pv-brand"><I.IcLogo /><b>GRAPHY</b><span>{tx("ビューア", "Viewer")}</span></div>
        <div className="pv-sep" />
        <div className="pv-patient">
          <b>{patient?.name || tx("（患者名なし）", "(no name)")}</b>
          <span>ID {patient?.id || "—"}　·　{study?.date || "—"}　·　{tx(`${list.length} シリーズ`, `${list.length} series`)}</span>
        </div>
        <div className="pv-seg" role="group" aria-label={tx("レイアウト", "Layout")}>
          {(Object.keys(LAYOUTS) as LayoutId[]).map((id) => (
            <button key={id} type="button" aria-label={id.replace("x", "×")} aria-pressed={layout === id} onClick={() => setLayoutAndFill(id)}>
              <I.IcGrid rows={LAYOUTS[id].rows} cols={LAYOUTS[id].cols} />
            </button>
          ))}
        </div>
        <button type="button" className="pv-chip" aria-pressed={sync} onClick={() => setSync((s) => !s)} disabled={tiles < 2}>
          <span style={{ color: sync ? "var(--accent)" : undefined, display: "grid" }}><I.IcLink /></span>{tx("同期", "Sync")}
        </button>
        <div className="pv-seg" role="group" aria-label={tx("言語", "Language")}>
          <button type="button" aria-pressed={locale === "ja"} onClick={() => setLocale("ja")}>日本語</button>
          <button type="button" aria-pressed={locale === "en"} onClick={() => setLocale("en")}>EN</button>
        </div>
        <button type="button" className="pv-iconbtn" aria-label={tx("操作の案内（?）", "Help (?)")} onClick={() => setHelp(true)}><I.IcHelp /></button>
      </header>

      <div className="pv-body">
        <aside className="pv-side">
          <div className="pv-side-head"><span>{tx("シリーズ", "SERIES")}</span><span className="pv-count">{list.length}</span></div>
          <div className="pv-list">
            {list.map(({ s, se }, i) => {
              const newStudy = i === 0 || list[i - 1].s.studyUid !== s.studyUid;
              const shown = assign.slice(0, tiles).includes(se.seriesUid);
              const dis = se.images.length === 0;
              return (
                <div key={se.seriesUid} style={{ display: "contents" }}>
                  {newStudy && <div className="pv-study">{s.date || "—"}　{s.description}</div>}
                  <button
                    type="button" className="pv-card" aria-current={shown && assign[active] === se.seriesUid} disabled={dis}
                    draggable onDragStart={(e) => e.dataTransfer.setData("text/pv-series", se.seriesUid)}
                    onClick={() => showSeries(se.seriesUid)} onDoubleClick={() => showSeries(se.seriesUid)}
                  >
                    <div className="pv-thumb"><Thumb series={se} ready={csReady} /></div>
                    <div className="pv-meta">
                      <div className="row"><span className={`pv-mod ${se.modality === "PT" ? "pt" : ""}`}>{se.modality || "—"}</span><small>{tx("シリーズ", "Series")} {se.number ?? "—"}</small></div>
                      <strong>{se.description || tx("（説明なし）", "(no description)")}</strong>
                      <span className="sub">{tx(`${se.images.length} 枚`, `${se.images.length} images`)}</span>
                    </div>
                  </button>
                </div>
              );
            })}
            <div className="pv-hint">{tx("クリックで表示。画像へドラッグしても開けます", "Click to show, or drag onto an image")}</div>
          </div>
          <div className="pv-privacy"><I.IcLock /><span>{tx("この PC の中だけで表示しています。画像は外へ送られません（読み取り専用）。", "Shown on this PC only. Images are never sent anywhere (read-only).")}</span></div>
        </aside>

        <nav className="pv-rail" aria-label={tx("ツール", "Tools")}>
          {TOOLS.map((t, i) =>
            t === "sep" ? <hr key={i} /> : (
              <button key={t.id} type="button" className="pv-tool" aria-label={`${tx(t.ja, t.en)} (${t.key.toUpperCase()})`} aria-pressed={tool === t.name} onClick={() => setTool(t.name)}>
                {t.icon}
                <span className="pv-tip" role="tooltip">{tx(t.ja, t.en)}<kbd>{t.key.toUpperCase()}</kbd></span>
              </button>
            ),
          )}
          <div style={{ flex: 1 }} />
          <button type="button" className="pv-tool" aria-label={tx("表示を初期化", "Reset view")} onClick={() => cmd((c) => c.reset())}>
            <I.IcReset /><span className="pv-tip" role="tooltip">{tx("表示を初期化", "Reset view")}</span>
          </button>
          <button type="button" className="pv-tool" aria-label={tx("そのほかの表示", "More")} aria-expanded={more} onClick={() => setMore((m) => !m)}>
            <I.IcMore />
          </button>
          {more && (
            <div className="pv-pop" role="menu">
              <div className="title">{tx("表示", "DISPLAY")}</div>
              <button type="button" role="menuitem" aria-pressed={!!view?.invert} onClick={() => cmd((c) => c.invert())}>{tx("白黒反転", "Invert")}<kbd style={{ marginLeft: "auto", color: "var(--muted)" }}>I</kbd></button>
              <button type="button" role="menuitem" onClick={() => cmd((c) => c.rotate90())}>{tx("90° 回転", "Rotate 90°")}</button>
              <button type="button" role="menuitem" onClick={() => cmd((c) => c.flipH())}>{tx("左右反転", "Flip horizontally")}</button>
              <button type="button" role="menuitem" onClick={() => cmd((c) => c.flipV())}>{tx("上下反転", "Flip vertically")}</button>
              <button type="button" role="menuitem" onClick={() => cmd((c) => c.fit())}>{tx("画面に合わせる", "Fit to window")}<kbd style={{ marginLeft: "auto", color: "var(--muted)" }}>F</kbd></button>
            </div>
          )}
        </nav>

        <main className="pv-stage" style={{ gridTemplateColumns: `repeat(${LAYOUTS[layout].cols}, 1fr)`, gridTemplateRows: `repeat(${LAYOUTS[layout].rows}, 1fr)` }}>
          {Array.from({ length: tiles }, (_, i) => {
            const uid = assign[i];
            const se = list.find((x) => x.se.seriesUid === uid);
            return (
              <div
                key={i} className={`pv-tile${dropTile === i ? " drop" : ""}`} data-pv-tile={i} data-active={active === i}
                onPointerDown={() => setActive(i)}
                onDragOver={(e) => { e.preventDefault(); setDropTile(i); }} onDragLeave={() => setDropTile(null)}
                onDrop={(e) => { e.preventDefault(); setDropTile(null); const u = e.dataTransfer.getData("text/pv-series"); if (u) showSeries(u, i); }}
              >
                {se && csReady ? (
                  <SeriesViewer
                    key={`${i}-${se.se.seriesUid}`}
                    instances={instancesOf(se.se)} mode="standalone" studyUid={se.s.studyUid} seriesUid={se.se.seriesUid}
                    fillHeight showControls={false} chrome={false} commandKey={tileKey(i)}
                    syncEnabled={sync && tiles > 1} referenceLinesEnabled={sync && tiles > 1}
                    seriesLabel={se.se.description}
                    onDimChange={(_c, t, z) => setDims((d) => (d[i]?.z === z && d[i]?.t === t ? d : { ...d, [i]: { z, t } }))}
                  />
                ) : (
                  <div className="pv-empty">{se ? tx("読み込んでいます…", "Loading…") : tx("左の一覧からシリーズをここへドラッグ", "Drag a series here from the list")}</div>
                )}
              </div>
            );
          })}
        </main>
      </div>

      <footer className="pv-bottom">
        <button type="button" className="pv-play" aria-label={playing ? tx("停止", "Pause") : tx("再生", "Play")} disabled={!meta || meta.n < 2} onClick={() => setPlaying((p) => !p)}>
          {playing ? <I.IcPause /> : <I.IcPlay />}
        </button>
        <label className="pv-fps">
          <input className="pv-num" type="number" min={1} max={60} value={fps} onChange={(e) => setFps(Math.min(60, Math.max(1, Number(e.target.value) || 1)))} aria-label="fps" />fps
        </label>
        <input className="pv-slider" type="range" min={0} max={Math.max(0, (meta?.n ?? 1) - 1)} value={Math.min(pos, Math.max(0, (meta?.n ?? 1) - 1))} disabled={!meta || meta.n < 2} onChange={(e) => goTo(Number(e.target.value))} aria-label={tx("スライス", "Slice")} />
        <span className="pv-pos">{meta ? `${pos + 1} / ${meta.n}` : "—"}</span>
        <div className="pv-sep" />
        <div className="pv-wl" role="group" aria-label="W/L">
          {isCt && DEFAULT_PRESETS.slice(0, 4).map((p) => (
            <button key={p.key} type="button" className="chip" aria-pressed={!!view && Math.round(view.windowCenter) === p.center && Math.round(view.windowWidth) === p.width} onClick={() => cmd((c) => c.setWindowLevel(p.center, p.width))}>
              {tx(PRESET_JA[p.key] ?? p.key, p.key)}
            </button>
          ))}
          <button type="button" className="chip" onClick={() => cmd((c) => c.resetWindow())}>{tx("元の値", "Original")}</button>
          <label>W<input key={`w${fmt(view?.windowWidth)}`} ref={(el) => { wlRef.current.w = el; }} className="pv-num" defaultValue={fmt(view?.windowWidth)} onBlur={applyWl} onKeyDown={(e) => e.key === "Enter" && applyWl()} aria-label="WW" /></label>
          <label>L<input key={`l${fmt(view?.windowCenter)}`} ref={(el) => { wlRef.current.l = el; }} className="pv-num" defaultValue={fmt(view?.windowCenter)} onBlur={applyWl} onKeyDown={(e) => e.key === "Enter" && applyWl()} aria-label="WL" /></label>
        </div>
        <div style={{ flex: 1 }} />
        <button type="button" className="pv-chip" onClick={() => saveImage(false)}><I.IcSave />{tx("画像を保存", "Save image")}</button>
        <button type="button" className="pv-chip" onClick={() => saveImage(true)}>{tx("コピー", "Copy")}</button>
      </footer>

      {help && (
        <div role="dialog" aria-modal="true" aria-label={tx("操作の案内", "Help")} onClick={() => setHelp(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "grid", placeItems: "center", zIndex: 100 }}>
          <div className="pv-card2" onClick={(e) => e.stopPropagation()}>
            <h2>{tx("操作の案内", "Help")}</h2>
            <p style={{ lineHeight: 1.9 }}>
              {tx("左ドラッグ: 選んだツール／ホイール: スライス送り／右ドラッグ: ズーム／中ボタンドラッグ: パン", "Left drag: selected tool / Wheel: scroll / Right drag: zoom / Middle drag: pan")}<br />
              {toolDefs.map((t) => `${t.key.toUpperCase()} ${tx(t.ja, t.en)}`).join("　")}<br />
              {tx("Space 再生／停止　F 画面に合わせる　I 白黒反転　? この案内", "Space play/pause  F fit  I invert  ? this help")}
            </p>
            <button type="button" className="pv-chip" onClick={() => setHelp(false)}>{tx("閉じる", "Close")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

const PRESET_JA: Record<string, string> = { brain: "脳", soft: "軟部", lung: "肺", bone: "骨", abdomen: "腹部", liver: "肝" };
