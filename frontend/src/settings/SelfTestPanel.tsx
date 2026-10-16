/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Settings＞描画環境の自己診断（fw/self-test-design.md）。押したときだけ走り、結果は保存せずコピーだけ。
import { useEffect, useRef, useState } from "react";
import { fetchStatus } from "../api";
import { useI18n } from "../i18n/i18n";
import { runRender3dSelfTest, type SelfTestRow, type SelfTestRun } from "../viewer/render3dSelfTest";

const ROW_ORDER = ["webgl2", "max3dTex", "render", "orientation", "spacing", "distance", "hardware"] as const;

const COLORS = { pass: "#1a7f37", fail: "#b00020", pending: "#6b7785" } as const;
const MARKS = { pass: "✔", fail: "✖", pending: "–" } as const;

export function SelfTestPanel() {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<SelfTestRun | null>(null);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  const start = async () => {
    const host = hostRef.current;
    if (!host || running) return;
    setRunning(true);
    setCopyMsg(null);
    setRun(null);
    // いったん描画を挟み、「実行中」を見せてから重い処理に入る。
    await new Promise((r) => setTimeout(r, 30));
    try {
      setRun(await runRender3dSelfTest(host));
    } finally {
      setRunning(false);
    }
  };

  // 読み返した画像の縮小（readPixels は下から上なので上下を戻して描く）
  useEffect(() => {
    const cv = previewRef.current;
    const img = run?.image;
    if (!cv || !img) return;
    const tmp = document.createElement("canvas");
    tmp.width = img.w;
    tmp.height = img.h;
    const tctx = tmp.getContext("2d");
    const ctx = cv.getContext("2d");
    if (!tctx || !ctx) return;
    tctx.putImageData(new ImageData(img.rgba, img.w, img.h), 0, 0);
    ctx.save();
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.translate(0, cv.height);
    ctx.scale(1, -1);
    ctx.drawImage(tmp, 0, 0, cv.width, cv.height);
    ctx.restore();
  }, [run]);

  const copy = async () => {
    if (!run) return;
    let version = "unknown";
    try {
      version = (await fetchStatus()).version;
    } catch {
      /* 版が取れなくてもコピーはできる */
    }
    const json = {
      version,
      userAgent: navigator.userAgent,
      gpu: run.gpu === "unknown" ? t("selftest.unknown") : run.gpu,
      rows: run.rows.map((r) => ({ id: r.id, status: r.status, reason: r.reason, values: r.values ?? {} })),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(json, null, 2));
      setCopyMsg(t("selftest.copied"));
    } catch {
      setCopyMsg(t("selftest.copyFailed"));
    }
  };

  const rows = run ? ROW_ORDER.map((id) => run.rows.find((r) => r.id === id)).filter((r): r is SelfTestRow => !!r) : [];

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <button data-testid="selftest-run" onClick={start} disabled={running} style={btn}>
          {running ? t("selftest.running") : t("selftest.run")}
        </button>
        <button data-testid="selftest-copy" onClick={copy} disabled={!run} style={btn}>
          {t("selftest.copy")}
        </button>
        {copyMsg && <span style={{ fontSize: 12, color: "#6b7785" }}>{copyMsg}</span>}
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {rows.map((r) => (
            <div key={r.id} data-testid={`selftest-row-${r.id}`} data-status={r.status} style={row}>
              <span style={{ width: 20, color: COLORS[r.status] }}>{MARKS[r.status]}</span>
              <span style={{ width: 160, fontSize: 14 }}>{t(`selftest.row.${r.id}`)}</span>
              <span style={{ fontSize: 13, color: COLORS[r.status] }}>
                {t(`selftest.status.${r.status}`)}
                {" · "}
                {t(`selftest.reason.${r.reason}`, { size: String(r.values?.maxTextureSize3d ?? "") })}
              </span>
            </div>
          ))}
          {run && (
            <div style={{ fontSize: 12, color: "#6b7785", marginTop: 8 }}>
              {t("selftest.gpu")}: {run.gpu === "unknown" ? t("selftest.unknown") : run.gpu}
            </div>
          )}
        </div>
        <div>
          {/* 診断用の描画先（固定寸法の見える div） */}
          <div ref={hostRef} data-testid="selftest-host" style={{ width: 256, height: 256, background: "#000", position: "relative" }} />
          {run?.image && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12, color: "#6b7785" }}>{t("selftest.preview")}</div>
              <canvas ref={previewRef} width={96} height={96} data-testid="selftest-preview" style={{ border: "1px solid #ccd" }} />
            </div>
          )}
        </div>
      </div>

      <p style={{ fontSize: 12, color: "#6b7785", marginTop: 16 }}>{t("selftest.disclaimer")}</p>
    </div>
  );
}

const btn: React.CSSProperties = { padding: "6px 14px", fontSize: 13, cursor: "pointer" };
const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 0",
  borderBottom: "1px solid #f1f3f5",
};
