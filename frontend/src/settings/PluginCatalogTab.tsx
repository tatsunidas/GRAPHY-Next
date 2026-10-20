/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { fetchPluginCatalog, type CatalogItem, type CatalogView } from "../plugins/pluginManagerApi";
import { filterRows, toRow, type CatalogRow, type Tier } from "./pluginCatalogView";

interface Props {
  /** 導入操作ができるか（オプトイン済みなど）。false なら一覧の閲覧のみ。 */
  canManage: boolean;
  /** 他の操作が処理中か（導入ボタンを無効にする）。 */
  busy: boolean;
  /** いま導入の確認中の行の id。 */
  inspectingId: string | null;
  /** 導入・削除のたびに変わる値。変わったら一覧の導入済み状態を取り直す。 */
  refreshKey: number;
  onInstall: (item: CatalogItem) => void;
}

/**
 * 環境設定 ＞ プラグイン ＞ 見つける。公式索引（graphy-next-plugin-index）の一覧に導入済みの状態を重ねて見せる。
 * 索引に載っていることは安全の保証ではない（注意文を常に出す）。導入は親の inspect → 同意 → install の経路を通る。
 */
export function PluginCatalogTab({ canManage, busy, inspectingId, refreshKey, onInstall }: Props) {
  const { t } = useI18n();
  const [view, setView] = useState<CatalogView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [tier, setTier] = useState<Tier | "all">("all");

  useEffect(() => {
    let cancelled = false;
    fetchPluginCatalog()
      .then((v) => {
        if (cancelled) return;
        setView(v);
        setFailed(null);
      })
      .catch((e) => {
        if (!cancelled) setFailed(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const rows = useMemo(() => (view?.plugins ?? []).map(toRow), [view]);
  const shown = useMemo(() => filterRows(rows, { query, tier }), [rows, query, tier]);

  if (failed !== null) return <div style={errorText}>{t("common.fetchError", { error: failed })}</div>;
  if (view === null) return <div style={{ color: "#888" }}>{t("common.loading")}</div>;
  if (!view.configured) return <div style={noticeBox}>{t("pluginmgr.catalog.notConfigured")}</div>;

  return (
    <div>
      <p style={{ fontSize: 12, color: "#6b5a00", margin: "0 0 10px" }}>⚠ {t("pluginmgr.catalog.disclaimer")}</p>

      {view.stale && (
        <div data-testid="pluginmgr-catalog-stale" style={noticeBox}>
          {t(rows.length > 0 ? "pluginmgr.catalog.stale" : "pluginmgr.catalog.staleEmpty", { error: view.error ?? "" })}
        </div>
      )}
      {view.rejected.length > 0 && (
        <div style={{ fontSize: 12, color: "#9a3412", marginBottom: 8 }} title={view.rejected.join("\n")}>
          {t("pluginmgr.catalog.rejected", { count: String(view.rejected.length) })}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <input
          style={{ ...input, flex: 1, minWidth: 160 }}
          value={query}
          placeholder={t("pluginmgr.catalog.search")}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select style={input} value={tier} onChange={(e) => setTier(e.target.value as Tier | "all")}>
          <option value="all">{t("pluginmgr.catalog.filter.all")}</option>
          <option value="bundled">{t("pluginmgr.catalog.tier.bundled")}</option>
          <option value="official">{t("pluginmgr.catalog.tier.official")}</option>
          <option value="community">{t("pluginmgr.catalog.tier.community")}</option>
        </select>
      </div>

      {rows.length === 0 ? (
        <div style={{ color: "#888", fontSize: 13, padding: "6px 0" }}>{t("pluginmgr.catalog.empty")}</div>
      ) : shown.length === 0 ? (
        <div style={{ color: "#888", fontSize: 13, padding: "6px 0" }}>{t("pluginmgr.catalog.noMatch")}</div>
      ) : (
        shown.map((r) => (
          <CatalogRowView key={r.item.id} row={r} canManage={canManage} busy={busy}
            inspecting={inspectingId === r.item.id} onInstall={onInstall} />
        ))
      )}
    </div>
  );
}

function CatalogRowView({ row, canManage, busy, inspecting, onInstall }: {
  row: CatalogRow; canManage: boolean; busy: boolean; inspecting: boolean; onInstall: (item: CatalogItem) => void;
}) {
  const { t } = useI18n();
  const { item, tier, officialConfirmed } = row;
  const inst = item.installed;
  return (
    <div data-testid={`pluginmgr-catalog-row-${item.id}`} style={dataRow}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={nameLine}>
          {item.name}
          <span style={{ ...badge, color: tierColor(tier), borderColor: tierColor(tier) }}>
            {t(`pluginmgr.catalog.tier.${tier}`)}
          </span>
        </div>
        {item.description && <div style={{ fontSize: 12, color: "#4a5663", margin: "2px 0" }}>{item.description}</div>}
        <div style={metaLine}>
          <span>{item.repo}</span>
          {item.minGraphy && (
            <>
              <span style={metaSep}>·</span>
              <span>{t("pluginmgr.catalog.minGraphy", { version: item.minGraphy })}</span>
            </>
          )}
          {item.signerKeyId && (
            <>
              <span style={metaSep}>·</span>
              <span title={item.signerKeyId}>
                {t(officialConfirmed ? "pluginmgr.catalog.signedConfirmed" : item.officialSigner
                  ? "pluginmgr.catalog.signedOfficialClaim" : "pluginmgr.catalog.signedKey",
                { key: item.signerKeyId.slice(0, 8) })}
              </span>
            </>
          )}
        </div>
      </div>
      <div style={{ flex: "none", textAlign: "right" }}>
        {inst ? (
          <span style={{ fontSize: 12, color: "#2e5d27" }}>
            {t("pluginmgr.catalog.installedVersion", { version: inst.version })}
            {!inst.enabled && <span style={{ color: "#b00020" }}> ({t("pluginmgr.disabled")})</span>}
          </span>
        ) : (
          <button style={{ ...primaryBtn, background: !canManage || busy ? "#9fb6cf" : "#0b5cad" }}
            disabled={!canManage || busy} onClick={() => onInstall(item)}>
            {inspecting ? t("pluginmgr.inspecting") : t("pluginmgr.catalog.install")}
          </button>
        )}
      </div>
    </div>
  );
}

function tierColor(tier: Tier): string {
  if (tier === "bundled") return "#0b5cad";
  if (tier === "official") return "#2e7d32";
  return "#8a6d00";
}

const input: React.CSSProperties = { minWidth: 0, padding: "5px 8px", border: "1px solid #cdd5de", borderRadius: 5, fontSize: 13 };
const noticeBox: React.CSSProperties = {
  fontSize: 12, color: "#6b5a00", background: "#fff8e1", border: "1px solid #f0e2a8",
  borderRadius: 6, padding: "8px 10px", marginBottom: 10,
};
const errorText: React.CSSProperties = { fontSize: 12, color: "#b00020" };
const dataRow: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, padding: "8px 0", fontSize: 13, borderTop: "1px solid #eef1f5",
};
const nameLine: React.CSSProperties = {
  fontSize: 13, fontWeight: 600, color: "#33404d", overflowWrap: "anywhere", lineHeight: 1.35,
};
const badge: React.CSSProperties = {
  marginLeft: 8, padding: "0 6px", border: "1px solid", borderRadius: 10, fontSize: 11, fontWeight: 400,
};
const metaLine: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", fontSize: 11, color: "#6b7785", minWidth: 0,
};
const metaSep: React.CSSProperties = { color: "#c2cad3", flex: "none" };
const primaryBtn: React.CSSProperties = { padding: "6px 14px", border: "none", borderRadius: 6, color: "#fff", fontSize: 13, cursor: "pointer" };
