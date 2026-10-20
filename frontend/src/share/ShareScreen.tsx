/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 検査共有リンクの受け手の画面（`#share`）。許可された検査 1 件を、読み取り専用で見せる。
//
// App を通さない（main.tsx で切り替える）。受け手が呼べる API は backend の許可リストの数経路だけで、
// App の起動時処理（/api/status のポーリング・設定・更新確認）は 404 になるため。
// 検査の一覧・検索・設定・書き込みへの導線は作らない。3D・MPR・レポート・Fusion も出さない（readOnly）。

import { useCallback, useEffect, useState } from "react";
import type { Series, Study } from "../api";
import { httpGet } from "../http";
import { useI18n } from "../i18n/i18n";
import { MobileSeriesList } from "../mobile/MobileStudyBrowser";
import { MobileViewer } from "../mobile/MobileViewer";
import { shareStateFromError, shareStateFromStudies, type ShareState } from "./shareState";

export function ShareScreen() {
  const { t } = useI18n();
  const [state, setState] = useState<ShareState | null>(null);
  const [series, setSeries] = useState<Series | null>(null);

  const load = useCallback(() => {
    setState(null);
    httpGet<Study[]>("/api/share/study")
      .then((studies) => setState(shareStateFromStudies(studies)))
      .catch((e: unknown) => setState(shareStateFromError(e)));
  }, []);

  useEffect(load, [load]);

  const study = state?.kind === "ready" ? state.study : null;

  return (
    <div style={shell} data-testid="share-shell">
      <header style={header}>
        {series ? (
          <button style={backBtn} onClick={() => setSeries(null)} data-testid="share-back">
            ‹ {t("share.backToSeries")}
          </button>
        ) : (
          <span style={{ width: 28 }} />
        )}
        <h1 style={title}>{series ? series.seriesDescription || `#${series.seriesNumber ?? "—"}` : t("share.title")}</h1>
        <span style={{ width: 28 }} />
      </header>
      <p style={notice} data-testid="share-notice">
        {t("share.notice")}
      </p>

      <main style={series ? contentFlush : content}>
        {state === null && <p style={hint}>{t("common.loading")}</p>}
        {state?.kind === "invalid" && (
          <section style={panel} data-testid="share-invalid">
            <p style={{ margin: 0 }}>{t("share.invalid")}</p>
          </section>
        )}
        {state?.kind === "error" && (
          <section style={panel} data-testid="share-error">
            <p style={{ margin: 0 }}>{t("common.fetchError", { error: state.message })}</p>
            <button style={retryBtn} onClick={load}>
              {t("share.retry")}
            </button>
          </section>
        )}
        {study && !series && (
          <>
            <section style={card} data-testid="share-study">
              <span style={cardTitle}>{study.studyDescription || t("share.title")}</span>
              <span style={cardMeta}>
                {[study.patientName, study.patientId].filter(Boolean).join(" · ")}
              </span>
              <span style={cardMeta}>{[study.studyDate, study.modality].filter(Boolean).join(" · ")}</span>
            </section>
            <MobileSeriesList study={study} onSelect={setSeries} />
          </>
        )}
        {study && series && (
          <MobileViewer
            study={study}
            series={series}
            // 受け手は standalone ではない。画像は /api/studies/{s}/series/{x}/instances/{sop}/file（許可リストの形）。
            mode="web"
            onChangeSeries={setSeries}
            onAttachToReport={() => undefined}
            readOnly
          />
        )}
      </main>
    </div>
  );
}

const shell: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  background: "#101318",
  color: "#e8ecf1",
  fontFamily: "system-ui, sans-serif",
  overscrollBehavior: "none",
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 10px",
  borderBottom: "1px solid #262c35",
  background: "#171b22",
};
const title: React.CSSProperties = { flex: 1, margin: 0, fontSize: 16, fontWeight: 600, textAlign: "center" };
const backBtn: React.CSSProperties = {
  minHeight: 44,
  padding: "0 10px",
  border: "none",
  background: "transparent",
  color: "#8ab4f8",
  fontSize: 15,
  cursor: "pointer",
};
const notice: React.CSSProperties = {
  margin: 0,
  padding: "6px 12px",
  fontSize: 12,
  color: "#c9b27a",
  background: "#1d1a12",
  borderBottom: "1px solid #3a3320",
};
const content: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};
const contentFlush: React.CSSProperties = { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" };
const hint: React.CSSProperties = { margin: 0, color: "#8b9bb0", fontSize: 14 };
const panel: React.CSSProperties = {
  padding: 16,
  border: "1px solid #262c35",
  borderRadius: 10,
  background: "#171b22",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};
const card: React.CSSProperties = { ...panel, gap: 4 };
const cardTitle: React.CSSProperties = { fontSize: 16, fontWeight: 600 };
const cardMeta: React.CSSProperties = { fontSize: 13, color: "#8b9bb0" };
const retryBtn: React.CSSProperties = {
  alignSelf: "flex-start",
  minHeight: 44,
  padding: "0 16px",
  border: "1px solid #39414d",
  borderRadius: 8,
  background: "#0e1218",
  color: "#e8ecf1",
  cursor: "pointer",
};
