import { useEffect, useMemo, useState } from "react";
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

interface Tile {
  id: string;
  study: Study;
  series: Series;
  instances: Instance[];
}

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * 2D Viewer 画面（Phase 1 骨組み）。左にスタディ/シリーズツリー、右にタイル格子。
 * タイルには SeriesViewer をそのまま入れる。スライス同期/参照線/表示Sync は次フェーズ。
 */
export function Viewer2DScreen({ status }: { status: AppStatus | null }) {
  const { t } = useI18n();
  const mode = status?.mode === "standalone" ? "standalone" : "web";
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [cols, setCols] = useState(2);

  const addTile = async (study: Study, series: Series) => {
    const id = `${study.studyInstanceUid}|${series.seriesInstanceUid}`;
    if (tiles.some((x) => x.id === id)) return;
    const instances = await fetchInstances(study.studyInstanceUid, series.seriesInstanceUid);
    setTiles((prev) => (prev.some((x) => x.id === id) ? prev : [...prev, { id, study, series, instances }]));
  };
  const removeTile = (id: string) => setTiles((prev) => prev.filter((x) => x.id !== id));

  return (
    <div style={shell}>
      <div style={header}>
        <strong style={{ fontSize: 14 }}>{t("viewer2d.title")}</strong>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: "#6b7785" }}>{t("series.columns")}</span>
        <select value={cols} onChange={(e) => setCols(Number(e.target.value))} style={select}>
          {[1, 2, 3, 4].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button onClick={() => window.close()} style={hbtn}>
          {t("common.close")}
        </button>
      </div>

      <div style={body}>
        <StudyTree mode={mode} onAdd={addTile} />

        <div style={tilesArea}>
          {tiles.length === 0 && <div style={{ color: "#8a98a6", padding: 24 }}>{t("viewer2d.empty")}</div>}
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 10 }}>
            {tiles.map((tile) => (
              <div key={tile.id} style={tileBox}>
                <div style={tileHead}>
                  <span style={tileTitle}>
                    {tile.study.patientName || tile.study.patientId || "—"} / {tile.series.seriesDescription || `#${tile.series.seriesNumber ?? "?"}`}
                  </span>
                  <button onClick={() => removeTile(tile.id)} style={xbtn} title={t("viewer2d.removeTile")}>
                    ×
                  </button>
                </div>
                {mode === "standalone" ? (
                  <SeriesViewer
                    instances={tile.instances}
                    mode="standalone"
                    studyUid={tile.study.studyInstanceUid}
                    seriesUid={tile.series.seriesInstanceUid}
                  />
                ) : (
                  <div style={{ padding: 12, fontSize: 12, color: "#8a6d3b" }}>{t("viewer.webTodo")}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 左ペイン: スタディ検索 → 展開でシリーズ → 「＋」でタイル追加。 */
function StudyTree({ mode, onAdd }: { mode: "standalone" | "web"; onAdd: (s: Study, se: Series) => void }) {
  const { t } = useI18n();
  const initialFrom = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return ymd(d);
  }, []);
  const [patientId, setPatientId] = useState("");
  const [patientName, setPatientName] = useState("");
  const [studies, setStudies] = useState<Study[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = () => {
    setStudies(null);
    setError(null);
    fetchStudies({ patientId, patientName, studyDateFrom: initialFrom, studyDateTo: ymd(new Date()) })
      .then(setStudies)
      .catch((e: unknown) => setError(String(e)));
  };
  useEffect(() => {
    search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={tree}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
        <input
          value={patientId}
          onChange={(e) => setPatientId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder={t("field.patientId")}
          style={treeInput}
        />
        <input
          value={patientName}
          onChange={(e) => setPatientName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder={t("field.patientName")}
          style={treeInput}
        />
        <button onClick={search} style={searchBtn}>
          {t("common.search")} ({t("viewer2d.lastWeek")})
        </button>
      </div>
      {error && <div style={{ color: "#b00020", fontSize: 12 }}>{error}</div>}
      {!error && !studies && <div style={{ fontSize: 12, color: "#888" }}>{t("common.loading")}</div>}
      {studies && studies.map((s) => <StudyNode key={s.studyInstanceUid} study={s} mode={mode} onAdd={onAdd} />)}
    </div>
  );
}

function StudyNode({
  study,
  mode,
  onAdd,
}: {
  study: Study;
  mode: "standalone" | "web";
  onAdd: (s: Study, se: Series) => void;
}) {
  const [open, setOpen] = useState(false);
  const [series, setSeries] = useState<Series[] | null>(null);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !series) {
      fetchSeries(study.studyInstanceUid).then(setSeries).catch(() => setSeries([]));
    }
  };
  return (
    <div style={{ marginBottom: 2 }}>
      <div onClick={toggle} style={studyRow}>
        <span>{open ? "▾" : "▸"}</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {study.patientName || study.patientId || "—"} · {study.studyDate || ""} · {study.modality || ""}
        </span>
      </div>
      {open &&
        (series ?? []).map((se) => (
          <div key={se.seriesInstanceUid} style={seriesRow}>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              #{se.seriesNumber ?? "?"} {se.modality || ""} {se.seriesDescription || ""} ({se.numberOfInstances})
            </span>
            <button onClick={() => onAdd(study, se)} disabled={mode !== "standalone"} style={addBtn}>
              ＋
            </button>
          </div>
        ))}
    </div>
  );
}

const shell: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  fontFamily: "system-ui, sans-serif",
  background: "#fff",
  color: "#1a1a1a",
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 12px",
  borderBottom: "1px solid #e6eaee",
  background: "#f7f9fb",
};
const select: React.CSSProperties = { padding: "3px 6px", border: "1px solid #cdd5de", borderRadius: 6, fontSize: 13 };
const hbtn: React.CSSProperties = {
  padding: "4px 12px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  cursor: "pointer",
  fontSize: 13,
};
const body: React.CSSProperties = { flex: 1, display: "flex", minHeight: 0 };
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
};
const searchBtn: React.CSSProperties = {
  padding: "5px 10px",
  border: "1px solid #0b5cad",
  borderRadius: 6,
  background: "#0b5cad",
  color: "#fff",
  cursor: "pointer",
  fontSize: 12,
};
const studyRow: React.CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
  padding: "4px 4px",
  cursor: "pointer",
  fontSize: 13,
  borderRadius: 4,
};
const seriesRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 4px 3px 22px",
  fontSize: 12,
  color: "#445",
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
const tilesArea: React.CSSProperties = { flex: 1, overflow: "auto", padding: 12, background: "#eef1f4" };
const tileBox: React.CSSProperties = { border: "1px solid #d7dde3", borderRadius: 8, background: "#fff", overflow: "hidden" };
const tileHead: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 8px",
  background: "#f2f5f8",
  borderBottom: "1px solid #e1e7ee",
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
