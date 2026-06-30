/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  echoDicom,
  fetchRemoteAes,
  qrFindStudies,
  type AppStatus,
  type QrSeriesRow,
  type QrStudyRow,
  type RemoteAe,
  type Study,
  type Series,
  type StudyFilters,
} from "../api";
import { fetchSettings } from "../settings/settingsApi";
import { subscribeRemoteAesChanged } from "../remoteAeEvents";
import { desktop } from "../desktopBridge";
import { useI18n } from "../i18n/i18n";
import { QrSearchBar } from "./QrSearchBar";
import { QrTable } from "./QrTable";
import { filtersToMatchKeys } from "./qrUtil";

type DestResult = { studies: QrStudyRow[] | null; loading: boolean; error: string | null };

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * Query/Retrieve ウィンドウ。Destination(PACS) ごとにタブ展開し、共有検索メニュー（Today 既定）で
 * 全タブへ C-FIND。Echo が通った Destination のみタブ化。AutoRefresh / 保存済み非表示 / 設定変更追従。
 */
export function QRScreen({ status }: { status: AppStatus | null }) {
  const { t } = useI18n();

  const [tabs, setTabs] = useState<RemoteAe[]>([]); // Echo が通った Destination
  const [active, setActive] = useState<string>("");
  const [results, setResults] = useState<Map<string, DestResult>>(new Map());
  const [filters, setFilters] = useState<StudyFilters>({ studyDateFrom: todayStr(), studyDateTo: todayStr() });
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const [busy, setBusy] = useState(false);
  const [hideStored, setHideStored] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [intervalSec, setIntervalSec] = useState(60);
  const [largeThreshold, setLargeThreshold] = useState(500);
  const [banner, setBanner] = useState<string | null>(null);

  const mode = status?.mode ?? "standalone";

  /** 全 Destination を Echo し、通ったものを返す（タブ候補）。 */
  const echoAll = useCallback(async (aes: RemoteAe[]): Promise<RemoteAe[]> => {
    const checks = await Promise.all(
      aes.map(async (ae) => {
        try {
          const r = await echoDicom({ host: ae.host, port: ae.port, calledAet: ae.aeTitle });
          return r.success ? ae : null;
        } catch {
          return null;
        }
      }),
    );
    return checks.filter((x): x is RemoteAe => x !== null);
  }, []);

  /** 1 つの Destination に C-FIND（現在の検索条件）。 */
  const queryDest = useCallback(async (ae: RemoteAe) => {
    setResults((m) => new Map(m).set(ae.aeTitle, { studies: null, loading: true, error: null }));
    try {
      const rows = await qrFindStudies(
        { host: ae.host, port: ae.port, calledAet: ae.aeTitle },
        filtersToMatchKeys(filtersRef.current),
      );
      setResults((m) => new Map(m).set(ae.aeTitle, { studies: rows, loading: false, error: null }));
    } catch (e) {
      setResults((m) => new Map(m).set(ae.aeTitle, { studies: null, loading: false, error: String(e) }));
    }
  }, []);

  /**
   * Query ボタン処理（仕様の順序）:
   * ① 登録済み全 Destination を再 Echo → 通信可をタブへ ② 通信可へ C-FIND ③ 通信不可のタブを削除。
   */
  const runQuery = useCallback(async () => {
    setBusy(true);
    setBanner(null);
    try {
      const aes = await fetchRemoteAes();
      const reachable = await echoAll(aes);
      setTabs(reachable);
      const reachableTitles = new Set(reachable.map((a) => a.aeTitle));
      // 通信不可のタブの結果は破棄
      setResults((m) => {
        const n = new Map<string, DestResult>();
        for (const [k, v] of m) if (reachableTitles.has(k)) n.set(k, v);
        return n;
      });
      setActive((cur) => (reachableTitles.has(cur) ? cur : reachable[0]?.aeTitle ?? ""));
      if (reachable.length === 0) {
        setBanner(aes.length === 0 ? t("qr.noDestinations") : t("qr.noneReachable"));
      } else {
        await Promise.all(reachable.map((ae) => queryDest(ae)));
      }
    } finally {
      setBusy(false);
    }
  }, [echoAll, queryDest, t]);

  /** タブ再構築のみ（再 Echo→タブ更新→再クエリ）。設定変更/初回起動で使用。 */
  const rebuildTabs = useCallback(async () => {
    await runQuery();
  }, [runQuery]);

  // 起動時: 設定読込→タブ構築→初回クエリ。
  useEffect(() => {
    let cancelled = false;
    fetchSettings()
      .then((s) => {
        if (cancelled) return;
        const onStart = s["qr.autoRefreshOnStartup"] === "true";
        const iv = Number(s["qr.autoRefreshIntervalSec"]);
        const th = Number(s["qr.largeRetrieveThreshold"]);
        if (Number.isFinite(iv) && iv >= 10) setIntervalSec(iv);
        if (Number.isFinite(th) && th >= 1) setLargeThreshold(th);
        if (onStart) setAutoRefresh(true);
      })
      .catch(() => { /* 既定値で続行 */ })
      .finally(() => {
        if (!cancelled) void rebuildTabs();
      });
    return () => {
      cancelled = true;
    };
    // 初回のみ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Destination 設定変更（別ウィンドウの Settings）に追従して全タブ再構築。
  useEffect(() => {
    return subscribeRemoteAesChanged(() => {
      setBanner(t("qr.destinationsChanged"));
      void rebuildTabs();
    });
  }, [rebuildTabs, t]);

  // AutoRefresh: オン時、interval ごとに runQuery。
  useEffect(() => {
    if (!autoRefresh) return;
    const h = window.setInterval(() => void runQuery(), Math.max(10, intervalSec) * 1000);
    return () => window.clearInterval(h);
  }, [autoRefresh, intervalSec, runQuery]);

  const openInViewer = useCallback((study: QrStudyRow, series?: QrSeriesRow) => {
    const s: Study = {
      studyInstanceUid: study.studyInstanceUid,
      patientId: study.patientId ?? "",
      patientName: study.patientName,
      studyDate: study.studyDate,
      studyDescription: study.studyDescription,
      modality: study.modality,
      numberOfInstances: study.numberOfStudyRelatedInstances,
    };
    const se: Series | undefined = series
      ? {
          seriesInstanceUid: series.seriesInstanceUid,
          modality: series.modality,
          seriesNumber: series.seriesNumber,
          seriesDescription: series.seriesDescription,
          numberOfInstances: series.numberOfSeriesRelatedInstances,
        }
      : undefined;
    try {
      localStorage.setItem("graphy-viewer-ctx", JSON.stringify({ study: s, series: se, ts: Date.now() }));
    } catch { /* ignore */ }
    const d = desktop();
    if (d?.openViewer) void d.openViewer("2dviewer");
    else window.open(`${window.location.pathname}#2dviewer`, "graphy-2dviewer");
  }, []);

  const activeResult = results.get(active);

  return (
    <div style={shell}>
      <div style={headerBar}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>{t("qr.title")}</span>
        <span style={modeChip}>{mode === "web" ? t("qr.mode.web") : t("qr.mode.standalone")}</span>
        <div style={{ flex: 1 }} />
        <label style={toggleLabel}>
          <input type="checkbox" checked={hideStored} onChange={(e) => setHideStored(e.target.checked)} />
          {t("qr.hideStored")}
        </label>
        <label style={toggleLabel} title={t("qr.autoRefresh.help", { sec: intervalSec })}>
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          {t("qr.autoRefresh", { sec: intervalSec })}
        </label>
        <button
          onClick={() => void runQuery()}
          disabled={busy}
          style={{ ...queryBtn, background: busy ? "#9fb6cf" : "#0b5cad", cursor: busy ? "default" : "pointer" }}
        >
          {busy ? t("qr.querying") : t("qr.query")}
        </button>
      </div>

      <QrSearchBar value={filters} onChange={setFilters} />

      {banner && <div style={bannerStyle}>{banner}</div>}

      {/* タブ（Destination） */}
      <div style={tabBar}>
        {tabs.length === 0 && <span style={{ color: "#8a98a6", fontSize: 13, padding: "6px 10px" }}>{t("qr.noTabs")}</span>}
        {tabs.map((ae) => {
          const r = results.get(ae.aeTitle);
          const count = r?.studies?.length;
          return (
            <button
              key={ae.aeTitle}
              onClick={() => setActive(ae.aeTitle)}
              style={{ ...tab, ...(active === ae.aeTitle ? tabActive : {}) }}
              title={`${ae.aeTitle} @ ${ae.host}:${ae.port}`}
            >
              <span style={{ width: 7, height: 7, borderRadius: 4, background: "#1e7e34", display: "inline-block" }} />
              {ae.aeTitle}
              {count != null && <span style={{ color: "#8a98a6" }}> ({count})</span>}
            </button>
          );
        })}
      </div>

      <div style={tableArea}>
        {active && (
          <QrTable
            key={active}
            dest={tabs.find((a) => a.aeTitle === active)!}
            studies={activeResult?.studies ?? null}
            loading={activeResult?.loading ?? false}
            error={activeResult?.error ?? null}
            hideStored={hideStored}
            largeThreshold={largeThreshold}
            onOpenInViewer={openInViewer}
          />
        )}
      </div>
    </div>
  );
}

const shell: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  fontFamily: "system-ui, sans-serif",
  color: "#1a1a1a",
  background: "#fff",
};
const headerBar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "8px 14px",
  borderBottom: "1px solid #e6eaee",
  background: "#f7f9fb",
};
const modeChip: React.CSSProperties = { fontSize: 11, padding: "2px 8px", borderRadius: 10, background: "#e6effa", color: "#0b5cad" };
const toggleLabel: React.CSSProperties = { display: "flex", alignItems: "center", gap: 5, fontSize: 13, cursor: "pointer" };
const queryBtn: React.CSSProperties = { padding: "6px 18px", border: "none", borderRadius: 6, color: "#fff", fontSize: 13, fontWeight: 600 };
const bannerStyle: React.CSSProperties = { padding: "6px 14px", background: "#eef6ec", borderBottom: "1px solid #d6e6d0", fontSize: 13, color: "#2e5d27" };
const tabBar: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, padding: "6px 10px", borderBottom: "1px solid #e6eaee", overflowX: "auto", background: "#fff" };
const tab: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, padding: "5px 12px", border: "1px solid #d7dde3", borderRadius: "7px 7px 0 0", background: "#f1f3f5", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" };
const tabActive: React.CSSProperties = { background: "#fff", borderBottomColor: "#fff", fontWeight: 600, color: "#0b5cad" };
const tableArea: React.CSSProperties = { flex: 1, minHeight: 0, overflow: "hidden" };
