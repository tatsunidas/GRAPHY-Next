/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { extractDocx, extractPptx, extractXlsx } from "./ooxml";
import { extractPdf, type PdfjsLike } from "./pdf";
import { decodeText } from "./text";
import { classify, AttachError } from "./limits";
import { looksLikeIdentifiers } from "./identifiers";
import { composeUserText, ingest, type Attachment } from "./index";
import { frameTimes } from "./video";

async function zipOf(files: Record<string, string>): Promise<ArrayBuffer> {
  const z = new JSZip();
  for (const [k, v] of Object.entries(files)) z.file(k, v);
  return z.generateAsync({ type: "arraybuffer" });
}
const u8 = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e) => e)) as AttachError | null)?.code ?? "ok";

const DOCX = {
  "word/document.xml": `<w:document><w:body><w:p><w:r><w:t>肺結節の評価</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve"> A&amp;B</w:t></w:r></w:p><w:p><w:r><w:t>2行目</w:t></w:r></w:p><w:p/></w:body></w:document>`,
};
const XLSX = {
  "xl/workbook.xml": `<workbook><sheets><sheet name="結果" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
  "xl/sharedStrings.xml": `<sst><si><t>項目</t></si><si><r><t>値</t></r></si></sst>`,
  "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>SUV</t></is></c><c r="B2"><v>3.5</v></c></row></sheetData></worksheet>`,
};
const PPTX = {
  "ppt/slides/slide2.xml": `<p:sld><a:p><a:r><a:t>二枚目</a:t></a:r></a:p></p:sld>`,
  "ppt/slides/slide1.xml": `<p:sld><a:p><a:r><a:t>一枚目</a:t></a:r></a:p></p:sld>`,
  "ppt/notesSlides/notesSlide1.xml": `<p:notes><a:p><a:r><a:t>メモ</a:t></a:r></a:p></p:notes>`,
};

describe("ooxml", () => {
  it("docx: 段落・タブ・実体参照を読む／空・壊れた zip・document.xml 無しは断る", async () => {
    expect(await extractDocx(await zipOf(DOCX))).toBe("肺結節の評価\t A&B\n2行目");
    expect(await code(extractDocx(await zipOf({ "word/document.xml": "<w:document><w:p/></w:document>" })))).toBe("empty");
    expect(await code(extractDocx(u8("not a zip")))).toBe("broken");
    expect(await code(extractDocx(await zipOf({ "x.txt": "a" })))).toBe("broken");
  });
  it("xlsx: 共有文字列・インライン・数値・列の空き／空は断る", async () => {
    const t = await extractXlsx(await zipOf(XLSX));
    expect(t).toBe("## シート: 結果\n項目\t\t値\nSUV\t3.5");
    expect(await code(extractXlsx(await zipOf({ ...XLSX, "xl/worksheets/sheet1.xml": "<worksheet><sheetData/></worksheet>" })))).toBe("empty");
  });
  it("xlsx: 行数の上限を超えた分は省略と明示する", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join("");
    const t = await extractXlsx(await zipOf({ ...XLSX, "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${rows}</sheetData></worksheet>` }));
    expect(t).toContain("(以下 50 行省略)");
  });
  it("pptx: スライド番号順（辞書順にしない）とノート", async () => {
    const t = await extractPptx(await zipOf(PPTX));
    expect(t.indexOf("一枚目")).toBeLessThan(t.indexOf("二枚目"));
    expect(t).toContain("(ノート)\nメモ");
    expect(await code(extractPptx(await zipOf({ "x": "a" })))).toBe("broken");
  });
  it("展開後サイズが大きすぎる zip は断る（zip 爆弾）", async () => {
    const z = new JSZip();
    z.file("word/document.xml", "<w:p><w:t>x</w:t></w:p>");
    z.file("big.bin", new Uint8Array(210 * 1024 * 1024)); // 0 埋めは極端に縮む＝爆弾の形
    const buf = await z.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
    expect(buf.byteLength).toBeLessThan(2 * 1024 * 1024);
    expect(await code(extractDocx(buf))).toBe("bomb");
  });
});

describe("text / classify / identifiers", () => {
  it("BOM を除く・UTF-8 でないバイト列は断る・空は断る", () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]).buffer)).toBe("a");
    expect(() => decodeText(new Uint8Array([0x83, 0x65, 0x83, 0x58]).buffer)).toThrow(); // Shift_JIS「テス」
    expect(() => decodeText(u8("  \n"))).toThrow();
  });
  it("classify: 偽装拡張子でも名前の種類で扱い、旧形式は legacy", () => {
    expect(classify("a.PDF", "")).toBe("pdf");
    expect(classify("a.xls", "")).toBe("legacy");
    expect(classify("a.mov", "")).toBe("video");
    expect(classify("a.bin", "application/octet-stream")).toBe("unknown");
    expect(classify("x.csv", "")).toBe("text");
  });
  it("識別子の目安: 正例と負例", () => {
    expect(looksLikeIdentifiers("PatientName: YAMADA^TARO")).toBe(true);
    expect(looksLikeIdentifiers("患者氏名：山田")).toBe(true);
    expect(looksLikeIdentifiers("(0010,0010) PN")).toBe(true);
    expect(looksLikeIdentifiers("肺結節の大きさは 8 mm、SUV 3.5")).toBe(false);
  });
});

describe("pdf", () => {
  function fakePdfjs(pages: string[], fail?: string): PdfjsLike {
    return {
      getDocument: () => ({
        promise: fail
          ? Promise.reject(Object.assign(new Error(fail), { name: fail }))
          : Promise.resolve({ numPages: pages.length, getPage: async (n: number) => ({ getTextContent: async () => ({ items: [{ str: pages[n - 1], hasEOL: true }] }) }) }),
      }),
    };
  }
  it("頁ごとに読む・空頁を数える・全頁空なら text 空", async () => {
    const r = await extractPdf(new ArrayBuffer(8), fakePdfjs(["abc", ""]));
    expect(r.text).toBe("## 頁 1\nabc\n\n## 頁 2\n");
    expect(r.emptyPages).toEqual([2]);
    expect((await extractPdf(new ArrayBuffer(8), fakePdfjs(["", ""]))).text).toBe("");
  });
  it("パスワード付き・壊れたものは区別して断る", async () => {
    expect(await code(extractPdf(new ArrayBuffer(8), fakePdfjs([], "PasswordException")))).toBe("encrypted");
    expect(await code(extractPdf(new ArrayBuffer(8), fakePdfjs([], "InvalidPDFException")))).toBe("broken");
  });
  it("実際の pdfjs で最小の PDF から文字を取り出せる", async () => {
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsLike;
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      "<< /Length 44 >>\nstream\nBT /F1 18 Tf 10 50 Td (Hello Lung) Tj ET\nendstream",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offs: number[] = [];
    objs.forEach((o, i) => ((offs[i] = pdf.length), (pdf += `${i + 1} 0 obj\n${o}\nendobj\n`)));
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const r = await extractPdf(u8(pdf), pdfjs);
    expect(r.text).toContain("Hello Lung");
    expect(await code(extractPdf(u8("%PDF-1.4 garbage"), pdfjs))).toBe("broken");
  });
});

describe("ingest / compose", () => {
  const deps = { loadPdfjs: async () => ({}) as PdfjsLike, extractVideo: async () => ({ duration: 12, width: 640, height: 480, frames: [{ base64: "QQ==", mimeType: "image/jpeg" as const, time: 1 }] }) };
  const file = (name: string, body: BlobPart, type = "") => new File([body], name, { type });
  it("種類ごとに取り込み、上限超過・旧形式・未対応は断る", async () => {
    const a = await ingest(file("n.txt", "PatientID: 123\n本文"), deps);
    expect(a.kind).toBe("text");
    expect(a.identifiers).toBe(true);
    expect((await ingest(file("v.mp4", "x", "video/mp4"), deps)).images).toHaveLength(1);
    expect(await code(ingest(file("o.doc", "x"), deps))).toBe("legacy");
    expect(await code(ingest(file("o.bin", "x"), deps))).toBe("unsupported");
    expect(await code(ingest(file("big.txt", new Uint8Array(2 * 1024 * 1024 + 1)), deps))).toBe("tooLarge");
  });
  const att = (text: string, name = "a.txt"): Attachment => ({ id: "x", name, kind: "text", size: 1, text, totalChars: text.length, images: [], identifiers: false });
  it("ローカル宛ては文字数を絞り、切ったことを本文に書く／クラウドは切らない", () => {
    const big = att("あ".repeat(10_000));
    const loc = composeUserText("要約して", [big], true);
    expect(loc.truncated).toBe(true);
    expect(loc.text).toContain("先頭 6000 文字のみ");
    expect(loc.text.endsWith("要約して")).toBe(true);
    expect(composeUserText("要約して", [big], false).truncated).toBe(false);
    expect(composeUserText("質問", [], true)).toEqual({ text: "質問", truncated: false });
  });
  it("frameTimes: 先頭・末尾を避けた等間隔", () => {
    expect(frameTimes(12, 6)).toEqual([1, 3, 5, 7, 9, 11]);
  });
});
