/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 環境設定 ＞ 計算機 ＞ この PC の表示ロジック。判定は main（`desktop/localPython.js`）にあり、
 * ここは検出結果を「文言のキー＋値」の行に写すだけ（画面と試験の両方がこれを使う）。
 */
import type { LocalCandidate, LocalCapabilities, LocalDetectResult } from "../desktopBridge";

export interface Msg {
  key: string;
  params?: Record<string, string>;
}
export type Tone = "ok" | "warn" | "error" | "off";

export interface GpuRow {
  name: string;
  /** nvidia-smi の値（例「4096 MiB（4.0 GB）」）。nvidia-smi が無ければ null。 */
  vram: string | null;
  verdict: Msg;
  tone: Tone;
}

export interface CandidateRow {
  path: string;
  source: Msg;
  status: Msg;
  tone: Tone;
  /** 版（Python x / jupyter_server y …）。起動していない候補は null。 */
  versions: string | null;
  reasons: Msg[];
  selected: boolean;
}

export interface LocalView {
  headline: Msg & { tone: Tone };
  python: { path: string; versions: string; kind: Msg | null } | null;
  gpus: GpuRow[];
  gpuNote: Msg | null;
  notes: Msg[];
  candidates: CandidateRow[];
  searched: string[];
  missing: string[];
  commands: { shell: string; text: string }[];
  links: string[];
}

/** MiB を、nvidia-smi の値がそのまま読める形に（数値は変えない）。 */
export function formatVram(mib: number | null | undefined): string | null {
  if (mib == null || !Number.isFinite(mib)) return null;
  return `${mib} MiB（${(mib / 1024).toFixed(1)} GB）`;
}

const cap = (c: number[] | null): string => (c && c.length >= 2 ? `${c[0]}.${c[1]}` : "?");

function versionLine(c: LocalCandidate): string | null {
  const v = c.versions;
  if (!v) return null;
  const parts = [`Python ${v.python ?? "?"}`];
  parts.push(v.jupyterServer ? `jupyter_server ${v.jupyterServer}` : "jupyter_server -");
  parts.push(v.ipykernel ? `ipykernel ${v.ipykernel}` : "ipykernel -");
  parts.push(v.torch ? `PyTorch ${v.torch}${v.cuda ? ` (CUDA ${v.cuda})` : " (CPU)"}` : "PyTorch -");
  return parts.join(" / ");
}

function candidateStatus(c: LocalCandidate): { msg: Msg; tone: Tone } {
  switch (c.status) {
    case "selected":
      return { msg: { key: "settings.compute.local.cand.selected" }, tone: "ok" };
    case "usable":
      return { msg: { key: "settings.compute.local.cand.usable" }, tone: "off" };
    case "missing":
      return { msg: { key: "settings.compute.local.cand.missing" }, tone: "warn" };
    case "probe-failed":
      return { msg: { key: "settings.compute.local.cand.probeFailed", params: { detail: c.detail ?? "" } }, tone: "error" };
    default:
      return { msg: { key: "settings.compute.local.cand.excluded" }, tone: "off" };
  }
}

/** 候補ごとの理由（足りない名前・除外の理由）。 */
function candidateReasons(c: LocalCandidate): Msg[] {
  const out: Msg[] = [];
  for (const r of c.reasons) {
    if (r === "missing-jupyter-server") out.push({ key: "settings.compute.local.reason.missing-jupyter-server" });
    else if (r === "missing-ipykernel") out.push({ key: "settings.compute.local.reason.missing-ipykernel" });
    else if (r.startsWith("excluded-") || r === "setting-not-found") out.push({ key: `settings.compute.local.reason.${r}` });
  }
  return out;
}

function gpuVerdict(d: LocalCapabilities["devices"][number], caps: LocalCapabilities, reasons: string[]): { verdict: Msg; tone: Tone } {
  if (d.archSupported === false) {
    return { verdict: { key: "settings.compute.local.gpu.archUnsupported", params: { cc: cap(d.capability) } }, tone: "error" };
  }
  if (caps.accelerator === "cuda" && d.torchDevice === true) {
    return { verdict: { key: "settings.compute.local.gpu.cudaOk" }, tone: "ok" };
  }
  if (reasons.includes("torch-cpu-build")) return { verdict: { key: "settings.compute.local.gpu.cpuBuild" }, tone: "warn" };
  if (reasons.includes("driver-maybe-old")) return { verdict: { key: "settings.compute.local.gpu.driverOld" }, tone: "warn" };
  if (reasons.includes("no-torch") || reasons.includes("torch-import-failed")) {
    return { verdict: { key: "settings.compute.local.gpu.unchecked" }, tone: "warn" };
  }
  return { verdict: { key: "settings.compute.local.gpu.notUsable" }, tone: "warn" };
}

/** 検出結果 → 画面の行。`r` が null のときは呼び出し側が「確認中」を出す。 */
export function buildLocalView(r: LocalDetectResult): LocalView {
  const caps = r.capabilities;
  const sel = r.selected;
  const notes: Msg[] = [];
  const has = (c: string) => r.reasons.includes(c);

  // 状態の一行（既定の計算機は段 1 では変わらない）
  let headline: LocalView["headline"];
  if (r.state === "error") headline = { key: "settings.compute.local.headline.error", params: { error: r.error ?? "" }, tone: "error" };
  else if (r.state === "canceled") headline = { key: "settings.compute.local.headline.canceled", tone: "off" };
  else if (has("setting-not-found")) headline = { key: "settings.compute.local.headline.settingNotFound", tone: "error" };
  else if (r.state === "none" || !sel) headline = { key: "settings.compute.local.headline.noPython", tone: "error" };
  else if (!r.usable) headline = { key: "settings.compute.local.headline.packagesMissing", tone: "warn" };
  else if (caps && caps.accelerator === "cuda") headline = { key: "settings.compute.local.headline.cuda", tone: "ok" };
  else headline = { key: "settings.compute.local.headline.noGpu", tone: "warn" };

  const kind: Msg | null = sel ? (sel.conda ? { key: "settings.compute.local.kind.conda" } : sel.venv ? { key: "settings.compute.local.kind.venv" } : null) : null;
  const python = sel ? { path: sel.path, versions: versionLine(sel) ?? "", kind } : null;

  // GPU
  const gpus: GpuRow[] = [];
  let gpuNote: Msg | null = null;
  if (caps && caps.devices.length > 0) {
    for (const d of caps.devices) {
      const v = gpuVerdict(d, caps, r.reasons);
      gpus.push({ name: d.name ?? "?", vram: formatVram(d.memoryMiB), verdict: v.verdict, tone: v.tone });
    }
  } else if (r.nvidia.gpus.length > 0) {
    // Python を使えない（選べない）とき: nvidia-smi の GPU だけ出す
    for (const g of r.nvidia.gpus) {
      gpus.push({ name: g.name, vram: formatVram(g.memoryMiB), verdict: { key: "settings.compute.local.gpu.unchecked" }, tone: "warn" });
    }
  }
  if (gpus.length === 0) {
    if (caps && caps.accelerator === "mps") gpuNote = { key: "settings.compute.local.gpu.mps" };
    else if (!r.nvidia.found) gpuNote = { key: "settings.compute.local.gpu.noSmi" };
    else if (r.nvidia.error) gpuNote = { key: "settings.compute.local.gpu.smiFailed", params: { error: r.nvidia.error } };
    else gpuNote = { key: "settings.compute.local.gpu.none" };
  } else if (caps && caps.accelerator === "mps") {
    gpuNote = { key: "settings.compute.local.gpu.mps" };
  }
  if (caps && caps.driver && gpus.length > 0) {
    notes.push({ key: "settings.compute.local.gpu.versions", params: { torch: caps.torch ?? "-", cuda: caps.cudaRuntime ?? "-", driver: caps.driver } });
  }

  // 理由
  if (has("driver-maybe-old")) {
    notes.push({ key: "settings.compute.local.reason.driver-maybe-old", params: { driver: caps?.driver ?? "?", cuda: caps?.cudaRuntime ?? "?" } });
  }
  if (has("torch-cpu-build")) notes.push({ key: "settings.compute.local.reason.torch-cpu-build" });
  if (has("gpu-arch-unsupported")) {
    const bad = caps?.devices.find((d) => d.archSupported === false);
    notes.push({ key: "settings.compute.local.reason.gpu-arch-unsupported", params: { cc: cap(bad?.capability ?? null) } });
  }
  if (has("no-torch")) notes.push({ key: "settings.compute.local.reason.no-torch" });
  if (has("torch-import-failed")) notes.push({ key: "settings.compute.local.reason.torch-import-failed" });
  if (has("nvidia-smi-missing")) notes.push({ key: "settings.compute.local.reason.nvidia-smi-missing" });
  if (has("externally-managed")) notes.push({ key: "settings.compute.local.reason.externally-managed" });

  const candidates: CandidateRow[] = r.candidates.map((c) => {
    const s = candidateStatus(c);
    return {
      path: c.path,
      source: { key: `settings.compute.local.source.${c.source}` },
      status: s.msg,
      tone: s.tone,
      versions: versionLine(c),
      reasons: candidateReasons(c),
      selected: c.status === "selected",
    };
  });

  return {
    headline,
    python,
    gpus,
    gpuNote,
    notes,
    candidates,
    searched: r.searched,
    missing: r.guidance.missing,
    commands: r.guidance.commands,
    links: r.guidance.links,
  };
}
