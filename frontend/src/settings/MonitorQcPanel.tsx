/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Settings＞モニター診断（Monitor QC）パネル。
// A: 接続モニターの表示環境を一覧。B: 選んだモニターに目視テストパターンを表示。
// 外部センサーなしの簡易 QC。絶対輝度/GSDF の定量測定は行わない旨を明示する。
import { useEffect, useMemo, useState } from "react";
import { desktop, isDesktop, type DisplayInfo } from "../desktopBridge";
import { useI18n } from "../i18n/i18n";
import { describeDisplayLayout, layoutMap, type DisplayLayoutRow, type Orientation } from "../monitorqc/layout";

export function MonitorQcPanel() {
  const { t } = useI18n();
  const [displays, setDisplays] = useState<DisplayInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => {
    const d = desktop();
    if (!d?.listDisplays) {
      setDisplays([]);
      return;
    }
    d.listDisplays()
      .then(setDisplays)
      .catch((e: unknown) => setError(String(e)));
  };

  useEffect(reload, []);

  const caps = browserCaps();
  // 並び・向き・画素数（OS が返す値から求める。診断用モニターの判定はしない）。
  const layoutRows = useMemo(() => describeDisplayLayout(displays ?? []), [displays]);
  const layoutBoxes = useMemo(() => layoutMap(displays ?? [], 360, 150), [displays]);
  // 配列の位置で引く（モニターの id は JavaScript の安全な整数を超えることがあり、鍵にすると取り違える）
  const rowAt = (index: number): DisplayLayoutRow | undefined => layoutRows[index];
  const orientLabel = (o: Orientation | null) => (o === null ? t("mqc.layout.unknown") : t(`mqc.layout.orient.${o}`));
  const physicalLabel = (r?: DisplayLayoutRow) =>
    !r || r.physicalW === null || r.physicalH === null ? t("mqc.layout.unknown") : `${r.physicalExact ? "" : "≈"}${r.physicalW}×${r.physicalH}`;
  const mpLabel = (r?: DisplayLayoutRow) => (!r || r.megapixels === null ? t("mqc.layout.unknown") : r.megapixels.toFixed(1));

  return (
    <div>
      <p style={note}>{t("mqc.intro")}</p>
      <p style={warn}>⚠ {t("mqc.limit")}</p>

      {/* A: 接続モニターの環境情報 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
        <h3 style={h3}>{t("mqc.sec.displays")}</h3>
        {isDesktop() && (
          <button style={ghostBtn} onClick={reload}>
            {t("mqc.refresh")}
          </button>
        )}
      </div>

      {error && <div style={{ color: "#b00020" }}>{error}</div>}

      {!isDesktop() ? (
        <p style={muted}>{t("mqc.desktopOnly")}</p>
      ) : displays === null ? (
        <p style={muted}>…</p>
      ) : displays.length === 0 ? (
        <p style={muted}>{t("mqc.noDisplays")}</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          {/* 配置の略図（左→右の番号。OS の座標を縮尺したもの） */}
          <div data-testid="mqc-layout" style={{ margin: "4px 0 10px" }}>
            <div style={{ position: "relative", width: 360, height: 150 }} data-testid="mqc-layout-map">
              {layoutBoxes.map((b) => {
                const r = rowAt(b.index);
                return (
                  <div
                    key={b.index}
                    data-testid="mqc-layout-box"
                    data-id={b.id}
                    data-index={b.index}
                    data-order={b.order}
                    data-orientation={r?.orientation ?? ""}
                    title={`${orientLabel(r?.orientation ?? null)} ${r?.width}×${r?.height}`}
                    style={{ position: "absolute", left: b.left, top: b.top, width: b.width, height: b.height, boxSizing: "border-box", border: "1.5px solid #0b5cad", background: "#eaf2fc", borderRadius: 3, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#123", overflow: "hidden" }}
                  >
                    <b style={{ fontSize: 14 }}>{b.order}</b>
                    <span>{r?.orientation === "portrait" ? "▮" : r?.orientation === "landscape" ? "▬" : "■"} {r?.width}×{r?.height}</span>
                  </div>
                );
              })}
            </div>
            <p style={{ ...muted, margin: "6px 0 0" }}>{t("mqc.layout.note")}</p>
          </div>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>#</th>
                <th style={th}>{t("mqc.col.name")}</th>
                <th style={th}>{t("mqc.layout.col.orderOrientation")}</th>
                <th style={th}>{t("mqc.col.resolution")}</th>
                <th style={th}>{t("mqc.layout.col.physicalMp")}</th>
                <th style={th}>{t("mqc.col.scale")}</th>
                <th style={th}>{t("mqc.col.depth")}</th>
                <th style={th}>{t("mqc.col.colorSpace")}</th>
                <th style={th}>Hz</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {displays.map((d, i) => (
                <tr
                  key={d.id}
                  data-testid="mqc-display-row"
                  data-id={d.id}
                  data-order={rowAt(i)?.order ?? ""}
                  data-orientation={rowAt(i)?.orientation ?? ""}
                  data-physical={physicalLabel(rowAt(i))}
                  data-mp={mpLabel(rowAt(i))}
                >
                  <td style={td}>{i + 1}</td>
                  <td style={td}>
                    {d.label || `Display ${i + 1}`}
                    {d.primary && <Badge text={t("mqc.primary")} />}
                    {d.internal && <Badge text={t("mqc.internal")} tone="muted" />}
                  </td>
                  <td style={td}>
                    <b>{rowAt(i)?.order ?? "—"}</b> {orientLabel(rowAt(i)?.orientation ?? null)}
                  </td>
                  <td style={td}>
                    {d.bounds ? `${d.bounds.width}×${d.bounds.height}` : t("mqc.layout.unknown")}
                    {d.bounds && d.scaleFactor !== 1 && (
                      <span style={muted}>
                        {" "}
                        ({Math.round(d.bounds.width * d.scaleFactor)}×{Math.round(d.bounds.height * d.scaleFactor)} px)
                      </span>
                    )}
                  </td>
                  <td style={td}>
                    {physicalLabel(rowAt(i))} <span style={muted}>({mpLabel(rowAt(i))} MP)</span>
                  </td>
                  <td style={td}>×{d.scaleFactor}</td>
                  <td style={td}>
                    {d.colorDepth}bit
                    {d.depthPerComponent ? <span style={muted}> ({d.depthPerComponent}/ch)</span> : null}
                  </td>
                  <td style={td} title={d.colorSpace}>
                    {shortColorSpace(d.colorSpace)}
                  </td>
                  <td style={td}>{d.displayFrequency || "—"}</td>
                  <td style={td}>
                    <button style={primaryBtn} onClick={() => desktop()?.openMonitorQc?.(d.id)}>
                      {t("mqc.showPattern")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 現在のウィンドウのモニター能力（ブラウザ側から取得） */}
      <h3 style={h3}>{t("mqc.sec.current")}</h3>
      <table style={table}>
        <tbody>
          <Row k={t("mqc.cur.dpr")} v={String(caps.dpr)} />
          <Row k={t("mqc.cur.colorDepth")} v={`${caps.colorDepth}bit`} />
          <Row k={t("mqc.cur.gamut")} v={caps.gamut} />
          <Row k={t("mqc.cur.dynamicRange")} v={caps.hdr ? "HDR (high)" : "SDR (standard)"} />
        </tbody>
      </table>

      {/* 使い方 */}
      <h3 style={h3}>{t("mqc.sec.howto")}</h3>
      <ul style={howto}>
        <li>{t("mqc.howto.1")}</li>
        <li>{t("mqc.howto.2")}</li>
        <li>{t("mqc.howto.3")}</li>
      </ul>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <tr>
      <td style={{ ...td, color: "#556", width: 220 }}>{k}</td>
      <td style={td}>{v}</td>
    </tr>
  );
}

function Badge({ text, tone }: { text: string; tone?: "muted" }) {
  return (
    <span
      style={{
        marginLeft: 6,
        fontSize: 10,
        padding: "1px 6px",
        borderRadius: 8,
        background: tone === "muted" ? "#eef1f4" : "#e6f0ff",
        color: tone === "muted" ? "#667" : "#0b5cad",
      }}
    >
      {text}
    </span>
  );
}

interface Caps {
  dpr: number;
  colorDepth: number;
  gamut: string;
  hdr: boolean;
}
function browserCaps(): Caps {
  const mm = (q: string) => typeof window.matchMedia === "function" && window.matchMedia(q).matches;
  let gamut = "sRGB";
  if (mm("(color-gamut: rec2020)")) gamut = "Rec.2020";
  else if (mm("(color-gamut: p3)")) gamut = "Display P3";
  return {
    dpr: window.devicePixelRatio || 1,
    colorDepth: window.screen?.colorDepth ?? 24,
    gamut,
    hdr: mm("(dynamic-range: high)"),
  };
}

function shortColorSpace(cs: string): string {
  if (!cs) return "—";
  // Electron の colorSpace 文字列は長いことがあるので要約。
  const m = /\{primaries:([^,}]+)/.exec(cs);
  return m ? m[1] : cs.length > 24 ? cs.slice(0, 24) + "…" : cs;
}

const note: React.CSSProperties = { color: "#445", fontSize: 13, margin: "0 0 6px" };
const warn: React.CSSProperties = { color: "#8a5a00", background: "#fff6e5", border: "1px solid #f0dca8", borderRadius: 6, padding: "6px 10px", fontSize: 12.5, margin: "0 0 12px" };
const muted: React.CSSProperties = { color: "#889", fontSize: 12 };
const h3: React.CSSProperties = { fontSize: 14, margin: "18px 0 8px", color: "#223" };
const table: React.CSSProperties = { borderCollapse: "collapse", width: "100%", fontSize: 12.5 };
const th: React.CSSProperties = { textAlign: "left", borderBottom: "2px solid #dde3ea", padding: "4px 8px", color: "#556", whiteSpace: "nowrap" };
const td: React.CSSProperties = { borderBottom: "1px solid #eef1f4", padding: "5px 8px", verticalAlign: "middle" };
const primaryBtn: React.CSSProperties = { background: "#0b5cad", color: "#fff", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap" };
const ghostBtn: React.CSSProperties = { background: "transparent", color: "#0b5cad", border: "1px solid #b8d0ea", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 12 };
const howto: React.CSSProperties = { margin: "0", paddingLeft: 18, color: "#445", fontSize: 12.5, lineHeight: 1.7 };
