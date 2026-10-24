/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";
import type { AnonOption } from "../api";
import { desktop } from "../desktopBridge";
import { useI18n } from "../i18n/i18n";
import { toggleAnonOption } from "../mainscreen/anonDefaults";
import { fetchReceiveAnon, saveReceiveAnon } from "./receiveAnonApi";
import {
  buildBody, DEFAULT_PREFIX, MAX_PREFIX, RECEIVE_CLEAN_OPTS, RECEIVE_RETAIN_OPTS, rejectReasonKey, validateForm,
  type ReceiveAnonView,
} from "./receiveAnonView";

/**
 * 受信時の匿名化（C-STORE・C-GET で受けた画像を、保管庫に入れる前に匿名化する）の設定と状態。
 * 受信は standalone だけなので、web モード（REST が 404）では何も出さない。
 * 設定は保存後、再起動なしで次の受信から効く。鍵の中身は画面に出さない（書き出しは main が保存ダイアログへ直接書く）。
 */
export function ReceiveAnonymizePanel() {
  const { t } = useI18n();
  const [view, setView] = useState<ReceiveAnonView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [options, setOptions] = useState<Set<AnonOption>>(new Set());
  const [prefix, setPrefix] = useState(DEFAULT_PREFIX);
  const [name, setName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const d = desktop();

  const load = (v: ReceiveAnonView) => {
    setView(v);
    setEnabled(v.enabled);
    const shown = new Set<string>([...RECEIVE_RETAIN_OPTS, ...RECEIVE_CLEAN_OPTS]);
    setOptions(new Set((v.profile?.options ?? []).filter((o) => shown.has(o)) as AnonOption[]));
    setPrefix(v.profile?.patientIdPrefix ?? DEFAULT_PREFIX);
    setName(v.profile?.patientName ?? "");
    setConfirmed(false);
  };

  useEffect(() => {
    let alive = true;
    fetchReceiveAnon().then((v) => { if (alive) load(v); }).catch(() => { if (alive) setView(null); });
    return () => { alive = false; };
  }, []);

  if (!view) return null;

  const save = async () => {
    const bad = validateForm({ enabled, wasEnabled: view.enabled, confirmed, prefix });
    if (bad) {
      setMsg({ text: t(bad), error: true });
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const next = await saveReceiveAnon(enabled, buildBody(view.profile, [...options], prefix, name));
      load(next);
      setMsg({ text: t("recvAnon.saved"), error: false });
    } catch (e) {
      setMsg({ text: t("recvAnon.saveFail", { error: e instanceof Error ? e.message : String(e) }), error: true });
    } finally {
      setSaving(false);
    }
  };

  const exportKey = async () => {
    setMsg(null);
    try {
      const r = await d!.receiveAnonKeyExport!();
      if (r.ok) setMsg({ text: t("recvAnon.key.exported"), error: false });
      else if (!r.canceled) setMsg({ text: t("recvAnon.key.exportFail"), error: true });
    } catch {
      setMsg({ text: t("recvAnon.key.exportFail"), error: true });
    }
  };

  const st = view.status;
  const toggle = (o: AnonOption) => setOptions((s) => toggleAnonOption(s, o));
  const opt = (o: AnonOption) => (
    <label key={o} style={rowCheck}>
      <input type="checkbox" checked={options.has(o)} onChange={() => toggle(o)} />
      {t(`anon.opt.${o}`)}
    </label>
  );

  return (
    <div data-testid="recv-anon-panel" style={{ marginTop: 26, borderTop: "1px solid #e6eaee", paddingTop: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: "#33404d", marginBottom: 4 }}>{t("recvAnon.title")}</div>
      <p style={{ fontSize: 12.5, color: "#6b7785", marginTop: 0 }}>{t("recvAnon.help")}</p>

      <label style={rowCheck}>
        <input data-testid="recv-anon-enabled" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t("recvAnon.enabled")}
      </label>

      {enabled && !view.enabled && (
        <div style={warnBox}>
          <div>{t("recvAnon.confirm.text")}</div>
          <label style={{ ...rowCheck, marginTop: 6 }}>
            <input data-testid="recv-anon-confirm" type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            {t("recvAnon.confirm.check")}
          </label>
        </div>
      )}

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 12 }}>
        <div>
          <div style={grp}>{t("anon.clean")}</div>
          {RECEIVE_CLEAN_OPTS.map(opt)}
        </div>
        <div>
          <div style={grp}>{t("anon.retain")}</div>
          {RECEIVE_RETAIN_OPTS.map(opt)}
        </div>
      </div>
      <p style={{ fontSize: 12, color: "#6b7785" }}>{t("recvAnon.pixelNote")}</p>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label style={lbl}>{t("recvAnon.prefix")}</label>
        <input data-testid="recv-anon-prefix" style={{ ...input, width: 140 }} value={prefix} maxLength={MAX_PREFIX + 10}
          onChange={(e) => setPrefix(e.target.value)} />
        <label style={lbl}>{t("recvAnon.name")}</label>
        <input style={{ ...input, width: 180 }} value={name} placeholder={t("recvAnon.name.placeholder")}
          onChange={(e) => setName(e.target.value)} />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
        <button data-testid="recv-anon-save" onClick={save} disabled={saving}
          style={{ ...saveBtn, background: saving ? "#9fb6cf" : "#0b5cad", cursor: saving ? "default" : "pointer" }}>
          {saving ? t("common.saving") : t("common.save")}
        </button>
        {d?.receiveAnonKeyExport && (
          <button data-testid="recv-anon-key-export" onClick={() => void exportKey()} style={subBtn}>
            {t("recvAnon.key.export")}
          </button>
        )}
        {msg && <span data-testid="recv-anon-msg" style={{ fontSize: 12, color: msg.error ? "#b00020" : "#2e5d27" }}>{msg.text}</span>}
      </div>

      <div data-testid="recv-anon-status" style={{ marginTop: 14, fontSize: 12.5, color: "#33404d" }}>
        <div style={{ fontWeight: 600 }}>{t("recvAnon.status.title")}</div>
        {!st.profileValid && <div style={{ color: "#b00020" }}>{t("recvAnon.status.invalid")}</div>}
        <div>{t("recvAnon.status.counts", { accepted: st.accepted, rejected: st.rejected })}</div>
        <div>
          {st.keyCreatedAt ? t("recvAnon.status.key", { at: st.keyCreatedAt }) : t("recvAnon.status.keyNone")}
        </div>
        {st.keyCreatedThisRun && <div style={{ color: "#8a5a00" }}>{t("recvAnon.status.keyNew")}</div>}
        {st.recentRejections.length > 0 && (
          <div style={{ marginTop: 4 }}>
            {t("recvAnon.status.recent")}
            <ul style={{ margin: "2px 0 0 18px", padding: 0 }}>
              {st.recentRejections.map((c, i) => <li key={i}>{t(rejectReasonKey(c))}</li>)}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

const rowCheck: React.CSSProperties = { display: "flex", alignItems: "center", gap: 7, fontSize: 13, cursor: "pointer", marginTop: 3 };
const lbl: React.CSSProperties = { fontSize: 12.5, color: "#33404d" };
const grp: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "#33404d", marginBottom: 2 };
const input: React.CSSProperties = { minWidth: 0, padding: "5px 8px", border: "1px solid #cdd5de", borderRadius: 5, fontSize: 13 };
const saveBtn: React.CSSProperties = { padding: "6px 16px", border: "none", borderRadius: 6, color: "#fff", fontSize: 13 };
const subBtn: React.CSSProperties = { padding: "6px 14px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", fontSize: 13, cursor: "pointer" };
const warnBox: React.CSSProperties = {
  marginTop: 8, padding: "8px 10px", background: "#fff6e0", border: "1px solid #ecd9a6", borderRadius: 6, fontSize: 12.5, color: "#5c4300",
};
