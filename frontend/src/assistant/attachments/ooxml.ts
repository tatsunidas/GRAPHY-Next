/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// docx / xlsx / pptx の本文抽出。zip は JSZip、XML は正規表現で読む（DOMParser に依存せず node でも試験できる）。
import JSZip from "jszip";
import { AttachError, MAX_UNZIPPED_BYTES, MAX_ZIP_ENTRIES, XLSX_MAX_ROWS } from "./limits";

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === "#") {
      const cp = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    }
    return ENT[e.toLowerCase()] ?? "";
  });
}

async function openZip(buf: ArrayBuffer): Promise<JSZip> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new AttachError("broken");
  }
  let total = 0;
  let n = 0;
  zip.forEach((_p, f) => {
    n++;
    total += (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  });
  if (n > MAX_ZIP_ENTRIES || total > MAX_UNZIPPED_BYTES) throw new AttachError("bomb");
  return zip;
}

async function readXml(zip: JSZip, path: string): Promise<string | null> {
  const f = zip.file(path);
  return f ? f.async("string") : null;
}

/** 段落タグ pTag の塊ごとに、文字タグ tTag の中身を連結して行にする。 */
function paragraphs(xml: string, pTag: string, tTag: string): string[] {
  const out: string[] = [];
  const pRe = new RegExp(`<${pTag}[ >][\\s\\S]*?</${pTag}>`, "g");
  const tokRe = new RegExp(`<${tTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tTag}>|<(?:w:tab|a:tab)\\s*/>|<(?:w:br|a:br)\\s*/>`, "g");
  for (const p of xml.match(pRe) ?? []) {
    let line = "";
    for (const m of p.matchAll(tokRe)) line += m[1] !== undefined ? unescapeXml(m[1]) : m[0].includes("tab") ? "\t" : "\n";
    if (line.trim()) out.push(line.replace(/\n+$/, ""));
  }
  return out;
}

export async function extractDocx(buf: ArrayBuffer): Promise<string> {
  const zip = await openZip(buf);
  const xml = await readXml(zip, "word/document.xml");
  if (xml === null) throw new AttachError("broken");
  const text = paragraphs(xml, "w:p", "w:t").join("\n");
  if (!text.trim()) throw new AttachError("empty");
  return text;
}

export async function extractPptx(buf: ArrayBuffer): Promise<string> {
  const zip = await openZip(buf);
  const num = (p: string) => Number(/(\d+)\.xml$/.exec(p)?.[1] ?? 0);
  const slides = Object.keys(zip.files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a, b) => num(a) - num(b));
  if (!slides.length) throw new AttachError("broken");
  const parts: string[] = [];
  for (const p of slides) {
    const n = num(p);
    const body = paragraphs((await readXml(zip, p)) ?? "", "a:p", "a:t");
    const notes = paragraphs((await readXml(zip, `ppt/notesSlides/notesSlide${n}.xml`)) ?? "", "a:p", "a:t");
    parts.push(`## スライド ${n}\n${body.join("\n")}${notes.length ? `\n(ノート)\n${notes.join("\n")}` : ""}`);
  }
  const text = parts.join("\n\n");
  if (!/[^\s#スライド\d(ノート)]/.test(text.replace(/## スライド \d+/g, ""))) throw new AttachError("empty");
  return text;
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? "") n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

export async function extractXlsx(buf: ArrayBuffer): Promise<string> {
  const zip = await openZip(buf);
  const wb = await readXml(zip, "xl/workbook.xml");
  if (wb === null) throw new AttachError("broken");
  const rels = (await readXml(zip, "xl/_rels/workbook.xml.rels")) ?? "";
  const target = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[0])?.[1];
    const t = /\bTarget="([^"]*)"/.exec(m[0])?.[1];
    if (id && t) target.set(id, t.startsWith("/") ? t.slice(1) : `xl/${t}`);
  }
  const shared: string[] = [];
  const ss = (await readXml(zip, "xl/sharedStrings.xml")) ?? "";
  for (const si of ss.match(/<si>[\s\S]*?<\/si>|<si\/>/g) ?? []) {
    shared.push(unescapeXml([...si.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join("")));
  }
  const parts: string[] = [];
  for (const sh of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = unescapeXml(/\bname="([^"]*)"/.exec(sh[0])?.[1] ?? "");
    const rid = /\br:id="([^"]*)"/.exec(sh[0])?.[1] ?? "";
    const xml = target.has(rid) ? await readXml(zip, target.get(rid)!) : null;
    if (xml === null) continue;
    const rows: string[] = [];
    let omitted = 0;
    for (const row of xml.match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
      const cells: string[] = [];
      for (const c of row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /\br="([^"]*)"/.exec(c[1])?.[1] ?? "";
        const type = /\bt="([^"]*)"/.exec(c[1])?.[1];
        const inner = c[2] ?? "";
        let v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
        if (type === "s") v = shared[Number(v)] ?? "";
        else if (type === "inlineStr") v = unescapeXml([...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));
        else v = unescapeXml(v);
        if (ref) cells[colIndex(ref)] = v.replace(/[\t\r\n]+/g, " ");
      }
      if (!cells.some((x) => x)) continue;
      if (rows.length >= XLSX_MAX_ROWS) {
        omitted++;
        continue;
      }
      rows.push(Array.from(cells, (x) => x ?? "").join("\t"));
    }
    parts.push(`## シート: ${name}\n${rows.join("\n")}${omitted ? `\n(以下 ${omitted} 行省略)` : ""}`);
  }
  if (!parts.some((p) => p.split("\n").length > 1 && p.split("\n")[1].trim())) throw new AttachError("empty");
  return parts.join("\n\n");
}
