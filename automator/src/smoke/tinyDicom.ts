/*
 * 検査用の最小の DICOM（Part 10、Explicit VR Little Endian、2×2 の 16 bit 画素）を書く。患者名・患者 ID・検査日・受付番号を指定できる。
 * インストール版のスモークで「患者の値が MCP の出力に出ない」を確かめる、実際に取り込める検査を 1 件作るために使う（外部ファイルに依存しない）。
 */
import fs from "node:fs";

const le16 = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);
const le32 = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);

/** 値を偶数長にそろえる（UI は NUL、文字列は空白。OB/OW はそのまま偶数）。 */
function pad(v: Buffer, vr: string): Buffer {
  if (v.length % 2 === 0) return v;
  return Buffer.concat([v, Buffer.from([vr === "UI" ? 0 : 0x20])]);
}

function element(group: number, elem: number, vr: string, value: Buffer): Buffer {
  const v = pad(value, vr);
  const head = Buffer.concat([le16(group), le16(elem), Buffer.from(vr, "ascii")]);
  // OB・OW・UN・SQ などは 2 バイト予約＋4 バイト長、それ以外は 2 バイト長
  return ["OB", "OW", "OF", "SQ", "UT", "UN"].includes(vr) ? Buffer.concat([head, le16(0), le32(v.length), v]) : Buffer.concat([head, le16(v.length), v]);
}
const str = (g: number, e: number, vr: string, s: string) => element(g, e, vr, Buffer.from(s, "utf8"));

export interface TinyDicom {
  patientName: string;
  patientId: string;
  studyDate: string; // YYYYMMDD
  accessionNumber: string;
  studyUid: string;
  seriesUid: string;
  sopUid: string;
}

/** 検査 UID などは、呼び出しのたびに別の値にする（同じ UID のまま作り直すと、古いメタデータが残る）。 */
export function tinyDicomIds(seed: number): Pick<TinyDicom, "studyUid" | "seriesUid" | "sopUid"> {
  const root = "1.2.826.0.1.3680043.8.498.77";
  return { studyUid: `${root}.${seed}.1`, seriesUid: `${root}.${seed}.2`, sopUid: `${root}.${seed}.3` };
}

export function writeTinyDicom(file: string, d: TinyDicom): void {
  const SC = "1.2.840.10008.5.1.4.1.1.7"; // Secondary Capture
  const TS = "1.2.840.10008.1.2.1";
  const meta = Buffer.concat([
    element(0x0002, 0x0001, "OB", Buffer.from([0, 1])),
    str(0x0002, 0x0002, "UI", SC),
    str(0x0002, 0x0003, "UI", d.sopUid),
    str(0x0002, 0x0010, "UI", TS),
    str(0x0002, 0x0012, "UI", "1.2.826.0.1.3680043.8.498.1"),
  ]);
  const metaGroup = Buffer.concat([element(0x0002, 0x0000, "UL", le32(meta.length)), meta]);
  const body = Buffer.concat([
    str(0x0008, 0x0016, "UI", SC),
    str(0x0008, 0x0018, "UI", d.sopUid),
    str(0x0008, 0x0020, "DA", d.studyDate),
    str(0x0008, 0x0030, "TM", "120000"),
    str(0x0008, 0x0050, "SH", d.accessionNumber),
    str(0x0008, 0x0060, "CS", "OT"),
    str(0x0010, 0x0010, "PN", d.patientName),
    str(0x0010, 0x0020, "LO", d.patientId),
    str(0x0020, 0x000d, "UI", d.studyUid),
    str(0x0020, 0x000e, "UI", d.seriesUid),
    str(0x0020, 0x0010, "SH", "1"),
    str(0x0020, 0x0011, "IS", "1"),
    str(0x0020, 0x0013, "IS", "1"),
    element(0x0028, 0x0002, "US", le16(1)),
    str(0x0028, 0x0004, "CS", "MONOCHROME2"),
    element(0x0028, 0x0010, "US", le16(2)),
    element(0x0028, 0x0011, "US", le16(2)),
    element(0x0028, 0x0100, "US", le16(16)),
    element(0x0028, 0x0101, "US", le16(16)),
    element(0x0028, 0x0102, "US", le16(15)),
    element(0x0028, 0x0103, "US", le16(0)),
    element(0x7fe0, 0x0010, "OW", Buffer.concat([le16(10), le16(20), le16(30), le16(40)])),
  ]);
  fs.writeFileSync(file, Buffer.concat([Buffer.alloc(128), Buffer.from("DICM", "ascii"), metaGroup, body]));
}
