/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { Locale } from "../i18n/i18n";
import type { DocHit } from "./docsIndex";

/** 操作案内用の system プロンプト。資料は質問ごとに検索した上位の断片だけを添える。 */
export function buildSystemPrompt(locale: Locale, hits: DocHit[]): string {
  const lang = locale === "ja" ? "日本語" : "English";
  const lines = [
    "You are the in-app help assistant of GRAPHY-Next, a DICOM viewer for medical imaging.",
    `Answer in ${lang}, concisely, with numbered steps for operations.`,
    "You cannot operate the application and cannot see the user's screen; say so if asked to do something for them, and instead explain how they can do it.",
    "Base operational answers on the DOCUMENTS below. If they do not cover the question, say that the documentation does not cover it rather than guessing menu names or features.",
    "This is not a diagnostic tool: do not give clinical interpretation of images.",
    `Window: assistant. UI language: ${locale}.`,
  ];
  if (hits.length) {
    lines.push("", "DOCUMENTS:");
    for (const h of hits) lines.push(`--- ${h.file} / ${h.heading}`, h.text);
  } else {
    lines.push("", "DOCUMENTS: (no relevant document was found for this question)");
  }
  return lines.join("\n");
}
