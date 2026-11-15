/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { FindProfile, QrProbeResult } from "../api";

/**
 * 通信テストの結果を、利用者向けの平易な文言（i18n キー＋置換値）にする純関数。
 * 画面（QrProbePanel）と Q/R のエラー表示が共有する。DICOM の用語（status・Presentation Context など）は
 * 「詳しく見る」の側に寄せ、ここでは「何が起きていて、次に何をするか」を言う。
 */
export interface Msg {
  key: string;
  vars?: Record<string, string | number>;
}

export type Tone = "ok" | "warn" | "ng" | "muted" | "running";

export interface RowView {
  id: "echo" | "find" | "get" | "move";
  tone: Tone;
  icon: string;
  title: Msg;
  /** 起きていること。 */
  what: Msg | null;
  /** 次にすること（✕・△のとき）。 */
  next: Msg | null;
}

const ICON: Record<Tone, string> = { ok: "✓", warn: "△", ng: "✕", muted: "–", running: "…" };

const hex = (n: number | null | undefined) => (n == null ? "" : n.toString(16).toUpperCase().padStart(4, "0") + "H");

/** 検索のパターンの好ましい順（標準で通れば設定の変更は要らない）。 */
const FIND_PREFERENCE = [
  "find-standard", "find-implicit", "find-basic", "find-utf8", "find-minimal",
  "find-patientroot-study", "find-patientroot",
];

export function findResults(results: QrProbeResult[]): QrProbeResult[] {
  return results.filter((r) => r.stage === "find");
}

/** 採用できる最良の組み合わせ（通った中で、好ましい順）。無ければ null。 */
export function bestFind(results: QrProbeResult[]): QrProbeResult | null {
  const passed = findResults(results).filter((r) => r.verdict === "ok" && r.adopt);
  for (const id of FIND_PREFERENCE) {
    const hit = passed.find((r) => r.id === id);
    if (hit) return hit;
  }
  return passed[0] ?? null;
}

/** 4 行（疎通・検索・GET・MOVE）の表示内容。results は実行済みの段だけでよい。running は実行中の stage。 */
export function rowViews(results: QrProbeResult[], running: string | null): RowView[] {
  const by = (stage: string) => results.filter((r) => r.stage === stage);
  const echo = by("echo")[0];
  const echoOk = echo?.verdict === "ok";
  const blocked = echo != null && !echoOk;

  const mk = (id: RowView["id"], tone: Tone, what: Msg | null, next: Msg | null): RowView => ({
    id, tone, icon: ICON[tone], title: { key: `qrProbe.row.${id}` }, what, next,
  });
  const pending = (id: RowView["id"]) =>
    running === id ? mk(id, "running", { key: "qrProbe.running" }, null) : mk(id, "muted", { key: "qrProbe.notYet" }, null);
  const notTried = (id: RowView["id"]) => mk(id, "muted", { key: "qrProbe.blocked" }, null);

  const rows: RowView[] = [];

  // ① 疎通
  if (!echo) rows.push(pending("echo"));
  else if (echoOk) rows.push(mk("echo", "ok", { key: "qrProbe.echo.ok", vars: { ms: echo.millis } }, null));
  else rows.push(mk("echo", "ng", echoWhat(echo), echoNext(echo)));

  // ② 検索
  const finds = findResults(results);
  if (blocked) rows.push(notTried("find"));
  else if (finds.length === 0) rows.push(pending("find"));
  else if (running === "find") rows.push(mk("find", "running", { key: "qrProbe.running" }, null));
  else {
    const best = bestFind(results);
    if (best) {
      const standard = best.id === "find-standard";
      rows.push(mk("find", "ok",
        standard ? { key: "qrProbe.find.ok.standard" } : { key: "qrProbe.find.ok.other", vars: { label: best.label } },
        standard ? null : { key: "qrProbe.find.adoptHint" }));
    } else {
      const basis = finds.find((r) => r.id === "find-minimal" && r.verdict !== "skipped")
        ?? finds.find((r) => r.verdict === "ng") ?? finds[0];
      rows.push(mk("find", "ng", findWhat(basis), findNext(basis)));
    }
  }

  // ③ GET ④ MOVE
  for (const id of ["get", "move"] as const) {
    const r = by(id)[0];
    if (blocked) rows.push(notTried(id));
    else if (!r) rows.push(pending(id));
    else if (r.verdict === "ok") rows.push(mk(id, "ok", { key: `qrProbe.${id}.ok` }, null));
    else if (r.verdict === "warn") rows.push(mk(id, "warn", retrieveWarn(id, r), retrieveWarnNext(id, r)));
    else rows.push(mk(id, "ng", retrieveNg(id, r), retrieveNgNext(id, r)));
  }
  return rows;
}

function echoWhat(r: QrProbeResult): Msg {
  switch (r.kind) {
    case "UNREACHABLE": return { key: "qrProbe.echo.UNREACHABLE" };
    case "ASSOCIATION_REJECTED": return { key: "qrProbe.echo.ASSOCIATION_REJECTED", vars: { reason: r.reason ?? "" } };
    case "TIMEOUT": return { key: "qrProbe.echo.TIMEOUT" };
    default: return { key: "qrProbe.echo.UNKNOWN" };
  }
}

function echoNext(r: QrProbeResult): Msg {
  switch (r.kind) {
    case "UNREACHABLE":
    case "TIMEOUT": return { key: "qrProbe.echo.UNREACHABLE.next" };
    case "ASSOCIATION_REJECTED":
      if ((r.reason ?? "").includes("called-AE")) return { key: "qrProbe.echo.rj.called" };
      if ((r.reason ?? "").includes("calling-AE")) return { key: "qrProbe.echo.rj.calling" };
      return { key: "qrProbe.echo.rj.other" };
    default: return { key: "qrProbe.seeDetail" };
  }
}

function findWhat(r: QrProbeResult): Msg {
  switch (r.kind) {
    case "SERVICE_REFUSED": return { key: "qrProbe.find.SERVICE_REFUSED" };
    case "DROPPED": return { key: "qrProbe.find.DROPPED" };
    case "STATUS_ERROR":
      return { key: "qrProbe.find.STATUS_ERROR", vars: { status: hex(r.status), comment: r.errorComment ? ` ${r.errorComment}` : "" } };
    case "ASSOCIATION_REJECTED": return { key: "qrProbe.find.ASSOCIATION_REJECTED", vars: { reason: r.reason ?? "" } };
    case "TIMEOUT": return { key: "qrProbe.find.TIMEOUT" };
    default: return { key: "qrProbe.find.UNKNOWN" };
  }
}

function findNext(r: QrProbeResult): Msg {
  switch (r.kind) {
    case "SERVICE_REFUSED": return { key: "qrProbe.find.SERVICE_REFUSED.next" };
    case "DROPPED": return { key: "qrProbe.find.DROPPED.next" };
    default: return { key: "qrProbe.seeDetail" };
  }
}

function retrieveWarn(id: "get" | "move", r: QrProbeResult): Msg {
  if (id === "move" && r.status === 0xa801) return { key: "qrProbe.move.a801" };
  return { key: `qrProbe.${id}.warn`, vars: { status: hex(r.status) } };
}

function retrieveWarnNext(id: "get" | "move", r: QrProbeResult): Msg {
  if (id === "move" && r.status === 0xa801) return { key: "qrProbe.move.a801.next" };
  return { key: "qrProbe.retrieve.warn.next" };
}

function retrieveNg(id: "get" | "move", r: QrProbeResult): Msg {
  if (r.kind === "SERVICE_REFUSED") return { key: `qrProbe.${id}.refused` };
  if (r.kind === "DROPPED") return { key: "qrProbe.retrieve.DROPPED" };
  return { key: "qrProbe.retrieve.UNKNOWN" };
}

function retrieveNgNext(id: "get" | "move", r: QrProbeResult): Msg {
  if (r.kind === "SERVICE_REFUSED") return { key: `qrProbe.${id}.refused.next` };
  return { key: "qrProbe.seeDetail" };
}

/** 画面の冒頭に出す結論（1 文）。実行が終わったときだけ使う。 */
export function conclusion(results: QrProbeResult[]): Msg[] {
  const echo = results.find((r) => r.stage === "echo");
  if (!echo || echo.verdict !== "ok") return [{ key: "qrProbe.sum.noConnect" }];
  const out: Msg[] = [];
  const best = bestFind(results);
  out.push(best ? { key: "qrProbe.sum.findOk" } : { key: "qrProbe.sum.findNg" });
  const can = (id: string) => {
    const r = results.find((x) => x.stage === id);
    return r != null && (r.verdict === "ok" || r.verdict === "warn");
  };
  const g = can("get");
  const m = can("move");
  out.push({ key: g && m ? "qrProbe.sum.retrieve.both" : g ? "qrProbe.sum.retrieve.get" : m ? "qrProbe.sum.retrieve.move" : "qrProbe.sum.retrieve.none" });
  return out;
}

/** 検索の方式が標準（何も指定していない）か。 */
export function isDefaultProfile(p: FindProfile | null | undefined): boolean {
  if (!p) return true;
  return Object.values(p).every((v) => v == null || (Array.isArray(v) && v.length === 0));
}

/** 「報告用にコピー」のテキスト。患者の値は含まない（件数・項目名・status だけ）。 */
export function reportText(target: { aeTitle: string; host: string; port: number }, results: QrProbeResult[]): string {
  const lines = [`GRAPHY-Next 通信テスト: ${target.aeTitle}@${target.host}:${target.port}`];
  for (const r of results) {
    const head = `[${r.verdict}] ${r.id}${r.kind ? ` ${r.kind}` : ""}${r.status != null ? ` status=${hex(r.status)}` : ""}`;
    const extra = [
      r.errorComment ? `comment=${r.errorComment}` : "",
      r.reason ? `reason=${r.reason}` : "",
      r.count != null ? `count=${r.count}` : "",
      r.returnedKeys.length ? `returned=${r.returnedKeys.join(",")}` : "",
    ].filter(Boolean).join(" ");
    lines.push(`${head}${extra ? ` ${extra}` : ""} (${r.millis} ms)`);
    if (r.command) lines.push(`  cmd: ${r.command}`);
    if (r.evidence) lines.push(...r.evidence.split("\n").map((l) => `  | ${l}`));
  }
  return lines.join("\n");
}

/** Q/R 画面の検索エラー（HttpError.detail の本文）を、利用者向けの文言にする。分類が無ければ null。 */
export function qrErrorMsg(detail: Record<string, unknown> | null | undefined): Msg | null {
  if (!detail || detail.error !== "qr-find-failed") return null;
  const kind = String(detail.kind ?? "UNKNOWN");
  switch (kind) {
    case "SERVICE_REFUSED":
    case "DROPPED":
    case "TIMEOUT":
    case "UNREACHABLE":
      return { key: `qrProbe.err.${kind}` };
    case "STATUS_ERROR":
      return {
        key: "qrProbe.err.STATUS_ERROR",
        vars: { status: String(detail.status ?? ""), comment: detail.errorComment ? ` ${String(detail.errorComment)}` : "" },
      };
    case "ASSOCIATION_REJECTED":
      return { key: "qrProbe.err.ASSOCIATION_REJECTED", vars: { reason: String(detail.reason ?? "") } };
    default:
      return null;
  }
}
