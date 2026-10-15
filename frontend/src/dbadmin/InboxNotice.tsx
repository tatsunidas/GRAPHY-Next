/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 他の DB から届いた検査を、この DB を開いたときに取り込んだ結果を一度だけ知らせる（standalone のみ）。
 *
 * <p>取り込みは起動後に backend が別スレッドで行うので、終わるまで問い合わせを繰り返す。
 */
import { useEffect, useState, type CSSProperties } from "react";
import { useI18n } from "../i18n/i18n";
import { fetchInboxStatus, type InboxStatus } from "./dbTransferApi";
import { hasInboxNews, inboxNewsKey } from "./dbTransferView";

const SEEN_KEY = "graphy.inboxNoticeSeen";

export function InboxNotice({ onImported }: { onImported: () => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<InboxStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const s = await fetchInboxStatus();
        if (stop) return;
        if (s.running) {
          timer = setTimeout(() => void tick(), 2000);
          return;
        }
        setStatus(s);
        if (s.results.some((r) => r.imported > 0)) onImported();
      } catch {
        // web モード・古い backend には無い。知らせることが無いだけなので黙る
      }
    };
    void tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
    // 起動時に一度だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (dismissed || !status || !hasInboxNews(status)) return null;
  const key = inboxNewsKey(status);
  try {
    if (sessionStorage.getItem(SEEN_KEY) === key) return null;
  } catch {
    // 使えなければ毎回出す
  }
  const close = () => {
    try {
      sessionStorage.setItem(SEEN_KEY, key);
    } catch {
      // 使えなくても閉じる
    }
    setDismissed(true);
  };

  return (
    <div data-testid="inbox-notice" style={box}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("dbTransfer.inbox.title")}</div>
      {status.results.map((r) => (
        <div key={r.id} style={{ fontSize: 12, margin: "2px 0" }}>
          {t("dbTransfer.inbox.result", {
            from: r.sourceDbFolder ?? "?",
            imported: r.imported,
            skipped: r.skippedExisting,
            failed: r.failed,
            conflicts: r.conflicts,
          })}
        </div>
      ))}
      {status.results.some((r) => r.conflicts > 0 || r.failed > 0) && (
        <div style={{ fontSize: 12, color: "#8a5a00" }}>{t("dbTransfer.inbox.kept")}</div>
      )}
      {status.stalePartials.length > 0 && (
        <div style={{ fontSize: 12, color: "#8a5a00" }}>
          {t("dbTransfer.inbox.stale", { count: status.stalePartials.length })}
        </div>
      )}
      <div style={{ textAlign: "right", marginTop: 6 }}>
        <button onClick={close} style={{ fontSize: 12 }}>
          {t("common.close")}
        </button>
      </div>
    </div>
  );
}

const box: CSSProperties = {
  position: "fixed",
  right: 16,
  bottom: 36,
  zIndex: 1050,
  maxWidth: 520,
  background: "#fffbe6",
  border: "1px solid #e6d27a",
  borderRadius: 6,
  padding: "10px 12px",
  boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
  fontFamily: "system-ui, sans-serif",
};
