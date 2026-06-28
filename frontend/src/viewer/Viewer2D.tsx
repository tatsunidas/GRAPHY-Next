import { useEffect, useRef, useState } from "react";
import { RenderingEngine, Enums, EVENTS, type Types } from "@cornerstonejs/core";
import {
  ToolGroupManager,
  PanTool,
  ZoomTool,
  Enums as csToolsEnums,
} from "@cornerstonejs/tools";
import { ensureCornerstoneInitialized } from "./cornerstoneSetup";
import { applyTransform, isPanned, readTransform, type ViewTransform, FIT_TRANSFORM } from "./transform";
import { useI18n } from "../i18n/i18n";

const { MouseBindings } = csToolsEnums;

// 単一の RenderingEngine を全ビューポートで共有する（WebGL コンテキストを 1 つに保つ＝省メモリ）。
const ENGINE_ID = "graphy-engine";
let sharedEngine: RenderingEngine | null = null;
function getEngine(): RenderingEngine {
  if (!sharedEngine) {
    sharedEngine = new RenderingEngine(ENGINE_ID);
  }
  return sharedEngine;
}

let viewportSeq = 0;

/**
 * 2D 画像ビューア（単一スライス＋表示変換）。
 *
 * <p>表示の約束:
 * <ul>
 *   <li>表示倍率はコンポーネントサイズに Fit した状態を <b>1.0（100%）</b>とする。</li>
 *   <li>既定原点はコンポーネント中央（画像が中央）。</li>
 *   <li>zoom / pan / 上下左右 flip / rotation は <b>すべて affine（ViewPresentation）で管理</b>。</li>
 *   <li>コンポーネントの拡縮に追従して画像サイズを再 Fit（相対 zoom は維持）。</li>
 *   <li>zoom が 1.0 以外、または pan オフセットがあると Pan 状態 = true。</li>
 * </ul>
 *
 * <p>レイヤ: 深層に Cornerstone3D の StackViewport（canvas／WebGL）。上に DOM オーバーレイを
 * `pointer-events:none` で重ねる。入力はビューポート要素が処理（最前面の不透明イベント層は置かない）。
 */
export function Viewer2D({ imageId }: { imageId: string }) {
  const { t } = useI18n();
  const elementRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<Types.IStackViewport | null>(null);
  const viewportIdRef = useRef(`graphy-vp-${viewportSeq++}`);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [transform, setTransform] = useState<ViewTransform>(FIT_TRANSFORM);

  useEffect(() => {
    let disposed = false;
    const element = elementRef.current;
    if (!element) return;
    const viewportId = viewportIdRef.current;
    const toolGroupId = `${viewportId}-tg`;
    let resizeObserver: ResizeObserver | null = null;

    const onCameraModified = () => {
      const vp = viewportRef.current;
      if (vp && !disposed) setTransform(readTransform(vp));
    };

    (async () => {
      try {
        setLoading(true);
        setError(null);
        await ensureCornerstoneInitialized();
        if (disposed) return;

        const engine = getEngine();
        engine.enableElement({ viewportId, type: Enums.ViewportType.STACK, element });
        const viewport = engine.getViewport(viewportId) as Types.IStackViewport;
        viewportRef.current = viewport;
        await viewport.setStack([imageId], 0);
        viewport.render();

        // affine 操作: 左ドラッグ=Pan、右ドラッグ/ホイール=Zoom（いずれも camera=affine 経由）。
        const tg = ToolGroupManager.getToolGroup(toolGroupId) ?? ToolGroupManager.createToolGroup(toolGroupId);
        if (tg) {
          tg.addTool(PanTool.toolName);
          tg.addTool(ZoomTool.toolName);
          tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
          tg.setToolActive(ZoomTool.toolName, {
            bindings: [{ mouseButton: MouseBindings.Secondary }, { mouseButton: MouseBindings.Wheel }],
          });
          tg.addViewport(viewportId, ENGINE_ID);
        }

        // 操作（ツール）による変化を読み戻してオーバーレイ更新。
        element.addEventListener(EVENTS.CAMERA_MODIFIED, onCameraModified);
        onCameraModified();

        // コンポーネント拡縮に追従。再 Fit したうえで相対 zoom/pan/rotation/flip を維持する。
        resizeObserver = new ResizeObserver(() => {
          const vp = viewportRef.current;
          if (!vp || disposed) return;
          const pres = vp.getViewPresentation();
          engine.resize(true, false); // 新サイズへ再 Fit（camera リセット）
          vp.setViewPresentation(pres); // 相対 zoom などを再適用
          vp.render();
        });
        resizeObserver.observe(element);

        if (!disposed) setLoading(false);
      } catch (e) {
        if (!disposed) {
          setError(String(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      element.removeEventListener(EVENTS.CAMERA_MODIFIED, onCameraModified);
      try {
        ToolGroupManager.destroyToolGroup(toolGroupId);
      } catch {
        /* 無ければ無視 */
      }
      try {
        getEngine().disableElement(viewportId);
      } catch {
        /* 既に破棄済みなら無視 */
      }
      viewportRef.current = null;
    };
  }, [imageId]);

  // --- 操作（すべて affine = ViewPresentation 経由） ---
  const vp = () => viewportRef.current;
  const fit = () => vp() && applyTransform(vp()!, FIT_TRANSFORM);
  const zoomBy = (f: number) => {
    const v = vp();
    if (v) applyTransform(v, { zoom: readTransform(v).zoom * f });
  };
  const rotate90 = () => {
    const v = vp();
    if (v) applyTransform(v, { rotation: (readTransform(v).rotation + 90) % 360 });
  };
  const flipH = () => {
    const v = vp();
    if (v) applyTransform(v, { flipHorizontal: !readTransform(v).flipHorizontal });
  };
  const flipV = () => {
    const v = vp();
    if (v) applyTransform(v, { flipVertical: !readTransform(v).flipVertical });
  };

  const panned = isPanned(transform);

  return (
    <div>
      <div style={wrap}>
        {/* 深層: ピクセル canvas（Cornerstone3D が内部に canvas を生成） */}
        <div ref={elementRef} style={pixelLayer} onContextMenu={(e) => e.preventDefault()} />
        {/* z3 オーバーレイ（pointer-events:none で入力を妨げない） */}
        <div style={overlayTL}>
          <span>{t("viewer.zoomLabel", { pct: Math.round(transform.zoom * 100) })}</span>
          {panned && <span style={panBadge}>{t("viewer.panned")}</span>}
        </div>
        {loading && !error && <div style={overlayCenter}>{t("common.loading")}</div>}
        {error && <div style={{ ...overlayCenter, color: "#ff8a80" }}>{t("common.fetchError", { error })}</div>}
      </div>

      {/* 操作バー（canvas の外＝ツール入力と競合しない） */}
      <div style={toolbar}>
        <button onClick={fit} style={btn} title={t("viewer.fit")}>{t("viewer.fit")}</button>
        <button onClick={() => zoomBy(1 / 1.2)} style={btn} title={t("viewer.zoomOut")}>−</button>
        <button onClick={() => zoomBy(1.2)} style={btn} title={t("viewer.zoomIn")}>＋</button>
        <button onClick={rotate90} style={btn} title={t("viewer.rotate")}>⟳</button>
        <button onClick={flipH} style={btn} title={t("viewer.flipH")}>⇄</button>
        <button onClick={flipV} style={btn} title={t("viewer.flipV")}>⇅</button>
      </div>
    </div>
  );
}

const wrap: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: 512,
  background: "#000",
  borderRadius: 6,
  overflow: "hidden",
};
const pixelLayer: React.CSSProperties = { position: "absolute", inset: 0 };
const overlayTL: React.CSSProperties = {
  position: "absolute",
  top: 8,
  left: 10,
  display: "flex",
  gap: 8,
  alignItems: "center",
  color: "#cfd8dc",
  fontSize: 12,
  pointerEvents: "none",
};
const panBadge: React.CSSProperties = {
  padding: "1px 6px",
  borderRadius: 4,
  background: "#1565c0",
  color: "#fff",
  fontSize: 11,
};
const overlayCenter: React.CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%,-50%)",
  color: "#cfd8dc",
  fontSize: 13,
  pointerEvents: "none",
};
const toolbar: React.CSSProperties = {
  display: "flex",
  gap: 6,
  marginTop: 6,
};
const btn: React.CSSProperties = {
  minWidth: 34,
  padding: "4px 8px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  cursor: "pointer",
  fontSize: 13,
};
