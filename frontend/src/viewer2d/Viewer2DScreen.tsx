/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchStudies,
  fetchSeries,
  fetchInstances,
  type AppStatus,
  type Study,
  type Series,
  type Instance,
  type LutData,
} from "../api";
import { SeriesViewer } from "../viewer/SeriesViewer";
import { FusionImageViewer } from "../viewer/FusionOverlayViewer";
import type { RenderOverlay } from "../viewer/Viewer2D";
import { buildSeriesLayout, type SeriesLayout } from "../viewer/seriesLayout";
import { LutDialog, ColorBar } from "../viewer/LutDialog";
import { useI18n } from "../i18n/i18n";
import { desktop } from "../desktopBridge";

// ── 型定義 ────────────────────────────────────────────────────

/** Fusion オーバーレイ情報。センタードロップで設定される。 */
interface FusionOverlay {
  study: Study;
  series: Series;
  instances: Instance[];
  opacity: number; // 0.0 – 1.0
  /** ドロップ元タイルで表示中だった C/T。fusion オーバーレイの初期 C/T に使う（無ければ 0）。 */
  initialC?: number;
  initialT?: number;
}

interface Tile {
  id: string;        // `${studyUid}|${seriesUid}`
  study: Study;
  series: Series;
  instances: Instance[];
  syncEnabled: boolean; // シリーズ Sync 参加フラグ
  fusion?: FusionOverlay; // Fusion オーバーレイ（設定時）
}

interface PatientSession {
  patientKey: string; // patientId || patientName || studyUid（同一患者判定キー）
  patientId: string;
  patientName: string;
  tiles: Tile[];
  gridCols: number;   // 0 = 自動（ceil(√N)）、>0 = 手動指定列数
}

/** localStorage に保存するコンテキスト形式。MainScreen が書き込み、Viewer が読む。 */
interface ViewerContext {
  study: Study;
  series?: Series;
  ts: number; // 同一コンテキストの二重適用を防ぐタイムスタンプ
}

/**
 * DnD ペイロード。同一ウィンドウ内転送のみのため、モジュールスコープ変数で保持する。
 * (dataTransfer は文字列しか運べないため、オブジェクト参照をここに保存する。)
 */
type DragPayload =
  | { type: "series"; study: Study; series: Series; label: string }
  | { type: "tile"; patientKey: string; tileId: string };

// ── モジュールレベル DnD 状態 ──────────────────────────────────

// ウィンドウ内 DnD（タイル並び替え / Fusion）のペイロード。
// 外部へのドラッグ保存は Electron ネイティブドラッグ（startTileDrag）で行うため、
// ここはウィンドウ内転送専用。
let _dragPayload: DragPayload | null = null;

function _resetDragState(): void {
  _dragPayload = null;
}

// ── ユーティリティ ────────────────────────────────────────────

function derivePatientKey(study: Study): string {
  return study.patientId || study.patientName || study.studyInstanceUid;
}

function autoTileCols(n: number): number {
  if (n <= 1) return 1;
  return Math.ceil(Math.sqrt(n));
}

/**
 * タイルコンテナ上のカーソル位置からドロップゾーンを判定する。
 *
 * 左 25%  → "before"（手前に挿入）
 * 右 25%  → "after"（後ろに挿入）
 * 中央 50% → "center"（Fusion オーバーレイ）
 */
function getDropZone(e: React.DragEvent<HTMLElement>): "before" | "after" | "center" | "none" {
  const rect = e.currentTarget.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  if (x < 0.25) return "before";
  if (x > 0.75) return "after";
  return "center";
}

/**
 * 指定タイルの canvas から PNG dataURL を取得する。
 * Cornerstone3D の WebGL canvas に対して toDataURL を試みる。
 * (preserveDrawingBuffer=false の場合は失敗することがある)
 */
function captureTileDataUrl(tileId: string): string | null {
  const el = document.querySelector(`[data-tile-id="${CSS.escape(tileId)}"]`);
  const canvas = el?.querySelector("canvas") as HTMLCanvasElement | null;
  if (!canvas) {
    console.warn("[Capture] canvas not found in tile", tileId);
    return null;
  }
  try {
    return canvas.toDataURL("image/png");
  } catch (err) {
    console.error("[Capture] toDataURL failed:", err);
    return null;
  }
}

/** 指定タイルの画像を PNG としてダウンロードする（クリック保存・web フォールバック）。 */
function captureAndDownload(tileId: string): void {
  const url = captureTileDataUrl(tileId);
  if (!url) return;
  const a = document.createElement("a");
  a.href = url;
  a.download = `graphy-capture-${Date.now()}.png`;
  a.click();
}

/**
 * タイル画像を外部（デスクトップ/他アプリ）へネイティブドラッグする。
 * Electron では本物のファイルドラッグになり、禁止カーソルが出ず、
 * ドロップ先に実 PNG ファイルが作成される。standalone(Electron) 専用。
 */
function startTileDrag(e: React.DragEvent, tileId: string, label: string): void {
  const startDrag = desktop()?.startDrag;
  if (!startDrag) return; // web: ネイティブドラッグ不可（HTML5 DnD のまま）
  const url = captureTileDataUrl(tileId);
  if (!url) return;
  // HTML5 ドラッグをキャンセルし、OS ネイティブドラッグに引き継ぐ。
  e.preventDefault();
  const safe = label.replace(/[^\w.\-]+/g, "_") || "image";
  startDrag(url, `${safe}.png`);
}

/** DnD ゴースト要素を生成して dataTransfer に設定する。呼び出し後すぐに DOM から除去。 */
function setGhostImage(e: React.DragEvent, label: string): void {
  const ghost = document.createElement("div");
  ghost.textContent = label;
  ghost.style.cssText =
    "position:fixed;left:-9999px;top:-9999px;padding:4px 10px;" +
    "background:#1a4a80;color:#fff;border-radius:4px;font-size:12px;" +
    "white-space:nowrap;pointer-events:none;";
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 0, 0);
  requestAnimationFrame(() => document.body.removeChild(ghost));
}

// ── メインコンポーネント ───────────────────────────────────────

/**
 * 2D Viewer 画面（マルチ患者・マルチスタディ・タイルビュー）。
 *
 * コンテキスト受け渡し（localStorage）：
 *   - MainScreen が "graphy-viewer-ctx" に { study, series?, ts } を書き込んでからビューアを開く
 *   - 新規ウィンドウ: マウント時に localStorage を読み取り適用
 *   - 既存ウィンドウ: storage イベントでリアルタイム検知・適用
 *
 * 患者ごとタブ管理：
 *   - 同一患者の別スタディ → 既存タブのタイルをクリアして新シリーズで置き換え
 *   - 未開患者 → 新しい患者タブを追加
 */
export function Viewer2DScreen({ status }: { status: AppStatus | null }) {
  const { t } = useI18n();
  const mode = status?.mode === "standalone" ? "standalone" : "web";

  const [patients, setPatients] = useState<PatientSession[]>([]);
  const [activeKey, setActiveKey] = useState<string>("");

  // 左ツリー用: コンテキストから自動設定される患者ID・スタディUID。
  const [initialPatientId, setInitialPatientId] = useState<string | null>(null);
  const [initialStudyUid, setInitialStudyUid] = useState<string | null>(null);

  // 処理済みコンテキストのタイムスタンプ（二重適用防止）。
  const processedCtxTs = useRef(0);

  // activeKey が空で患者が存在するとき、先頭患者を自動選択。
  useEffect(() => {
    if (!activeKey && patients.length > 0) {
      setActiveKey(patients[0].patientKey);
    }
  }, [patients, activeKey]);

  // ── タイル操作 ────────────────────────────────────────────

  const addTile = useCallback(async (study: Study, series: Series) => {
    const tileId = `${study.studyInstanceUid}|${series.seriesInstanceUid}`;
    const pKey = derivePatientKey(study);

    let instances: Instance[] = [];
    try {
      instances = await fetchInstances(study.studyInstanceUid, series.seriesInstanceUid);
    } catch {
      /* インスタンス取得失敗時も空で追加 */
    }
    const tile: Tile = { id: tileId, study, series, instances, syncEnabled: false };

    setPatients((prev) => {
      const idx = prev.findIndex((p) => p.patientKey === pKey);
      if (idx >= 0) {
        if (prev[idx].tiles.some((t) => t.id === tileId)) return prev; // 重複スキップ
        const updated = [...prev];
        updated[idx] = { ...prev[idx], tiles: [...prev[idx].tiles, tile] };
        return updated;
      }
      return [
        ...prev,
        {
          patientKey: pKey,
          patientId: study.patientId,
          patientName: study.patientName ?? "",
          tiles: [tile],
          gridCols: 0,
        },
      ];
    });
    setActiveKey(pKey);
  }, []);

  /** 同一患者のタイルをクリアして新しい1枚で置き換える（別スタディを開く場合）。 */
  const replacePatientTiles = useCallback(async (patientKey: string, study: Study, series: Series) => {
    const tileId = `${study.studyInstanceUid}|${series.seriesInstanceUid}`;
    let instances: Instance[] = [];
    try {
      instances = await fetchInstances(study.studyInstanceUid, series.seriesInstanceUid);
    } catch {}
    const tile: Tile = { id: tileId, study, series, instances, syncEnabled: false };
    setPatients((prev) =>
      prev.map((p) => (p.patientKey === patientKey ? { ...p, tiles: [tile] } : p)),
    );
  }, []);

  const removeTile = (patientKey: string, tileId: string) => {
    setPatients((prev) => {
      const idx = prev.findIndex((p) => p.patientKey === patientKey);
      if (idx < 0) return prev;
      const nextTiles = prev[idx].tiles.filter((t) => t.id !== tileId);
      if (nextTiles.length === 0) {
        const next = prev.filter((p) => p.patientKey !== patientKey);
        setActiveKey((key) => (key === patientKey ? (next[0]?.patientKey ?? "") : key));
        return next;
      }
      const updated = [...prev];
      updated[idx] = { ...prev[idx], tiles: nextTiles };
      return updated;
    });
  };

  const removePatient = (patientKey: string) => {
    setPatients((prev) => {
      const next = prev.filter((p) => p.patientKey !== patientKey);
      setActiveKey((key) => (key === patientKey ? (next[0]?.patientKey ?? "") : key));
      return next;
    });
  };

  const setPatientGridCols = (patientKey: string, cols: number) => {
    setPatients((prev) =>
      prev.map((p) => (p.patientKey === patientKey ? { ...p, gridCols: cols } : p)),
    );
  };

  /** 対象タイルの前後に新しいシリーズタイルを挿入する（DnD 四隅ドロップ）。 */
  const insertAdjacentTile = useCallback(async (
    patientKey: string,
    targetTileId: string,
    before: boolean,
    study: Study,
    series: Series,
  ) => {
    const newId = `${study.studyInstanceUid}|${series.seriesInstanceUid}`;
    let instances: Instance[] = [];
    try {
      instances = await fetchInstances(study.studyInstanceUid, series.seriesInstanceUid);
    } catch {}
    const tile: Tile = { id: newId, study, series, instances, syncEnabled: false };

    setPatients((prev) =>
      prev.map((p) => {
        if (p.patientKey !== patientKey) return p;
        if (p.tiles.some((t) => t.id === newId)) return p; // 重複スキップ
        const idx = p.tiles.findIndex((t) => t.id === targetTileId);
        if (idx < 0) return { ...p, tiles: [...p.tiles, tile] };
        const next = [...p.tiles];
        next.splice(before ? idx : idx + 1, 0, tile);
        return { ...p, tiles: next };
      }),
    );
    setActiveKey(patientKey);
  }, []);

  /** 同一患者内のタイルを配列上で入れ替える（DnD ヘッダードラッグによる並び替え）。 */
  const swapTiles = useCallback((patientKey: string, fromId: string, toId: string) => {
    setPatients((prev) =>
      prev.map((p) => {
        if (p.patientKey !== patientKey) return p;
        const tiles = [...p.tiles];
        const fi = tiles.findIndex((t) => t.id === fromId);
        const ti = tiles.findIndex((t) => t.id === toId);
        if (fi < 0 || ti < 0 || fi === ti) return p;
        [tiles[fi], tiles[ti]] = [tiles[ti], tiles[fi]];
        return { ...p, tiles };
      }),
    );
  }, []);

  /** タイルのシリーズ Sync 参加フラグを切り替える。 */
  const setTileSync = useCallback((patientKey: string, tileId: string, enabled: boolean) => {
    setPatients((prev) =>
      prev.map((p) => {
        if (p.patientKey !== patientKey) return p;
        return { ...p, tiles: p.tiles.map((t) => (t.id === tileId ? { ...t, syncEnabled: enabled } : t)) };
      }),
    );
  }, []);

  /** タイルの Fusion オーバーレイを設定または解除する。 */
  const setTileFusion = useCallback(
    (patientKey: string, tileId: string, overlay: FusionOverlay | undefined) => {
      setPatients((prev) =>
        prev.map((p) => {
          if (p.patientKey !== patientKey) return p;
          return { ...p, tiles: p.tiles.map((t) => (t.id === tileId ? { ...t, fusion: overlay } : t)) };
        }),
      );
    },
    [],
  );

  // ── コンテキスト適用 ──────────────────────────────────────

  /**
   * localStorage から ViewerContext を読み取って適用する。
   * patients に依存するため useCallback で再生成しつつ、ref 経由で常に最新版を呼ぶ。
   */
  const applyCtx = useCallback(async () => {
    const raw = localStorage.getItem("graphy-viewer-ctx");
    if (!raw) return;
    let ctx: ViewerContext;
    try {
      ctx = JSON.parse(raw) as ViewerContext;
    } catch {
      return;
    }
    if (ctx.ts <= processedCtxTs.current) return; // 処理済み
    processedCtxTs.current = ctx.ts;

    const { study, series } = ctx;
    const pKey = derivePatientKey(study);

    // 左ツリーを対象患者のスタディ一覧で更新。
    setInitialPatientId(study.patientId || null);
    setInitialStudyUid(study.studyInstanceUid);

    if (!series) {
      // スタディのみ選択: タイルは追加しない。患者タブが既にあればフォーカス。
      if (patients.some((p) => p.patientKey === pKey)) {
        setActiveKey(pKey);
      }
      return;
    }

    // シリーズが選択されている場合。
    const existingPatient = patients.find((p) => p.patientKey === pKey);
    if (existingPatient) {
      await replacePatientTiles(pKey, study, series);
    } else {
      await addTile(study, series);
    }
    setActiveKey(pKey);
  }, [patients, addTile, replacePatientTiles]);

  const applyCtxRef = useRef(applyCtx);
  useEffect(() => {
    applyCtxRef.current = applyCtx;
  }, [applyCtx]);

  useEffect(() => {
    void applyCtxRef.current();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === "graphy-viewer-ctx") void applyCtxRef.current();
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── レンダリング ──────────────────────────────────────────

  const activePatient = patients.find((p) => p.patientKey === activeKey) ?? null;

  return (
    <div
      style={shell}
      onDragOver={(e) => {
        // ウィンドウ内 DnD（並び替え/Fusion）のみ移動カーソルにする。
        if (!_dragPayload) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => {
        if (!_dragPayload) return;
        e.preventDefault();
      }}
    >
      <div style={header}>
        <strong style={{ fontSize: 14 }}>{t("viewer2d.title")}</strong>
        <span style={{ flex: 1 }} />
        <button onClick={() => window.close()} style={hbtn}>
          {t("common.close")}
        </button>
      </div>

      <div style={body}>
        <StudyBrowser
          mode={mode}
          patients={patients}
          onAdd={addTile}
          initialPatientId={initialPatientId}
          initialStudyUid={initialStudyUid}
        />

        <div style={rightArea}>
          {patients.length === 0 ? (
            <div style={emptyMsg}>{t("viewer2d.empty")}</div>
          ) : (
            <>
              <PatientTabBar
                patients={patients}
                activeKey={activeKey}
                onSelect={setActiveKey}
                onRemove={removePatient}
              />
              {activePatient && (
                <TileGrid
                  patient={activePatient}
                  mode={mode}
                  onRemoveTile={removeTile}
                  onSetCols={setPatientGridCols}
                  onInsertAdjacent={insertAdjacentTile}
                  onSwap={swapTiles}
                  onSetSync={setTileSync}
                  onSetFusion={setTileFusion}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── PatientTabBar ─────────────────────────────────────────────

function PatientTabBar({
  patients,
  activeKey,
  onSelect,
  onRemove,
}: {
  patients: PatientSession[];
  activeKey: string;
  onSelect: (key: string) => void;
  onRemove: (key: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div style={tabBar}>
      {patients.map((p) => {
        const label = p.patientName || p.patientId || "—";
        const isActive = p.patientKey === activeKey;
        return (
          <div key={p.patientKey} style={{ ...tabItem, ...(isActive ? tabItemActive : {}) }}>
            <button onClick={() => onSelect(p.patientKey)} style={tabLabel}>
              {label}
              <span style={{ fontSize: 11, color: "#8a98a6", marginLeft: 4 }}>({p.tiles.length})</span>
            </button>
            <button
              onClick={() => onRemove(p.patientKey)}
              style={tabClose}
              title={t("viewer2d.removePatient")}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── TileGrid ──────────────────────────────────────────────────

function TileGrid({
  patient,
  mode,
  onRemoveTile,
  onSetCols,
  onInsertAdjacent,
  onSwap,
  onSetSync,
  onSetFusion,
}: {
  patient: PatientSession;
  mode: "standalone" | "web";
  onRemoveTile: (patientKey: string, tileId: string) => void;
  onSetCols: (patientKey: string, cols: number) => void;
  onInsertAdjacent: (patientKey: string, targetId: string, before: boolean, study: Study, series: Series) => void;
  onSwap: (patientKey: string, fromId: string, toId: string) => void;
  onSetSync: (patientKey: string, tileId: string, enabled: boolean) => void;
  onSetFusion: (patientKey: string, tileId: string, overlay: FusionOverlay | undefined) => void;
}) {
  const { t } = useI18n();
  const n = patient.tiles.length;
  const cols = patient.gridCols > 0 ? patient.gridCols : autoTileCols(n);

  // 各タイルが現在表示中の C/T インデックス（tileId → {c,t}）。
  // Fusion で「ドロップ元タイルで表示中の C/T スタック」を引き継ぐために参照する。
  const tileDimsRef = useRef<Map<string, { c: number; t: number }>>(new Map());

  // リファレンスライン表示の ON/OFF（このタブ内の全タイルに適用）。
  const [refLines, setRefLines] = useState(false);

  // シリーズ Sync は SeriesViewer がグローバル coordinator（sliceSync）＋
  // Cornerstone synchronizer（表示状態）で直接連動する。ここでは Sync ON 枚数のみ把握し、
  // 2 枚以上で枠線ハイライト（実同期の成立判定は coordinator 側）。
  const syncedCount = useMemo(
    () => patient.tiles.filter((t) => t.syncEnabled).length,
    [patient.tiles],
  );
  const isSyncActive = syncedCount >= 2;

  // ドロップ処理（DnD ペイロード種別によってタイル操作を振り分け）
  const handleDrop = useCallback(
    (targetTileId: string, zone: "before" | "after" | "center" | "none") => {
      const payload = _dragPayload;
      if (!payload || zone === "none") return;

      if (payload.type === "series") {
        if (zone === "center") {
          // センタードロップ → Fusion オーバーレイに設定（既ロード済みシリーズも可）
          void fetchInstances(payload.study.studyInstanceUid, payload.series.seriesInstanceUid)
            .then((instances) => {
              onSetFusion(patient.patientKey, targetTileId, {
                study: payload.study,
                series: payload.series,
                instances,
                opacity: 0.5,
              });
            })
            .catch(() => {
              onSetFusion(patient.patientKey, targetTileId, {
                study: payload.study,
                series: payload.series,
                instances: [],
                opacity: 0.5,
              });
            });
        } else {
          // 既にタイルに読み込まれているシリーズは重複挿入しない
          const alreadyLoaded = patient.tiles.some(
            (t) => t.series.seriesInstanceUid === payload.series.seriesInstanceUid,
          );
          if (!alreadyLoaded) {
            void onInsertAdjacent(
              patient.patientKey,
              targetTileId,
              zone === "before",
              payload.study,
              payload.series,
            );
          }
        }
      } else if (payload.type === "tile") {
        if (payload.patientKey === patient.patientKey && payload.tileId !== targetTileId) {
          if (zone === "center") {
            // タイルヘッダを中央ドロップ → そのタイルのシリーズを Fusion に設定。
            // ドロップ元タイルで表示中だった C/T を引き継ぐ（1ch 目固定を避ける）。
            const srcTile = patient.tiles.find((t) => t.id === payload.tileId);
            if (srcTile) {
              const dims = tileDimsRef.current.get(payload.tileId);
              onSetFusion(patient.patientKey, targetTileId, {
                study: srcTile.study,
                series: srcTile.series,
                instances: srcTile.instances,
                opacity: 0.5,
                initialC: dims?.c ?? 0,
                initialT: dims?.t ?? 0,
              });
            }
          } else {
            onSwap(patient.patientKey, payload.tileId, targetTileId);
          }
        }
      }
    },
    // patient 全体に依存させる。patient.patientKey だけだとタイル追加後も
    // 古い patient.tiles を握ったままになり、srcTile / 重複判定が壊れる。
    [patient, onInsertAdjacent, onSwap, onSetFusion],
  );

  return (
    <div style={tileArea}>
      <div style={tileToolbar}>
        <span style={{ fontSize: 12, color: "#6b7785" }}>{t("viewer2d.layout")}</span>
        <select
          value={patient.gridCols}
          onChange={(e) => onSetCols(patient.patientKey, Number(e.target.value))}
          style={selectStyle}
        >
          <option value={0}>{t("viewer2d.layout.auto")}</option>
          {[1, 2, 3, 4].map((c) => (
            <option key={c} value={c}>
              {c} {t("viewer2d.layout.cols")}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 12, color: "#9aa6b2" }}>
          {t("viewer2d.tileCount", { n })}
        </span>
        <button
          onClick={() => setRefLines((v) => !v)}
          aria-pressed={refLines}
          style={{
            ...selectStyle,
            cursor: "pointer",
            color: refLines ? "#fff" : "#33404d",
            background: refLines ? "#0b5cad" : "#fff",
            border: refLines ? "1px solid #0b5cad" : "1px solid #cdd5de",
          }}
          title={t("viewer2d.refLines.toggle")}
        >
          ┼ {t("viewer2d.refLines.label")}
        </button>
        {isSyncActive && (
          <span style={{ fontSize: 11, color: "#0b5cad", marginLeft: "auto" }}>
            🔗 {t("viewer2d.sync.active")}
          </span>
        )}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gridAutoRows: "minmax(360px, 1fr)",
          gap: 8,
          padding: 8,
          flex: 1,
          overflowY: "auto",
        }}
      >
        {patient.tiles.map((tile) => (
          <TileCell
            key={tile.id}
            tile={tile}
            mode={mode}
            patientKey={patient.patientKey}
            syncActive={isSyncActive && tile.syncEnabled}
            syncEnabled={tile.syncEnabled}
            referenceLinesEnabled={refLines}
            onRemove={() => onRemoveTile(patient.patientKey, tile.id)}
            onSyncToggle={() => onSetSync(patient.patientKey, tile.id, !tile.syncEnabled)}
            onFusionChange={(overlay) => onSetFusion(patient.patientKey, tile.id, overlay)}
            onDimChange={(c, tIdx) => tileDimsRef.current.set(tile.id, { c, t: tIdx })}
            onDrop={handleDrop}
          />
        ))}
      </div>
    </div>
  );
}

// ── TileCell ──────────────────────────────────────────────────

function TileCell({
  tile,
  mode,
  patientKey,
  syncActive,
  syncEnabled,
  referenceLinesEnabled,
  onRemove,
  onSyncToggle,
  onFusionChange,
  onDimChange,
  onDrop,
}: {
  tile: Tile;
  mode: "standalone" | "web";
  patientKey: string;
  syncActive: boolean;
  syncEnabled: boolean;
  referenceLinesEnabled: boolean;
  onRemove: () => void;
  onSyncToggle: () => void;
  onFusionChange: (overlay: FusionOverlay | undefined) => void;
  onDimChange: (c: number, t: number) => void;
  onDrop: (targetTileId: string, zone: "before" | "after" | "center" | "none") => void;
}) {
  const { t } = useI18n();
  // ドラッグオーバー中のゾーン（ビジュアルオーバーレイ制御用）
  const [dropZone, setDropZone] = useState<"before" | "after" | "center" | "none" | null>(null);

  // Fusion: オーバーレイの C/T インデックス（ユーザーが任意に選択）
  const [fusionC, setFusionC] = useState(0);
  const [fusionT, setFusionT] = useState(0);
  // Fusion: オーバーレイのレイアウト（nC/nT の C/T スライダー制御用）
  const [fusionLayout, setFusionLayout] = useState<SeriesLayout>(() => buildSeriesLayout([]));
  // Fusion: オーバーレイの LUT（null でグレースケール）
  const [fusionLut, setFusionLut] = useState<LutData | null>(null);
  // fusion が切り替わったら C/T / LUT をリセット
  const prevFusionSeriesUid = useRef<string | null>(null);
  useEffect(() => {
    const uid = tile.fusion?.series.seriesInstanceUid ?? null;
    if (uid !== prevFusionSeriesUid.current) {
      prevFusionSeriesUid.current = uid;
      // ドロップ元タイルで表示中だった C/T を初期値に（無ければ 0）。
      setFusionC(tile.fusion?.initialC ?? 0);
      setFusionT(tile.fusion?.initialT ?? 0);
      setFusionLut(null);
    }
  }, [tile.fusion?.series.seriesInstanceUid]);

  const seriesLabel =
    tile.series.seriesDescription ||
    `#${tile.series.seriesNumber ?? "?"} ${tile.series.modality ?? ""}`.trim();
  const dateLabel = tile.study.studyDate || "";
  const studyDesc = tile.study.studyDescription || "";

  // Fusion オーバーレイ描画。base 画像の表示矩形(rect)・現在スライス(imageId/index)に重ねる。
  // useMemo で安定化（毎レンダ別関数だと Viewer2D 側の rect 初期計算 effect がループするため）。
  const renderFusionOverlay = useMemo<RenderOverlay | undefined>(() => {
    if (!tile.fusion || mode !== "standalone") return undefined;
    const fusion = tile.fusion;
    return (ctx) => (
      <FusionImageViewer
        rect={ctx.rect}
        baseImageId={ctx.imageId}
        baseIndex={ctx.index}
        baseCount={ctx.count}
        instances={fusion.instances}
        mode="standalone"
        studyUid={fusion.study.studyInstanceUid}
        seriesUid={fusion.series.seriesInstanceUid}
        overlayC={fusionC}
        overlayT={fusionT}
        lut={fusionLut}
        opacity={fusion.opacity}
        onLayoutChange={setFusionLayout}
      />
    );
  }, [tile.fusion, mode, fusionC, fusionT, fusionLut]);

  // ── タイルヘッダー DnD（タイル並び替え） ──

  const handleHeaderDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    _dragPayload = { type: "tile", patientKey, tileId: tile.id };
    e.dataTransfer.effectAllowed = "move";
    setGhostImage(e, seriesLabel);
  };
  const handleHeaderDragEnd = () => {
    _resetDragState();
  };

  // ── タイルボディ ドロップゾーン ──

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!_dragPayload) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const zone = getDropZone(e);
    setDropZone(zone);
  };
  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropZone(null);
  };
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const zone = getDropZone(e);
    setDropZone(null);
    onDrop(tile.id, zone);
  };

  // ドロップゾーンに応じたオーバーレイスタイル
  const overlayStyle = ((): React.CSSProperties | null => {
    if (!dropZone || dropZone === "none") return null;
    const base: React.CSSProperties = {
      position: "absolute", inset: 0, pointerEvents: "none", zIndex: 10, borderRadius: 7,
    };
    if (dropZone === "center") {
      return { ...base, background: "rgba(11,92,173,0.15)", outline: "2px dashed #0b5cad" };
    }
    if (dropZone === "before") {
      return {
        ...base,
        background: "linear-gradient(to right, rgba(11,92,173,0.22) 30%, transparent 70%)",
        borderLeft: "4px solid #0b5cad",
      };
    }
    return {
      ...base,
      background: "linear-gradient(to left, rgba(11,92,173,0.22) 30%, transparent 70%)",
      borderRight: "4px solid #0b5cad",
    };
  })();

  return (
    <div
      data-tile-id={tile.id}
      style={{
        ...tileBox,
        outline: syncActive ? "2px solid #0b5cad" : undefined,
        position: "relative",
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {overlayStyle && (
        <div style={overlayStyle}>
          {dropZone === "center" && (
            <div
              style={{
                position: "absolute",
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%)",
                color: "#0b5cad",
                fontSize: 12,
                fontWeight: 600,
                pointerEvents: "none",
                whiteSpace: "nowrap",
                background: "rgba(255,255,255,0.75)",
                padding: "2px 8px",
                borderRadius: 4,
              }}
            >
              {t("viewer2d.drop.center")}
            </div>
          )}
        </div>
      )}

      {/* ── ヘッダー（ドラッグハンドル） ── */}
      <div
        style={{ ...tileHead, cursor: "grab" }}
        draggable
        onDragStart={handleHeaderDragStart}
        onDragEnd={handleHeaderDragEnd}
      >
        <span style={tileTitle}>
          {[dateLabel, studyDesc, seriesLabel].filter(Boolean).join(" / ")}
        </span>

        {/* 画像エクスポート用ドラッグハンドル。
            ドラッグ → 外部(デスクトップ/他アプリ)へ PNG をネイティブドラッグ保存。
            クリック → PNG ダウンロード（web フォールバック兼用）。 */}
        <span
          role="button"
          tabIndex={0}
          draggable
          onDragStart={(e) => { e.stopPropagation(); startTileDrag(e, tile.id, seriesLabel); }}
          onClick={(e) => { e.stopPropagation(); captureAndDownload(tile.id); }}
          style={{ ...xbtn, cursor: "grab", fontSize: 13, lineHeight: 1, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
          title={t("viewer2d.exportDrag")}
        >
          ⤓
        </span>

        {/* Sync トグルボタン */}
        <button
          onClick={(e) => { e.stopPropagation(); onSyncToggle(); }}
          style={{
            ...xbtn,
            color: tile.syncEnabled ? "#0b5cad" : "#8a98a6",
            border: tile.syncEnabled ? "1px solid #b0cce8" : "1px solid #cdd5de",
            background: tile.syncEnabled ? "#eef4fc" : "#fff",
            fontSize: 14,
            lineHeight: 1,
          }}
          title={t("viewer2d.sync.toggle")}
        >
          🔗
        </button>

        <button onClick={onRemove} style={xbtn} title={t("viewer2d.removeTile")}>
          ×
        </button>
      </div>

      {/* ── コンテンツ（ベース＋ Fusion オーバーレイは Viewer2D 内で base 画像に重畳） ── */}
      <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
        {mode === "standalone" ? (
          <SeriesViewer
            instances={tile.instances}
            mode="standalone"
            studyUid={tile.study.studyInstanceUid}
            seriesUid={tile.series.seriesInstanceUid}
            fillHeight
            syncEnabled={syncEnabled}
            referenceLinesEnabled={referenceLinesEnabled}
            referenceLabel={seriesLabel}
            onDimChange={onDimChange}
            renderFusionOverlay={renderFusionOverlay}
          />
        ) : (
          <div style={{ padding: 12, fontSize: 12, color: "#8a6d3b" }}>{t("viewer.webTodo")}</div>
        )}
      </div>

      {/* Fusion コントロールバー */}
      {tile.fusion && mode === "standalone" && (
        <FusionControlBar
          seriesLabel={
            tile.fusion.series.seriesDescription ||
            `#${tile.fusion.series.seriesNumber ?? "?"} ${tile.fusion.series.modality ?? ""}`.trim()
          }
          opacity={tile.fusion.opacity}
          fusionC={fusionC}
          fusionT={fusionT}
          nC={fusionLayout.nC}
          nT={fusionLayout.nT}
          cDimension={fusionLayout.cDimension}
          tDimension={fusionLayout.tDimension}
          fusionLut={fusionLut}
          onOpacityChange={(v) => onFusionChange({ ...tile.fusion!, opacity: v })}
          onCChange={setFusionC}
          onTChange={setFusionT}
          onLutChange={setFusionLut}
          onRemove={() => onFusionChange(undefined)}
        />
      )}
    </div>
  );
}

// ── FusionControlBar ─────────────────────────────────────────

function FusionControlBar({
  seriesLabel,
  opacity,
  fusionC,
  fusionT,
  nC,
  nT,
  cDimension,
  tDimension,
  fusionLut,
  onOpacityChange,
  onCChange,
  onTChange,
  onLutChange,
  onRemove,
}: {
  seriesLabel: string;
  opacity: number;
  fusionC: number;
  fusionT: number;
  nC: number;
  nT: number;
  cDimension?: string | null;
  tDimension?: string | null;
  fusionLut: LutData | null;
  onOpacityChange: (v: number) => void;
  onCChange: (v: number) => void;
  onTChange: (v: number) => void;
  onLutChange: (lut: LutData | null) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const [showLutDialog, setShowLutDialog] = useState(false);
  return (
    <div style={fusionBar}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span style={{ fontSize: 11, color: "#0b5cad", flex: "none" }}>🔀</span>
        <span
          style={{
            fontSize: 11,
            color: "#33404d",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
        >
          {seriesLabel}
        </span>
      </div>

      {/* 透過度 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flex: "none" }}>
        <span style={{ fontSize: 11, color: "#5a6672", flex: "none" }}>{t("viewer2d.fusion.opacity")}</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(opacity * 100)}
          onChange={(e) => onOpacityChange(Number(e.target.value) / 100)}
          style={{ width: 70 }}
        />
        <span style={{ fontSize: 11, color: "#5a6672", minWidth: 28, textAlign: "right" }}>
          {Math.round(opacity * 100)}%
        </span>

        {/* LUT ボタン */}
        <div style={{ display: "flex", alignItems: "center", gap: 3, flex: "none" }}>
          {fusionLut && (
            <div
              style={{
                width: 36,
                height: 11,
                border: "1px solid #b0b8c4",
                borderRadius: 2,
                overflow: "hidden",
                flexShrink: 0,
              }}
            >
              <ColorBar lut={fusionLut} />
            </div>
          )}
          <button
            onClick={() => setShowLutDialog(true)}
            style={{
              fontSize: 11,
              padding: "1px 6px",
              borderRadius: 3,
              border: "1px solid #c0c8d4",
              background: fusionLut ? "#e8f0fc" : "#f5f7fa",
              color: fusionLut ? "#0b5cad" : "#5a6672",
              cursor: "pointer",
              lineHeight: 1.4,
            }}
          >
            {t("viewer2d.fusion.lut")}
          </button>
        </div>
      </div>

      {showLutDialog && (
        <LutDialog
          currentLutName={fusionLut?.name ?? null}
          onSelect={(lut) => onLutChange(lut)}
          onClose={() => setShowLutDialog(false)}
        />
      )}

      {/* C スライダー（マルチチャンネルのとき） */}
      {nC > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: 4, flex: "none" }}>
          <span style={{ fontSize: 11, color: "#5a6672" }}>
            C {fusionC + 1}/{nC}{cDimension ? ` (${cDimension})` : ""}
          </span>
          <input
            type="range"
            min={0}
            max={nC - 1}
            value={fusionC}
            onChange={(e) => onCChange(Number(e.target.value))}
            style={{ width: 60 }}
          />
        </div>
      )}

      {/* T スライダー（時系列のとき） */}
      {nT > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: 4, flex: "none" }}>
          <span style={{ fontSize: 11, color: "#5a6672" }}>
            T {fusionT + 1}/{nT}{tDimension ? ` (${tDimension})` : ""}
          </span>
          <input
            type="range"
            min={0}
            max={nT - 1}
            value={fusionT}
            onChange={(e) => onTChange(Number(e.target.value))}
            style={{ width: 60 }}
          />
        </div>
      )}

      <button onClick={onRemove} style={fusionRemoveBtn} title={t("viewer2d.fusion.remove")}>
        ×
      </button>
    </div>
  );
}

// ── StudyBrowser（左パネル） ───────────────────────────────────

/**
 * 左パネル: 患者のスタディ一覧ツリー＋シリーズ追加。
 *
 * - initialPatientId が設定されると自動的にその患者の全スタディを取得してツリーを構成する。
 * - initialStudyUid が設定されると対応するスタディノードを自動展開する。
 * - 手動検索フォームで別患者のスタディを追加検索することもできる。
 */
function StudyBrowser({
  mode,
  patients,
  onAdd,
  initialPatientId,
  initialStudyUid,
}: {
  mode: "standalone" | "web";
  patients: PatientSession[];
  onAdd: (study: Study, series: Series) => void;
  initialPatientId?: string | null;
  initialStudyUid?: string | null;
}) {
  const { t } = useI18n();
  const [patientId, setPatientId] = useState("");
  const [patientName, setPatientName] = useState("");
  // undefined = 未検索, null = 検索中, Study[] = 結果（空配列含む）
  const [studies, setStudies] = useState<Study[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const loadedTileIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of patients) {
      for (const tile of p.tiles) ids.add(tile.id);
    }
    return ids;
  }, [patients]);

  const search = useCallback((filters: Parameters<typeof fetchStudies>[0]) => {
    setStudies(null);
    setError(null);
    fetchStudies(filters)
      .then(setStudies)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  const searchManual = () => {
    const id = patientId.trim();
    const name = patientName.trim();
    if (!id && !name) {
      setError(t("viewer2d.searchPrompt"));
      return;
    }
    // 両方入力 → ID かつ 氏名 の AND 検索。片方のみ → そのフィールドで全件検索。日付絞りなし。
    search({ patientId: id || undefined, patientName: name || undefined });
  };

  // initialPatientId が変化したら、その患者の全スタディを自動取得してツリーを構成。
  const prevInitialPatientId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (prevInitialPatientId.current === initialPatientId) return;
    prevInitialPatientId.current = initialPatientId;

    if (initialPatientId) {
      setPatientId(initialPatientId);
      search({ patientId: initialPatientId }); // 日付フィルタなし（全過去スタディ）
    }
    // コンテキストなし: 自動検索しない（ユーザーが検索条件を入力して実行する）
  }, [initialPatientId, search]);

  return (
    <div style={tree}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
        <input
          value={patientId}
          onChange={(e) => setPatientId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && searchManual()}
          placeholder={t("field.patientId")}
          style={treeInput}
        />
        <input
          value={patientName}
          onChange={(e) => setPatientName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && searchManual()}
          placeholder={t("field.patientName")}
          style={treeInput}
        />
        <button onClick={searchManual} style={searchBtn}>
          {t("common.search")}
        </button>
      </div>

      {error && <div style={{ color: "#b00020", fontSize: 12 }}>{error}</div>}
      {!error && studies === undefined && (
        <div style={{ fontSize: 12, color: "#888" }}>{t("viewer2d.searchPrompt")}</div>
      )}
      {!error && studies === null && (
        <div style={{ fontSize: 12, color: "#888" }}>{t("common.loading")}</div>
      )}
      {studies != null && studies.length === 0 && (
        <div style={{ fontSize: 12, color: "#888" }}>{t("common.noData")}</div>
      )}
      {studies != null &&
        studies.map((s) => (
          <StudyNode
            key={s.studyInstanceUid}
            study={s}
            mode={mode}
            loadedTileIds={loadedTileIds}
            onAdd={onAdd}
            autoOpen={s.studyInstanceUid === initialStudyUid}
          />
        ))}
    </div>
  );
}

// ── StudyNode ─────────────────────────────────────────────────

function StudyNode({
  study,
  mode,
  loadedTileIds,
  onAdd,
  autoOpen = false,
}: {
  study: Study;
  mode: "standalone" | "web";
  loadedTileIds: Set<string>;
  onAdd: (study: Study, series: Series) => void;
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(autoOpen);
  const [series, setSeries] = useState<Series[] | null>(null);

  // autoOpen の場合はマウント時にシリーズを自動ロード。
  useEffect(() => {
    if (autoOpen && series === null) {
      fetchSeries(study.studyInstanceUid)
        .then(setSeries)
        .catch(() => setSeries([]));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !series) {
      fetchSeries(study.studyInstanceUid)
        .then(setSeries)
        .catch(() => setSeries([]));
    }
  };

  const patientLabel = study.patientName || study.patientId || "—";
  const studyMeta = [study.studyDate, study.studyDescription, study.modality]
    .filter(Boolean)
    .join(" · ");

  return (
    <div style={{ marginBottom: 2 }}>
      <div onClick={toggle} style={studyRow}>
        <span style={{ flex: "none", color: "#6b7785", fontSize: 11 }}>{open ? "▾" : "▸"}</span>
        <div style={{ overflow: "hidden", minWidth: 0 }}>
          <div
            style={{
              fontWeight: 600,
              fontSize: 12,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {patientLabel}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "#6b7785",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {studyMeta}
          </div>
        </div>
      </div>

      {open &&
        (series ?? []).map((se) => {
          const tileId = `${study.studyInstanceUid}|${se.seriesInstanceUid}`;
          const loaded = loadedTileIds.has(tileId);
          const seriesLabel = `#${se.seriesNumber ?? "?"} ${se.modality ?? ""} ${se.seriesDescription ?? ""}`.trim();

          return (
            <div
              key={se.seriesInstanceUid}
              style={{
                ...seriesRow,
                opacity: mode !== "standalone" ? 0.7 : loaded ? 0.75 : 1,
                cursor: mode === "standalone" ? "grab" : "default",
              }}
              draggable={mode === "standalone"}
              onDragStart={(e) => {
                _dragPayload = { type: "series", study, series: se, label: seriesLabel };
                e.dataTransfer.effectAllowed = "move";
                setGhostImage(e, seriesLabel);
              }}
              onDragEnd={() => {
                _resetDragState();
              }}
            >
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: 12,
                  color: loaded ? "#0b5cad" : "#33404d",
                  cursor: mode === "standalone" && !loaded ? "grab" : "default",
                }}
              >
                #{se.seriesNumber ?? "?"} {se.modality ?? ""} {se.seriesDescription ?? ""} (
                {se.numberOfInstances})
              </span>
              <button
                onClick={() => !loaded && onAdd(study, se)}
                disabled={mode !== "standalone" || loaded}
                style={{
                  ...addBtn,
                  ...(loaded
                    ? { color: "#0b5cad", border: "1px solid #b0cce8", background: "#eef4fc" }
                    : {}),
                }}
                title={loaded ? "表示中" : "タイルに追加"}
              >
                {loaded ? "✓" : "＋"}
              </button>
            </div>
          );
        })}
    </div>
  );
}

// ── スタイル ──────────────────────────────────────────────────

const shell: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  fontFamily: "system-ui, sans-serif",
  background: "#eef1f4",
  color: "#1a1a1a",
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 12px",
  borderBottom: "1px solid #e6eaee",
  background: "#f7f9fb",
  flex: "none",
};
const hbtn: React.CSSProperties = {
  padding: "4px 12px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  cursor: "pointer",
  fontSize: 13,
};
const body: React.CSSProperties = { flex: 1, display: "flex", minHeight: 0 };

// 左パネル
const tree: React.CSSProperties = {
  width: 280,
  flex: "none",
  borderRight: "1px solid #e6eaee",
  padding: 12,
  overflowY: "auto",
  background: "#fafbfc",
};
const treeInput: React.CSSProperties = {
  padding: "5px 8px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  fontSize: 13,
  width: "100%",
  boxSizing: "border-box" as const,
};
const searchBtn: React.CSSProperties = {
  padding: "5px 10px",
  border: "1px solid #0b5cad",
  borderRadius: 6,
  background: "#0b5cad",
  color: "#fff",
  cursor: "pointer",
  fontSize: 12,
  width: "100%",
};
const studyRow: React.CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "flex-start",
  padding: "5px 4px",
  cursor: "pointer",
  borderRadius: 4,
};
const seriesRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 4px 3px 20px",
};
const addBtn: React.CSSProperties = {
  flex: "none",
  border: "1px solid #cdd5de",
  borderRadius: 5,
  background: "#fff",
  cursor: "pointer",
  fontSize: 12,
  padding: "1px 7px",
};

// 右エリア
const rightArea: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  minHeight: 0,
};
const emptyMsg: React.CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "#8a98a6",
  fontSize: 14,
  padding: 24,
  textAlign: "center",
};

// 患者タブバー
const tabBar: React.CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  padding: "6px 8px 0",
  background: "#f0f3f6",
  borderBottom: "2px solid #d7dde3",
  flex: "none",
  overflowX: "auto",
  gap: 2,
};
const tabItem: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  border: "1px solid #c8d0d8",
  borderBottom: "none",
  borderRadius: "6px 6px 0 0",
  background: "#e4e9ee",
  padding: "0 2px 0 10px",
  gap: 0,
  flexShrink: 0,
  maxWidth: 220,
};
const tabItemActive: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #b0bcc8",
  borderBottom: "1px solid #fff",
  marginBottom: -2,
};
const tabLabel: React.CSSProperties = {
  flex: 1,
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontSize: 13,
  padding: "7px 0",
  textAlign: "left",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 60,
};
const tabClose: React.CSSProperties = {
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontSize: 14,
  padding: "4px 8px",
  color: "#8a98a6",
  flexShrink: 0,
  lineHeight: 1,
};

// タイルエリア
const tileArea: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  background: "#eef1f4",
};
const tileToolbar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 12px",
  background: "#f2f5f8",
  borderBottom: "1px solid #dde4ea",
  flex: "none",
};
const selectStyle: React.CSSProperties = {
  padding: "3px 6px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  fontSize: 13,
  background: "#fff",
};
const tileBox: React.CSSProperties = {
  border: "1px solid #d7dde3",
  borderRadius: 8,
  background: "#fff",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  height: "100%",
  boxSizing: "border-box",
};
const tileHead: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 6px",
  background: "#f2f5f8",
  borderBottom: "1px solid #e1e7ee",
  flex: "none",
  userSelect: "none",
};
const tileTitle: React.CSSProperties = {
  flex: 1,
  fontSize: 12,
  fontWeight: 600,
  color: "#33404d",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const xbtn: React.CSSProperties = {
  flex: "none",
  border: "1px solid #cdd5de",
  borderRadius: 5,
  background: "#fff",
  cursor: "pointer",
  fontSize: 13,
  lineHeight: 1,
  padding: "1px 6px",
};
const fusionBar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
  padding: "5px 10px",
  borderTop: "1px solid #e1e7ee",
  background: "#f0f5fb",
  flex: "none",
};
const fusionRemoveBtn: React.CSSProperties = {
  flex: "none",
  border: "1px solid #cdd5de",
  borderRadius: 5,
  background: "#fff",
  cursor: "pointer",
  fontSize: 13,
  lineHeight: 1,
  padding: "1px 6px",
  marginLeft: "auto",
};
