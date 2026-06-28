import { useEffect, useRef, useState } from "react";
import { RenderingEngine, Enums, type Types } from "@cornerstonejs/core";
import { ensureCornerstoneInitialized } from "./cornerstoneSetup";
import { useI18n } from "../i18n/i18n";

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
 * 2D 画像ビューア（骨組み）。
 *
 * <p>レイヤ構成: 深層に Cornerstone3D の StackViewport（canvas／WebGL）を置き、
 * その上に DOM オーバーレイ（メタデータ・患者の向き等）を `pointer-events:none` で重ねる予定。
 * 入力は Cornerstone のビューポート要素が処理するため、最前面の不透明イベント層は置かない。
 *
 * <p>現スコープは単一スライス表示のみ（ツール・スタックは次スコープ）。
 */
export function Viewer2D({ imageId }: { imageId: string }) {
  const { t } = useI18n();
  const elementRef = useRef<HTMLDivElement>(null);
  const viewportIdRef = useRef(`graphy-vp-${viewportSeq++}`);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let disposed = false;
    const element = elementRef.current;
    if (!element) return;
    const viewportId = viewportIdRef.current;

    (async () => {
      try {
        setLoading(true);
        setError(null);
        await ensureCornerstoneInitialized();
        if (disposed) return;

        const engine = getEngine();
        engine.enableElement({
          viewportId,
          type: Enums.ViewportType.STACK,
          element,
        });
        const viewport = engine.getViewport(viewportId) as Types.IStackViewport;
        await viewport.setStack([imageId], 0);
        viewport.render();
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
      try {
        getEngine().disableElement(viewportId);
      } catch {
        /* 既に破棄済みなら無視 */
      }
    };
  }, [imageId]);

  return (
    <div style={wrap}>
      {/* 深層: ピクセル canvas（Cornerstone3D が内部に canvas を生成する） */}
      <div ref={elementRef} style={pixelLayer} onContextMenu={(e) => e.preventDefault()} />
      {/* z3 オーバーレイ（メタデータ等）は次スコープ。pointer-events:none で重ねる */}
      {loading && !error && <div style={overlay}>{t("common.loading")}</div>}
      {error && <div style={{ ...overlay, color: "#ff8a80" }}>{t("common.fetchError", { error })}</div>}
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
const pixelLayer: React.CSSProperties = {
  position: "absolute",
  inset: 0,
};
const overlay: React.CSSProperties = {
  position: "absolute",
  top: 8,
  left: 10,
  color: "#cfd8dc",
  fontSize: 12,
  pointerEvents: "none",
};
