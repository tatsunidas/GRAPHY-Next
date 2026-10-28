/**
 * ブラウザ検査用の最小の DICOMweb サーバ（QIDO-RS／WADO-RS）。
 *
 * `webSynthCt.py` が書いたディレクトリ（Part-10 と `dicomweb-index.json`）をそのまま配信する。
 * 実 PACS を使わずに、web プロファイルの BFF（WebDicomDataService）を動かすためのもの。127.0.0.1 だけを待ち受ける。
 * 受けた要求を種別ごとに数える（シリーズ一括の取得が 1 回で済み、インスタンス単位が 0 回であることの検査に使う）。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";

type Json = Record<string, { vr: string; Value?: unknown[] }>;
interface Entry { file: string; sop: string; json: Json }

export interface StubCounts {
  qido: number;
  /** WADO-RS シリーズ一括（prefetch）。 */
  seriesBulk: number;
  /** WADO-RS インスタンス単位。 */
  instance: number;
  metadata: number;
  other: number;
}

const val = (j: Json, tag: string): string => String(j[tag]?.Value?.[0] ?? "");

export class StubDicomWeb {
  readonly counts: StubCounts = { qido: 0, seriesBulk: 0, instance: 0, metadata: 0, other: 0 };
  /** true の間、シリーズ一括の取得だけ 500 を返す（prefetch が使えない PACS の再現。BFF は個別取得へ戻る）。 */
  failSeriesBulk = false;
  private server: http.Server | null = null;
  private entries: Entry[];
  private bytes = new Map<string, Buffer>();

  constructor(private readonly dir: string) {
    this.entries = JSON.parse(fs.readFileSync(path.join(dir, "dicomweb-index.json"), "utf8")) as Entry[];
  }

  get studyUid(): string { return val(this.entries[0].json, "0020000D"); }
  get seriesUid(): string { return val(this.entries[0].json, "0020000E"); }
  get instanceCount(): number { return this.entries.length; }

  resetCounts(): void {
    Object.assign(this.counts, { qido: 0, seriesBulk: 0, instance: 0, metadata: 0, other: 0 });
  }

  async start(): Promise<number> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((resolve) => { s.close(() => resolve()); s.closeAllConnections(); });
  }

  private file(e: Entry): Buffer {
    let b = this.bytes.get(e.sop);
    if (!b) { b = fs.readFileSync(path.join(this.dir, e.file)); this.bytes.set(e.sop, b); }
    return b;
  }

  private studyJson(): Json {
    const j = this.entries[0].json;
    const pick = ["00080020", "00080050", "00080090", "00081030", "00100010", "00100020", "00100030", "00100040", "0020000D", "00200010"];
    const out: Json = {};
    for (const t of pick) if (j[t]) out[t] = j[t];
    out["00080061"] = { vr: "CS", Value: [val(j, "00080060")] };
    out["00201206"] = { vr: "IS", Value: [1] };
    out["00201208"] = { vr: "IS", Value: [this.entries.length] };
    return out;
  }

  private seriesJson(): Json {
    const j = this.entries[0].json;
    const pick = ["00080060", "0008103E", "0020000D", "0020000E", "00200011"];
    const out: Json = {};
    for (const t of pick) if (j[t]) out[t] = j[t];
    out["00201209"] = { vr: "IS", Value: [this.entries.length] };
    return out;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://stub");
    const parts = url.pathname.split("/").filter(Boolean);
    const sendJson = (body: unknown): void => {
      res.writeHead(200, { "content-type": "application/dicom+json" });
      res.end(JSON.stringify(body));
    };
    const notFound = (): void => { this.counts.other++; res.writeHead(404).end(); };

    if (req.method !== "GET" || parts[0] !== "studies") return notFound();
    // /studies
    if (parts.length === 1) { this.counts.qido++; return sendJson([this.studyJson()]); }
    if (parts[1] !== this.studyUid) { res.writeHead(204).end(); return; }
    // /studies/{s}/series, /studies/{s}/instances
    if (parts.length === 3 && parts[2] === "series") { this.counts.qido++; return sendJson([this.seriesJson()]); }
    if (parts.length === 3 && parts[2] === "instances") { this.counts.qido++; return sendJson(this.entries.map((e) => e.json)); }
    if (parts[2] !== "series" || parts[3] !== this.seriesUid) return notFound();
    // /studies/{s}/series/{se}
    if (parts.length === 4) {
      this.counts.seriesBulk++;
      if (this.failSeriesBulk) { res.writeHead(500).end(); return; }
      const boundary = "stubBoundary" + Date.now();
      const chunks: Buffer[] = [];
      for (const e of this.entries) {
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`), this.file(e), Buffer.from("\r\n"));
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`));
      res.writeHead(200, { "content-type": `multipart/related; type="application/dicom"; boundary=${boundary}` });
      res.end(Buffer.concat(chunks));
      return;
    }
    if (parts.length === 5 && parts[4] === "metadata") { this.counts.metadata++; return sendJson(this.entries.map((e) => e.json)); }
    if (parts.length === 5 && parts[4] === "instances") { this.counts.qido++; return sendJson(this.entries.map((e) => e.json)); }
    // /studies/{s}/series/{se}/instances/{sop}
    if (parts.length === 6 && parts[4] === "instances") {
      const e = this.entries.find((x) => x.sop === parts[5]);
      if (!e) return notFound();
      this.counts.instance++;
      const boundary = "stubBoundary" + Date.now();
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`), this.file(e), Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      res.writeHead(200, { "content-type": `multipart/related; type="application/dicom"; boundary=${boundary}` });
      res.end(body);
      return;
    }
    return notFound();
  }
}
