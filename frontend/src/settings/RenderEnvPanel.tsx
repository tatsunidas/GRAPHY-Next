/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Settings＞描画環境パネル。何の GPU で 3D / MPR を描いているか、ソフトウェア描画に落ちていないかを見せる。
// 判定は viewer/renderEnv.ts の純関数。ここは表示だけ（設計: fw/render-environment-design.md）。
// 各行は data-testid="renderenv-row-<id>"、値は data-value、種別の行だけ data-kind を持つ。
import { useEffect, useState } from "react";
import { isDesktop } from "../desktopBridge";
import { useI18n, type TFn } from "../i18n/i18n";
import { STILL_MS_STORAGE_KEY, type RenderEnvSummary } from "../viewer/renderEnv";
import { loadRenderEnvSummary } from "../viewer/renderEnvReport";
import type { SelfTestRun } from "../viewer/render3dSelfTest";
import { fetchStatus } from "../api";
import { SelfTestSection } from "./SelfTestSection";

const GB = 1024 * 1024 * 1024;

export function RenderEnvPanel() {
  const { t } = useI18n();
  const [s, setS] = useState<RenderEnvSummary | null>(null);
  const [copied, setCopied] = useState<"ok" | "ng" | null>(null);
  const [selfTest, setSelfTest] = useState<SelfTestRun | null>(null);

  useEffect(() => {
    let alive = true;
    void loadRenderEnvSummary().then((v) => {
      if (alive) setS(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  const copy = async () => {
    if (!s) return;
    let json: object = s;
    if (selfTest) {
      let version = "unknown";
      try {
        version = (await fetchStatus()).version;
      } catch {
        /* 版が取れなくてもコピーはできる */
      }
      json = {
        ...s,
        selfTest: {
          version,
          userAgent: navigator.userAgent,
          gpu: selfTest.gpu,
          rows: selfTest.rows.map((r) => ({ id: r.id, status: r.status, reason: r.reason, values: r.values ?? {} })),
        },
      };
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(json, null, 2));
      setCopied("ok");
    } catch {
      setCopied("ng");
    }
  };

  const still = readStillMs();

  if (!s) return <p style={muted}>…</p>;

  const desktopOnly = t("renderenv.notDone");
  const unknown = t("renderenv.unknown");
  const kindLabel = t(`renderenv.kind.${s.kind}`);

  return (
    <div data-testid="renderenv-panel">
      <p style={note}>{t("renderenv.intro")}</p>
      {s.kind === "software" && (
        <p style={warn} data-testid="renderenv-software-warning">
          ⚠ {t("renderenv.softwareWarn")}
        </p>
      )}
      <table style={table}>
        <tbody>
          <Row id="gpu" k={t("renderenv.row.gpu")} value={s.renderGpu ?? ""} text={s.renderGpu ?? unknown} />
          <Row
            id="gpu-default"
            k={t("renderenv.row.gpuDefault")}
            value={s.defaultGpu ?? ""}
            text={s.defaultGpu ?? unknown}
          />
          <Row id="kind" k={t("renderenv.row.kind")} value={s.kind} kind={s.kind} text={kindLabel} />
          <Row
            id="webgl2"
            k={t("renderenv.row.webgl2")}
            value={String(s.webgl2)}
            text={s.webgl2 ? t("renderenv.available") : t("renderenv.unavailable")}
          />
          <Row
            id="max3d"
            k={t("renderenv.row.max3d")}
            value={s.max3dTextureSize === null ? "" : String(s.max3dTextureSize)}
            text={s.max3dTextureSize === null ? unknown : String(s.max3dTextureSize)}
          />
          <Row
            id="memory"
            k={t("renderenv.row.memory")}
            value={s.totalBytes === null ? "" : String(s.totalBytes)}
            extra={{ "data-volume-max-mb": String(s.volumeMaxMb) }}
            text={t("renderenv.memoryText", {
              total: s.totalBytes === null ? unknown : `${(s.totalBytes / GB).toFixed(1)} GB`,
              volMax: String(s.volumeMaxMb),
            })}
          />
          <Row id="gpu-memory" k={t("renderenv.row.gpuMemory")} value="" text={t("renderenv.gpuMemoryUnknown")} />
          <Row
            id="still3d"
            k={t("renderenv.row.still3d")}
            value={still === null ? "" : String(still)}
            text={still === null ? t("renderenv.still3dNone") : t("renderenv.still3dText", { ms: still.toFixed(1) })}
          />
          <Row
            id="features"
            k={t("renderenv.row.features")}
            value={s.featureStatus?.webgl2 ?? ""}
            text={featuresText(s, desktopOnly, unknown)}
          />
          <Row
            id="devices"
            k={t("renderenv.row.devices")}
            value={s.gpuDevices ? String(s.gpuDevices.length) : ""}
            text={devicesText(s, t, desktopOnly, unknown)}
          />
        </tbody>
      </table>
      <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}>
        <button style={primaryBtn} onClick={copy} data-testid="renderenv-copy">
          {t("renderenv.copy")}
        </button>
        {copied && (
          <span style={muted} data-testid="renderenv-copy-result">
            {copied === "ok" ? t("renderenv.copied") : t("renderenv.copyFailed")}
          </span>
        )}
      </div>
      <h4 style={sectionHead}>{t("selftest.title")}</h4>
      <p style={note}>{t("selftest.intro")}</p>
      <SelfTestSection kind={s.kind} onResult={setSelfTest} />
    </div>
  );
}

/** 3D ビューア（別ウィンドウのことが多い）が最後に測った静止 1 フレームの時間。同じ場所の localStorage 経由。 */
function readStillMs(): number | null {
  try {
    const raw = localStorage.getItem(STILL_MS_STORAGE_KEY);
    if (!raw) return null;
    const v = (JSON.parse(raw) as { stillMs?: unknown }).stillMs;
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function featuresText(s: RenderEnvSummary, desktopOnly: string, unknown: string): string {
  if (!isDesktop()) return desktopOnly;
  if (!s.featureStatus || Object.keys(s.featureStatus).length === 0) return unknown;
  return Object.entries(s.featureStatus)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" / ");
}

function devicesText(s: RenderEnvSummary, t: TFn, desktopOnly: string, unknown: string): string {
  if (!isDesktop()) return desktopOnly;
  if (!s.gpuDevices || s.gpuDevices.length === 0) return unknown;
  return s.gpuDevices
    .map(
      (d) =>
        `vendor 0x${d.vendorId.toString(16)} / device 0x${d.deviceId.toString(16)}` +
        (d.active ? ` (${t("renderenv.active")})` : ""),
    )
    .join(" ; ");
}

function Row({
  id,
  k,
  text,
  value,
  kind,
  extra,
}: {
  id: string;
  k: string;
  text: string;
  value: string;
  kind?: string;
  extra?: Record<string, string>;
}) {
  return (
    <tr data-testid={`renderenv-row-${id}`} data-value={value} data-kind={kind} {...extra}>
      <td style={{ ...td, color: "#556", width: 240 }}>{k}</td>
      <td style={td}>{text}</td>
    </tr>
  );
}

const note: React.CSSProperties = { color: "#445", fontSize: 13, margin: "0 0 6px" };
const warn: React.CSSProperties = { color: "#8a5a00", background: "#fff6e5", border: "1px solid #f0dca8", borderRadius: 6, padding: "6px 10px", fontSize: 12.5, margin: "0 0 12px" };
const muted: React.CSSProperties = { color: "#889", fontSize: 12 };
const table: React.CSSProperties = { borderCollapse: "collapse", width: "100%", fontSize: 12.5 };
const td: React.CSSProperties = { borderBottom: "1px solid #eef1f4", padding: "5px 8px", verticalAlign: "top" };
const primaryBtn: React.CSSProperties = { background: "#0b5cad", color: "#fff", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap" };
const sectionHead: React.CSSProperties = { margin: "22px 0 4px", fontSize: 14 };
