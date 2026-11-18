/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 環境設定 ＞ 施設の資料。施設が用意した資料（リンク集・参照カード）の設定ファイル（JSON）の場所を決め、読めているかを見る。
 * 読み込みは backend（再起動なしで反映）。ファイルは読むだけで実行しない。リンクは https と mailto だけ。患者情報は入れない。
 * Web 版では場所をサーバー側の設定（環境変数）で決める。ここからは変えられない。
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { fetchStatus } from "../api";
import { formatDateTime } from "../i18n/dateFormat";
import { useI18n } from "../i18n/i18n";
import { fetchFacilityConfig } from "./facilityApi";
import { canEditPath, countFacility, facilityErrorKey, type FacilityResponse } from "./facilityView";
import { fetchSettings, saveSettings } from "./settingsApi";

const POLL_MS = 2000;
const KEY_PATH = "facility.configPath";

export function FacilityPanel() {
  const { t } = useI18n();
  const [mode, setMode] = useState<string | undefined>(undefined);
  const [res, setRes] = useState<FacilityResponse | null | undefined>(undefined); // undefined = 未取得、null = 未設定
  const [path, setPath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const refresh = async () => {
      try {
        const r = await fetchFacilityConfig();
        if (alive.current) setRes(r ?? null);
      } catch {
        if (alive.current) setUnavailable(true);
      }
    };
    fetchStatus()
      .then((s) => alive.current && setMode(s.mode))
      .catch(() => undefined);
    // 設定の読み込みは 1 回だけ（入力の途中を巻き戻さない）
    fetchSettings()
      .then((s) => alive.current && setPath((cur) => cur ?? (s[KEY_PATH] ?? "")))
      .catch(() => alive.current && setUnavailable(true));
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, []);

  if (unavailable) return <p style={muted}>{t("facility.unavailable")}</p>;
  if (res === undefined || path === null) return <p style={muted}>…</p>;

  const source = res?.source ?? "none";
  const editable = canEditPath(mode, source);

  const save = async () => {
    setMessage(null);
    try {
      await saveSettings({ [KEY_PATH]: path.trim() });
      setDirty(false);
      setMessage(t("facility.saved"));
    } catch (e) {
      setMessage(String(e));
    }
  };

  const counts = res ? countFacility(res.config) : { groups: 0, items: 0 };
  const where = res?.errorPath ? t("facility.where", { path: res.errorPath }) : "";
  const kept = res?.config ? t("facility.keptPrevious") : t("facility.nothingShown");

  return (
    <div data-testid="facility-panel">
      <p style={note}>{t("facility.intro")}</p>

      {editable ? (
        <div style={row}>
          <span style={lbl}>{t("facility.path")}</span>
          <input
            style={{ ...input, flex: 1 }}
            data-testid="facility-path"
            value={path}
            spellCheck={false}
            placeholder="/path/to/facility-config.json"
            onChange={(e) => {
              setPath(e.target.value);
              setDirty(true);
              setMessage(null);
            }}
          />
          <button style={btn} data-testid="facility-save" disabled={!dirty} onClick={() => void save()}>
            {t("facility.save")}
          </button>
        </div>
      ) : (
        <p style={note} data-testid="facility-readonly">
          {source === "server" ? t("facility.serverSide") : t("facility.webNote")}
        </p>
      )}
      {message && <p style={note}>{message}</p>}

      <h3 style={h3}>{t("facility.sec.status")}</h3>
      <div data-testid="facility-status" data-state={res ? res.state : "unconfigured"} style={statusBox}>
        {res === null && t("facility.state.unconfigured")}
        {res?.state === "ok" &&
          t("facility.state.ok", {
            groups: String(counts.groups),
            items: String(counts.items),
            time: res.lastReadAt ? formatDateTime(res.lastReadAt) : "",
          })}
        {res?.state === "missing" && t("facility.state.missing")}
        {res?.state === "error" && (
          <span data-testid="facility-error" data-code={res.error ?? ""}>
            {t("facility.state.error", { reason: t(facilityErrorKey(res.error)), where, kept })}
          </span>
        )}
      </div>
      <p style={note}>{t("facility.doc")}</p>
    </div>
  );
}

const muted: CSSProperties = { color: "#666" };
const note: CSSProperties = { color: "#444", fontSize: 13, margin: "8px 0" };
const row: CSSProperties = { display: "flex", alignItems: "center", gap: 8, margin: "8px 0" };
const lbl: CSSProperties = { minWidth: 150, fontSize: 13 };
const input: CSSProperties = { padding: "4px 8px", border: "1px solid #bbb", borderRadius: 4, font: "inherit" };
const btn: CSSProperties = { padding: "4px 12px", border: "1px solid #0b5cad", background: "#0b5cad", color: "#fff", borderRadius: 4, cursor: "pointer" };
const h3: CSSProperties = { fontSize: 14, margin: "16px 0 6px" };
const statusBox: CSSProperties = { border: "1px solid #ddd", borderRadius: 6, padding: "8px 12px", fontSize: 13, background: "#fafafa" };
