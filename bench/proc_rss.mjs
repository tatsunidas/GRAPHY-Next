// GRAPHY-Next Benchmark Phantom (GNBP-1)
// Copyright (C) 2026 Visionary Imaging Services, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
/**
 * Resident set size of the browser's process tree.
 *
 * CDP's JSHeapUsedSize is not a memory figure for this application: it excludes
 * external memory such as large ArrayBuffers and GPU-bound textures, and it
 * reported 26 MB for a viewer holding a 128 MB volume. A memory figure for this
 * application has to measure the process, not the JS heap.
 */
import { execSync } from "node:child_process";

const chromeCmd = "pgrep -f 'chrome|chromium' 2>/dev/null || true";

export function chromePids() {
  const out = execSync(chromeCmd, { encoding: "utf8", shell: "/bin/bash" }).trim();
  return out ? out.split("\n").map(Number).filter(Boolean) : [];
}

/**
 * Total proportional set size in bytes for the given pids.
 *
 * PSS, not RSS: a browser spreads one page across a browser process, a GPU
 * process and several renderers, and summing RSS counts every shared page once
 * per process. On a first attempt that inflated the figure for a 128 MB volume
 * to 1.6 GB. PSS divides each shared page by the number of processes mapping
 * it, so the sum is the memory the machine actually has to provide.
 */
export function rssBytes(pids) {
  let total = 0;
  for (const pid of pids) {
    try {
      const line = execSync(
        `awk '/^Pss:/{s+=$2} END{print s}' /proc/${pid}/smaps_rollup 2>/dev/null || true`,
        { encoding: "utf8", shell: "/bin/bash" },
      ).trim();
      if (line) total += Number(line) * 1024;
    } catch { /* process exited */ }
  }
  return total;
}
