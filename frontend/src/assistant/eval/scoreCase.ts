/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 回帰評価の採点（純関数）。モデルが呼んだ操作の列を、期待と比べる。文章は見ない。
import { GET_MEASUREMENTS_TOOL, GET_STATE_TOOL } from "../actions/registry";
import type { EvalCase, EvalOp } from "./cases";

export interface GotCall {
  name: string;
  args: Record<string, unknown>;
}

export interface CaseScore {
  pass: boolean;
  /** 実際に呼ばれた操作の名前（読み取りを除く、呼ばれた順）。 */
  got: string[];
  reason?: string;
}

const isRead = (name: string) => name === GET_STATE_TOOL || name === GET_MEASUREMENTS_TOOL;

function argMatches(want: number | string | string[], got: unknown): boolean {
  if (typeof want === "number") return typeof got === "number" && got === want;
  const needles = (Array.isArray(want) ? want : [want]).map((s) => s.toLowerCase());
  return typeof got === "string" && needles.some((n) => got.toLowerCase().includes(n));
}

function opMismatch(want: EvalOp, got: GotCall): string | null {
  if (want.id !== got.name) return `expected ${want.id}, got ${got.name}`;
  for (const [k, v] of Object.entries(want.args ?? {})) {
    if (!argMatches(v, got.args[k])) return `${want.id}.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got.args[k])}`;
  }
  for (const [k, [lo, hi]] of Object.entries(want.ranges ?? {})) {
    const g = got.args[k];
    if (typeof g !== "number" || !(g >= lo && g <= hi)) return `${want.id}.${k}: expected [${lo.toFixed(2)}, ${hi.toFixed(2)}], got ${JSON.stringify(g)}`;
  }
  return null;
}

/** `rotate90` の `times` は省略または 1 を「1 回」とみなす（既定が 1 のため）。 */
function normalize(c: GotCall): GotCall {
  if (c.name === "rotate90" && c.args.times === undefined) return { ...c, args: { ...c.args, times: 1 } };
  return c;
}

export function scoreCase(c: EvalCase, calls: GotCall[]): CaseScore {
  const ops = calls.filter((x) => !isRead(x.name)).map(normalize);
  const got = ops.map((o) => o.name);
  for (const r of c.expect.reads ?? []) {
    if (!calls.some((x) => x.name === r)) return { pass: false, got, reason: `missing read ${r}` };
  }
  if (ops.length !== c.expect.ops.length) {
    return { pass: false, got, reason: c.expect.ops.length === 0 ? `unexpected ${got.join(",")}` : `expected ${c.expect.ops.map((o) => o.id).join(",")}, got ${got.join(",") || "none"}` };
  }
  for (let i = 0; i < ops.length; i++) {
    const want = c.expect.ops[i];
    const m = opMismatch(want.id === "rotate90" && !want.args ? { ...want, args: { times: 1 } } : want, ops[i]);
    if (m) return { pass: false, got, reason: m };
  }
  return { pass: true, got };
}
