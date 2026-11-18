/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// メイン画面の「資料」節の表示用の純関数。backend が検証済みの構造を返すが、**画面側でも再検証する**
// （https・mailto 以外のリンクは出さない。形が違うものは捨てる）。患者情報・検査の情報は一切扱わない。
import type { FacilityConfig, FacilityGroup, FacilityItem } from "../settings/facilityView";

/** 画面に出してよいリンク: https か mailto だけ（`http:`・`javascript:`・`file:`・`data:`・相対 URL は出さない）。 */
export function isSafeResourceUrl(url: unknown): url is string {
  return typeof url === "string" && url.length <= 2000 && /^(https:\/\/[^\s/?#]+|mailto:[^\s]+)/i.test(url) && !/[\s\u0000-\u001f]/.test(url);
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function cleanItem(raw: unknown): FacilityItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const title = str(r.title);
  if (!id || !title) return null;
  if (r.type === "link") {
    return isSafeResourceUrl(r.url) ? { id, type: "link", title, url: r.url, note: str(r.note), body: null } : null;
  }
  if (r.type === "card") {
    const body = str(r.body);
    if (!body) return null;
    const url = r.url == null ? null : isSafeResourceUrl(r.url) ? r.url : null;
    return { id, type: "card", title, url, note: str(r.note), body };
  }
  return null;
}

function cleanGroup(raw: unknown): FacilityGroup | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const title = str(r.title);
  if (!id || !title) return null;
  const items = Array.isArray(r.items) ? r.items.map(cleanItem).filter((x): x is FacilityItem => x !== null) : [];
  const groups = Array.isArray(r.groups) ? r.groups.map(cleanGroup).filter((x): x is FacilityGroup => x !== null) : [];
  return { id, title, items, groups };
}

/** backend の内容を画面用に整える。安全でないリンクの項目・形の違うものは捨てる。groups が無ければ null。 */
export function sanitizeFacilityConfig(raw: unknown): FacilityConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.groups)) return null;
  const contact = isSafeResourceUrl(r.contact) && /^mailto:/i.test(r.contact) ? r.contact : null;
  return {
    title: str(r.title),
    updatedAt: str(r.updatedAt),
    contact,
    groups: r.groups.map(cleanGroup).filter((x): x is FacilityGroup => x !== null),
  };
}

/** 「管理者に連絡」の宛先。件名が無ければ、件名だけ足す（本文・患者情報は入れない）。 */
export function contactUrl(contact: string, subject: string): string {
  return contact.includes("?") ? contact : `${contact}?subject=${encodeURIComponent(subject)}`;
}

// ── 開閉の状態（端末の localStorage。グループ id ごと。例外は握りつぶして既定＝すべて閉じる）──
const OPEN_KEY = "graphy.facility.open";
export const SECTION_ID = "__section__";

export function loadOpen(): Set<string> {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveOpen(open: Set<string>): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
  } catch {
    /* 保存できなくても、その場の開閉は動く */
  }
}
