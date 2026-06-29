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
} from "../api";
import { SeriesViewer } from "../viewer/SeriesViewer";
import { useI18n } from "../i18n/i18n";

// ── 型定義 ────────────────────────────────────────────────────

interface Tile {
  id: string;        // `${studyUid}|${seriesUid}`
  study: Study;
  series: Series;
  instances: Instance[];
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

// 患者識別キー（DICOM patientId 優先、無ければ patientName、最終は studyUid）。
function derivePatientKey(study: Study): string {
  return study.patientId || study.patientName || study.studyInstanceUid;
}

// タイルグリッドの自動列数 ceil(√N)。1→1, 2→2, 3-4→2, 5-9→3, ...
function autoTileCols(n: number): number {
  if (n <= 1) return 1;
  return Math.ceil(Math.sqrt(n));
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
    const tile: Tile = { id: tileId, study, series, instances };

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
    const tile: Tile = { id: tileId, study, series, instances };
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
      // 同一患者 → タイルをクリアして新シリーズで置き換え。
      await replacePatientTiles(pKey, study, series);
    } else {
      // 未登録患者 → 新しい患者タブを追加。
      await addTile(study, series);
    }
    setActiveKey(pKey);
  }, [patients, addTile, replacePatientTiles]);

  // 常に最新の applyCtx を参照するための ref。
  const applyCtxRef = useRef(applyCtx);
  useEffect(() => {
    applyCtxRef.current = applyCtx;
  }, [applyCtx]);

  // マウント時: 既存 localStorage コンテキストを読み取る（新規ウィンドウ用）。
  useEffect(() => {
    void applyCtxRef.current();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // storage イベント: 既存ウィンドウへのコンテキスト更新通知（MainScreen が別スタディを開いた場合）。
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
    <div style={shell}>
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
}: {
  patient: PatientSession;
  mode: "standalone" | "web";
  onRemoveTile: (patientKey: string, tileId: string) => void;
  onSetCols: (patientKey: string, cols: number) => void;
}) {
  const { t } = useI18n();
  const n = patient.tiles.length;
  const cols = patient.gridCols > 0 ? patient.gridCols : autoTileCols(n);

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
            onRemove={() => onRemoveTile(patient.patientKey, tile.id)}
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
  onRemove,
}: {
  tile: Tile;
  mode: "standalone" | "web";
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const seriesLabel =
    tile.series.seriesDescription ||
    `#${tile.series.seriesNumber ?? "?"} ${tile.series.modality ?? ""}`.trim();
  const dateLabel = tile.study.studyDate || "";
  const studyDesc = tile.study.studyDescription || "";
  return (
    <div style={tileBox}>
      <div style={tileHead}>
        <span style={tileTitle}>
          {[dateLabel, studyDesc, seriesLabel].filter(Boolean).join(" / ")}
        </span>
        <button onClick={onRemove} style={xbtn} title={t("viewer2d.removeTile")}>
          ×
        </button>
      </div>
      {mode === "standalone" ? (
        <SeriesViewer
          instances={tile.instances}
          mode="standalone"
          studyUid={tile.study.studyInstanceUid}
          seriesUid={tile.series.seriesInstanceUid}
          fillHeight
        />
      ) : (
        <div style={{ padding: 12, fontSize: 12, color: "#8a6d3b" }}>{t("viewer.webTodo")}</div>
      )}
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
          return (
            <div key={se.seriesInstanceUid} style={seriesRow}>
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: 12,
                  color: loaded ? "#0b5cad" : "#33404d",
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
                    ? { color: "#0b5cad", borderColor: "#b0cce8", background: "#eef4fc" }
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
  borderColor: "#b0bcc8",
  borderBottomColor: "#fff",
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
  gap: 6,
  padding: "4px 8px",
  background: "#f2f5f8",
  borderBottom: "1px solid #e1e7ee",
  flex: "none",
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
  padding: "1px 7px",
};
