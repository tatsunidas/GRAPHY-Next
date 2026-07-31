/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * モバイル 2D ビューアのツールバー（`fw/mobile-ui-design.md` M3）。
 *
 * <p>デスクトップの `viewer2d/Viewer2DToolbar.tsx` は 20 個以上のアイコンを 1 行に並べるので
 * 狭幅では成立しない。**参照に要るものだけ**を大きなタップターゲットで出す:
 * ツール切替（W/L・Pan・Zoom）／W/L プリセット／複合リセット。
 *
 * <p>実際の操作は既存の `viewerCommands` レジストリ経由で `Viewer2D` に送る（描画コアは再利用）。
 */
import { useState } from "react";
import { runViewerCommand } from "../viewer/viewerCommands";
import { TOOL_IDS } from "../viewer/toolIds";
import { presetLabel } from "../viewer2d/wlPresets";
import { useWlPresets } from "../viewer2d/wlPresetStore";
import { useI18n } from "../i18n/i18n";

/** モバイルシェルが持つ唯一のタイル（1×1 固定なので ID も 1 つ）。 */
export const MOBILE_TILE_ID = "mobile-tile";

/** モバイルで出す操作ツール。計測は M4（タッチバインド）以降。 */
const TOOLS = [
  { id: TOOL_IDS.windowLevel, labelKey: "viewer.status.wl" },
  { id: TOOL_IDS.pan, labelKey: "viewer.pan" },
  { id: TOOL_IDS.zoom, labelKey: "viewer.zoomIn" },
] as const;

export function MobileToolbar({
  activeTool,
  onChangeTool,
  onOpenSeriesDrawer,
  onLaunchVolumeViewer,
  onAttachToReport,
}: {
  activeTool: string;
  onChangeTool: (toolId: string) => void;
  onOpenSeriesDrawer: () => void;
  /** 3D / MPR を同一タブで開く（M5）。 */
  onLaunchVolumeViewer: (kind: "mpr" | "viewer3d") => void;
  /** いま見ている画像をキー画像としてレポートへ添付し、エディタへ移動する（M8・§5.4）。 */
  onAttachToReport: () => void;
}) {
  const { t } = useI18n();
  const presets = useWlPresets();
  const [showPresets, setShowPresets] = useState(false);

  const send = (fn: Parameters<typeof runViewerCommand>[1]) => runViewerCommand([MOBILE_TILE_ID], fn);

  return (
    <div style={bar}>
      <div style={rowScroll}>
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            style={tool.id === activeTool ? tabOn : tab}
            onClick={() => {
              onChangeTool(tool.id);
              send((c) => c.setActiveTool(tool.id));
            }}
            data-testid={`mobile-tool-${tool.id}`}
          >
            {t(tool.labelKey)}
          </button>
        ))}

        <span style={sep} />

        {/* ズームは離散（×1.2）のボタンもある＝ピンチが効かない端末でも操作できる（§3.4）。 */}
        <button style={tab} onClick={() => send((c) => c.fit())}>
          {t("viewer.fit")}
        </button>
        {/*
         * ⚠️ reset() は camera（zoom/pan/rotation/flip）だけで W/L は戻らない。
         * VOI リセットは別コマンド resetWindow()。モバイルの「リセット」は両方呼ぶ複合アクションにする
         * （既存コマンドは変更しない。fw/mobile-ui-design.md §3.4）。
         */}
        <button
          style={tab}
          onClick={() =>
            send((c) => {
              c.reset();
              c.resetWindow();
            })
          }
          data-testid="mobile-reset-all"
        >
          {t("mobile.resetAll")}
        </button>
        <button style={tab} onClick={() => send((c) => c.rotate90())}>
          {t("viewer.rotate")}
        </button>

        <span style={sep} />

        <button
          style={showPresets ? tabOn : tab}
          onClick={() => setShowPresets((v) => !v)}
          data-testid="mobile-wl-presets"
        >
          {t("viewer2d.wl.preset")}
        </button>
        <button style={tab} onClick={onOpenSeriesDrawer} data-testid="mobile-open-series-drawer">
          {t("mobile.title.series")}
        </button>

        <span style={sep} />

        {/* ボリューム系は同一タブで開く。メモリガード（V2）が必要量を見て確認を出す。 */}
        <button style={tab} onClick={() => onLaunchVolumeViewer("mpr")} data-testid="mobile-open-mpr">
          {t("main.toolbar.mpr")}
        </button>
        <button style={tab} onClick={() => onLaunchVolumeViewer("viewer3d")} data-testid="mobile-open-3d">
          {t("main.toolbar.viewer3d")}
        </button>

        <span style={sep} />

        {/*
         * §5.4: 現状デスクトップには「表示中の画像から直接キー画像を追加する」導線が無い
         * （一覧のインスタンスから選ぶ方式のみ）。単画面ビューアでは「いま見ている画像を添付」が
         * 最も自然なので、ここで新規に用意する。
         */}
        <button style={tab} onClick={onAttachToReport} data-testid="mobile-attach-report">
          {t("mobile.report.attach")}
        </button>
      </div>

      {showPresets && (
        <div style={rowScroll}>
          {presets.map((p) => (
            <button
              key={p.key}
              style={tab}
              onClick={() => send((c) => c.setWindowLevel(p.center, p.width))}
              data-testid={`mobile-wl-${p.key}`}
            >
              {presetLabel(p, t)}
            </button>
          ))}
          <button style={tab} onClick={() => send((c) => c.resetWindow())}>
            {t("viewer2d.wl.default")}
          </button>
        </div>
      )}
    </div>
  );
}

// ── スタイル ──

const bar: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "6px 8px",
  borderTop: "1px solid #262c35",
  background: "#171b22",
};

/** 入りきらないボタンは横スクロールで出す（折り返して縦に伸びると画像が潰れるため）。 */
const rowScroll: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  overflowX: "auto",
  WebkitOverflowScrolling: "touch",
  // 横スクロールするので、ここだけは縦のドラッグを親へ流す。
  touchAction: "pan-x",
};

const tab: React.CSSProperties = {
  flex: "0 0 auto",
  minHeight: 44,
  padding: "0 14px",
  border: "1px solid #39414d",
  borderRadius: 8,
  background: "transparent",
  color: "#c3cddb",
  fontSize: 13,
  whiteSpace: "nowrap",
  cursor: "pointer",
};

const tabOn: React.CSSProperties = { ...tab, background: "#0b5cad", borderColor: "#2f6db5", color: "#fff" };

const sep: React.CSSProperties = { flex: "0 0 auto", width: 1, height: 24, background: "#2b323c" };
