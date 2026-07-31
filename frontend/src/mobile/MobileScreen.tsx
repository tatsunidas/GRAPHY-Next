/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * モバイルシェル（`#mobile`）の骨格。設計: `fw/mobile-ui-design.md`（M1）。
 *
 * <p>デスクトップ UI をレスポンシブ化するのではなく、**別シェルを足す**方針。`frontend/src` には
 * `.css` が 1 つも無く、スタイルは inline style で `@media` は 0 件なので、共有スタイルの上書きで
 * モバイル化する余地が無いため（§1）。既存 UI は一切触らないのでデスクトップは壊れない。
 *
 * <p>M1 の範囲は「ヘッダ ＋ 戻る導線 ＋ 単画面ナビゲーションスタック ＋ デスクトップ UI への
 * 逃げ道」まで。各画面の中身は M2 以降:
 * <ul>
 *   <li>M2 … 検索 → スタディ → シリーズ（`useStudies` / `useSeries` / `useInstances` を抽出して使う）</li>
 *   <li>M3 … 2D ビューア（1×1 固定・ドロワー・モバイルツールバー）</li>
 *   <li>M5 … 3D / MPR、M6 … Fusion、M8 … レポート</li>
 * </ul>
 */
import { useCallback } from "react";
import type { AppStatus } from "../api";
import { useI18n } from "../i18n/i18n";
import { mobileHash, parentView, type MobileView } from "./mobileRoute";
import { useDeviceClass } from "./useDeviceClass";

export function MobileScreen({ status, view }: { status: AppStatus | null; view: MobileView }) {
  const { t } = useI18n();
  const { deviceClass, setOverride } = useDeviceClass();

  // 前進は hash 代入（履歴に積まれる）。M2 以降の各画面から呼ぶ。
  const navigate = useCallback((next: MobileView) => {
    window.location.hash = mobileHash(next);
  }, []);

  // 戻るはブラウザ履歴を優先する（利用者のスワイプバックと挙動を揃えるため）。
  // 直接 URL で深い画面に入った場合は履歴が無いので、親画面へ置き換え遷移する。
  const goBack = useCallback(() => {
    const parent = parentView(view);
    if (!parent) return;
    if (window.history.length > 1) window.history.back();
    else window.location.replace(mobileHash(parent));
  }, [view]);

  /** デスクトップ UI へ抜ける。選択は localStorage に残るので次回もデスクトップで開く。 */
  const switchToDesktop = useCallback(() => {
    setOverride("desktop");
    window.location.hash = "";
  }, [setOverride]);

  return (
    <div style={shell} data-testid="mobile-shell" data-device-class={deviceClass}>
      <header style={header}>
        {parentView(view) ? (
          <button style={backBtn} onClick={goBack} aria-label={t("mobile.back")} data-testid="mobile-back">
            ‹
          </button>
        ) : (
          <span style={{ width: 28 }} />
        )}
        <h1 style={title}>{t(VIEW_TITLE_KEY[view])}</h1>
        <button style={escapeBtn} onClick={switchToDesktop} data-testid="mobile-to-desktop">
          {t("mobile.toDesktop")}
        </button>
      </header>

      <main style={content}>
        <PlaceholderPanel view={view} onNavigate={navigate} status={status} />
      </main>
    </div>
  );
}

const VIEW_TITLE_KEY: Record<MobileView, string> = {
  studies: "mobile.title.studies",
  series: "mobile.title.series",
  viewer: "mobile.title.viewer",
  report: "mobile.title.report",
};

/**
 * M2 以降で中身が入るまでの仮パネル。
 * 「準備中」であることを隠さず、デスクトップ UI への導線を必ず出す（利用者を行き止まりにしない）。
 */
function PlaceholderPanel({
  view,
  onNavigate,
  status,
}: {
  view: MobileView;
  onNavigate: (v: MobileView) => void;
  status: AppStatus | null;
}) {
  const { t } = useI18n();
  const next: MobileView | null =
    view === "studies" ? "series" : view === "series" ? "viewer" : view === "viewer" ? "report" : null;

  return (
    <section style={panel}>
      <p style={{ margin: 0 }}>{t("mobile.underConstruction")}</p>
      {/* モバイルシェルは web モード専用（§2 の非目標）。standalone で開かれたら明示する。 */}
      {status?.mode === "standalone" && <p style={noteText}>{t("mobile.webOnly")}</p>}
      {next && (
        <button style={navBtn} onClick={() => onNavigate(next)} data-testid="mobile-nav-next">
          {t(VIEW_TITLE_KEY[next])} →
        </button>
      )}
    </section>
  );
}

// ── スタイル（既存画面と同じく inline style。モバイル専用なので固定幅は使わない） ──

const shell: React.CSSProperties = {
  // ⚠️ `height: 100vh` は iOS Safari のアドレスバー伸縮で実高さとずれる（下端が隠れる）。
  // `100dvh` は Safari 15.4 未満で効かないので、どちらにも依存しない fixed + inset にする。
  position: "fixed",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  background: "#101318",
  color: "#e8ecf1",
  fontFamily: "system-ui, sans-serif",
  // ドラッグ操作がページスクロールと競合しないようにする（M4 で各ビューポートにも付与する）。
  overscrollBehavior: "none",
};

const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 10px",
  // ノッチ/ホームバーの安全領域を避ける。
  paddingTop: "calc(8px + env(safe-area-inset-top, 0px))",
  borderBottom: "1px solid #262c35",
  background: "#171b22",
};

const title: React.CSSProperties = {
  flex: 1,
  margin: 0,
  fontSize: 16,
  fontWeight: 600,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

// タップターゲットは 44px 以上（iOS HIG / Material の最小推奨）。
const backBtn: React.CSSProperties = {
  minWidth: 44,
  minHeight: 44,
  border: "none",
  background: "transparent",
  color: "#e8ecf1",
  fontSize: 26,
  lineHeight: 1,
  cursor: "pointer",
};

const escapeBtn: React.CSSProperties = {
  minHeight: 44,
  padding: "0 12px",
  border: "1px solid #39414d",
  borderRadius: 8,
  background: "transparent",
  color: "#9fb2c9",
  fontSize: 13,
  cursor: "pointer",
};

const content: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  WebkitOverflowScrolling: "touch",
  padding: 16,
  paddingBottom: "calc(16px + env(safe-area-inset-bottom, 0px))",
};

const panel: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
  padding: 16,
  border: "1px solid #262c35",
  borderRadius: 10,
  background: "#171b22",
  fontSize: 14,
  lineHeight: 1.7,
};

const noteText: React.CSSProperties = { margin: 0, color: "#c9a227" };

const navBtn: React.CSSProperties = {
  alignSelf: "flex-start",
  minHeight: 44,
  padding: "0 16px",
  border: "1px solid #2f6db5",
  borderRadius: 8,
  background: "#0b5cad",
  color: "#fff",
  fontSize: 14,
  cursor: "pointer",
};
