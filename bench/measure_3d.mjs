#!/usr/bin/env node
// GRAPHY-Next Benchmark Phantom (GNBP-1)
// Copyright (C) 2026 Visionary Imaging Services, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
/**
 * GRAPHY-Next 3D performance measurement (GNBP-1B).
 *
 * The 2D measurement deliberately does not answer the memory question: a stack
 * viewport streams slices on demand, so its peak heap reflects a cache, not the
 * study (31.9 MiB for a 512-slice series whose pixels alone are 256 MB). The 3D
 * viewer builds the whole volume, so this is where volume-size scaling actually
 * shows up — and where a "peak memory" figure means what a reader will assume
 * it means.
 *
 * Metrics:
 *   - time from opening the 3D viewer to the first rendered volume
 *   - sustained frame rate while the volume is rotated
 *   - peak JS heap over the run
 *
 * Usage:
 *   node measure_3d.mjs --discover --series GNBP-1B_256
 *   node measure_3d.mjs --series GNBP-1B_256 --slices 256 --runs 5 --out results/perf3d_256.json
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import os_mod from "node:os";
import { chromePids, rssBytes } from "./proc_rss.mjs";

const args = {
  url: "http://localhost:8099",
  series: "GNBP-1B_256",
  runs: 5,
  out: null,
  discover: false,
  headed: true,
  rotateSeconds: 5,
  timeoutMs: 300_000,
};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  const next = () => process.argv[++i];
  if (a === "--url") args.url = next();
  else if (a === "--series") args.series = next();
  else if (a === "--runs") args.runs = Number(next());
  else if (a === "--out") args.out = next();
  else if (a === "--discover") args.discover = true;
  else if (a === "--headless") args.headed = false;
  else if (a === "--rotate-seconds") args.rotateSeconds = Number(next());
  else if (a === "--timeout-ms") args.timeoutMs = Number(next());
  else throw new Error(`unknown argument: ${a}`);
}

const INIT_SCRIPT = fs.readFileSync(new URL("./init_script.js", import.meta.url), "utf8");

function readBuildInfo() {
  try {
    return JSON.parse(fs.readFileSync("./results/build_info.json", "utf8"));
  } catch {
    return null;
  }
}

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function describeEnvironment() {
  const cpus = os.cpus();
  return {
    os: `${os.type()} ${os.release()}`,
    distro: sh(". /etc/os-release && echo $PRETTY_NAME"),
    kernel: sh("uname -r"),
    cpu_model: cpus.length ? cpus[0].model.trim() : null,
    cpu_logical_cores: cpus.length,
    total_memory_bytes: os.totalmem(),
    free_memory_bytes_at_start: os.freemem(),
    load_average_at_start: os.loadavg(),
    gpu: (sh("lspci | grep -iE 'vga|3d controller|display'") || "").split("\n").filter(Boolean),
    displays: (sh("xrandr --current | grep -E ' connected|\\*'") || "").split("\n").filter(Boolean),
    node: process.version,
  };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const summarise = (xs) => {
  const c = xs.filter((x) => Number.isFinite(x));
  return c.length ? { n: c.length, median: median(c), min: Math.min(...c), max: Math.max(...c), values: c } : null;
};

async function jsHeapUsed(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((x) => [x.name, x.value])).JSHeapUsedSize ?? null;
}

async function withHeapSampling(cdps, fn, intervalMs = 250) {
  let peak = 0;
  let peakRss = 0;
  const baselineRss = rssBytes(ourPids);
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      for (const cdp of cdps) {
        try {
          const used = await jsHeapUsed(cdp);
          if (used && used > peak) peak = used;
        } catch { /* page may be navigating or closed */ }
      }
      // Renderer processes come and go, so re-resolve rather than caching.
      const rss = rssBytes(chromePids().filter((p) => !pidsBefore.has(p)));
      if (rss > peakRss) peakRss = rss;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();
  try {
    return {
      result: await fn(),
      peakJsHeapBytes: peak,
      baselineRssBytes: baselineRss,
      peakRssBytes: peakRss,
      rssDeltaBytes: peakRss - baselineRss,
    };
  } finally {
    stop = true;
    await loop;
  }
}

const pidsBefore = new Set(chromePids());
const browser = await chromium.launch({ headless: !args.headed });
await new Promise((r) => setTimeout(r, 1500));
// Processes that appeared when we launched: the browser and its renderers.
const ourPids = chromePids().filter((p) => !pidsBefore.has(p));

async function newRun() {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(INIT_SCRIPT);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.goto(args.url, { waitUntil: "domcontentloaded" });
  return { context, page, cdp, dispose: () => context.close() };
}

async function selectSeries(page) {
  await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  const d = page.locator('input[type="date"]');
  if ((await d.count()) >= 2) {
    await d.nth(0).fill("2000-01-01");
    await d.nth(1).fill("2099-12-31");
  }
  await page.getByTestId("search-submit-button").click();

  const studies = page.locator('[data-testid^="study-row-"]');
  await studies.first().waitFor({ state: "visible", timeout: 60_000 });
  const n = await studies.count();
  let hit = false;
  for (let i = 0; i < n; i++) {
    if (((await studies.nth(i).textContent()) ?? "").includes(args.series)) {
      await studies.nth(i).click();
      hit = true;
      break;
    }
  }
  if (!hit) throw new Error(`study ${args.series} not found`);

  const rows = page.locator('[data-testid^="series-row-"]');
  await rows.first().waitFor({ state: "visible", timeout: 60_000 });
  await rows.first().click();
  await page.getByTestId("viewer2d-canvas-host").first().waitFor({ state: "visible", timeout: 60_000 });
}

/** Main screen → Image menu → "3D Viewer". The item carries no testid, so it is
 *  matched on its label within the menu's dropdown. */
async function open3d(page, context) {
  const btn = page.getByTestId("mainscreen-menu-image");
  await btn.click();
  await page.waitForTimeout(300);
  const dropdown = btn.locator("xpath=following-sibling::div").first();
  const items = dropdown.locator("button");
  const count = await items.count();
  let target = null;
  for (let i = 0; i < count; i++) {
    const text = ((await items.nth(i).textContent()) ?? "").trim();
    if (/^3D Viewer/.test(text)) { target = items.nth(i); break; }
  }
  if (!target) throw new Error("3D Viewer entry not found in the Image menu");

  const t0 = Date.now();
  const before = context.pages().length;
  await target.click();

  for (let i = 0; i < 120; i++) {
    const opened = context.pages().find((p) => p !== page && /3dviewer|3d/i.test(p.url()));
    if (opened) {
      await opened.waitForLoadState("domcontentloaded");
      return { page: opened, openedAt: t0 };
    }
    if (/3dviewer/i.test(page.url())) return { page, openedAt: t0 };
    await page.waitForTimeout(500);
  }
  void before;
  throw new Error("the 3D viewer did not open");
}

/**
 * Wait until the volume is actually on screen.
 *
 * The pixels are read through the compositor (a screenshot), not from inside
 * the page. The 3D viewport is a VTK.js WebGL canvas created without
 * preserveDrawingBuffer, so drawImage()/getImageData() on it return an empty
 * buffer — an in-page probe reports a fully rendered volume as black, which is
 * exactly what happened on the first attempt here. Forcing
 * preserveDrawingBuffer would fix the read but slow the renderer, perturbing
 * the frame rate this harness exists to measure.
 */
async function waitForVolume(page, timeoutMs, threshold = 0.01) {
  const canvas = page.locator("canvas").first();
  const shot = path.join(os_mod.tmpdir(), `gnbp-3d-${process.pid}.png`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await canvas.screenshot({ path: shot });
      const [frac] = execSync(`python3 canvas_stats.py ${shot}`, { encoding: "utf8" })
        .trim().split(/\s+/).map(Number);
      if (frac > threshold) return frac;
    } catch { /* canvas may not be laid out yet */ }
    await page.waitForTimeout(200);
  }
  throw new Error("the volume did not appear within the timeout");
}

async function measureRotation(page, cdp, seconds) {
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no 3D canvas");
  const cx = Math.round(box.x + box.width / 2);
  const cy = Math.round(box.y + box.height / 2);
  const r = Math.round(Math.min(box.width, box.height) * 0.25);

  await page.evaluate(() => window.__bench.resetRaf());
  await page.mouse.move(cx, cy);
  await page.mouse.down();

  const t0 = Date.now();
  const deadline = t0 + seconds * 1000;
  let i = 0;
  while (Date.now() < deadline) {
    const a = (i++ / 60) * Math.PI * 2;
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(cx + r * Math.cos(a)),
      y: Math.round(cy + r * Math.sin(a)),
      button: "left",
      buttons: 1,
    });
  }
  const elapsed = (Date.now() - t0) / 1000;
  await page.mouse.up();

  const frames = await page.evaluate(() => window.__bench.readRaf());
  return { seconds: elapsed, frames, fps: frames / elapsed, moveEvents: i };
}

// ---------------------------------------------------------------------------
try {
  if (args.discover) {
    const run = await newRun();
    await selectSeries(run.page);
    const { page: v } = await open3d(run.page, run.context);
    await v.waitForTimeout(8000);
    const info = await v.evaluate(() => ({
      url: location.href,
      hasBench: typeof window.__bench !== "undefined",
      pixelStats: window.__bench ? window.__bench.allCanvasStats() : null,
      buttons: Array.from(document.querySelectorAll("button")).map((b) => (b.textContent || "").trim()).filter(Boolean).slice(0, 40),
      testIds: [...new Set(Array.from(document.querySelectorAll("[data-testid]")).map((e) => e.getAttribute("data-testid")))].sort(),
      canvases: Array.from(document.querySelectorAll("canvas")).map((c) => ({ w: c.width, h: c.height })),
    }));
    console.log(JSON.stringify(info, null, 2));
    await v.screenshot({ path: "./shots/3d-discover.png" });
    await run.dispose();
  } else {
    const record = {
      phantom_series: args.series,
      viewer: "3D",
      url: args.url,
      browser: browser.version(),
      environment: describeEnvironment(),
      build_info: readBuildInfo(),
      metric_definitions: {
        time_to_first_volume_ms:
          "wall clock from activating the 3D Viewer menu item to the first frame in which its canvas has more than 1% non-black pixels",
        rotation_fps:
          "requestAnimationFrame callbacks serviced by the application per second while the pointer is dragged in a circle with the left button held; capped by the display refresh rate (~60 Hz)",
        peak_js_heap_bytes:
          "maximum JSHeapUsedSize across the shell and 3D viewer contexts, sampled every 250 ms. NOT a memory figure for the application: V8 excludes external memory such as large ArrayBuffers, and it reported 26 MB while a 128 MB volume was loaded",
        peak_rss_bytes:
          "maximum summed proportional set size (PSS) of the browser process tree, sampled every 250 ms. PSS rather than RSS: summing RSS across the browser, GPU and renderer processes double-counts shared pages and inflated a 128 MB volume to 1.6 GB on a first attempt",
        rss_delta_bytes:
          "peak_rss_bytes minus the resident set size measured before the run started, i.e. the additional memory attributable to loading and rendering this volume",
        rotation_fps_caveat:
          "the rotation frame rate is bounded by how fast the harness can deliver pointer events through CDP (about 26/s); frames tracked events one-for-one, so this is a lower bound showing the viewer kept up, not a maximum",
      },
      runs: [],
    };

    for (let run = 0; run < args.runs; run++) {
      process.stderr.write(`3D run ${run + 1}/${args.runs} ...\n`);
      const r = await newRun();
      const sampled = await withHeapSampling([r.cdp], async () => {
        await selectSeries(r.page);
        const { page: v, openedAt } = await open3d(r.page, r.context);
        const vcdp = v === r.page ? r.cdp : await v.context().newCDPSession(v);
        if (v !== r.page) await vcdp.send("Performance.enable");
        await waitForVolume(v, args.timeoutMs);
        const firstVolumeMs = Date.now() - openedAt;
        await v.waitForTimeout(1500);
        const rotation = await measureRotation(v, vcdp, args.rotateSeconds);
        const viewerHeap = await jsHeapUsed(vcdp).catch(() => null);
        return { firstVolumeMs, rotation, viewerHeap };
      });
      const { result, peakJsHeapBytes, baselineRssBytes, peakRssBytes, rssDeltaBytes } = sampled;

      record.runs.push({
        run: run + 1,
        time_to_first_volume_ms: result.firstVolumeMs,
        rotation: result.rotation,
        viewer_js_heap_bytes: result.viewerHeap,
        peak_js_heap_bytes: peakJsHeapBytes,
        baseline_rss_bytes: baselineRssBytes,
        peak_rss_bytes: peakRssBytes,
        rss_delta_bytes: rssDeltaBytes,
      });
      await r.dispose();
    }

    record.summary = {
      time_to_first_volume_ms: summarise(record.runs.map((r) => r.time_to_first_volume_ms)),
      rotation_fps: summarise(record.runs.map((r) => r.rotation.fps)),
      peak_js_heap_bytes: summarise(record.runs.map((r) => r.peak_js_heap_bytes)),
      viewer_js_heap_bytes: summarise(record.runs.map((r) => r.viewer_js_heap_bytes)),
      peak_rss_bytes: summarise(record.runs.map((r) => r.peak_rss_bytes)),
      rss_delta_bytes: summarise(record.runs.map((r) => r.rss_delta_bytes)),
    };

    const json = JSON.stringify(record, null, 2);
    if (args.out) {
      fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
      fs.writeFileSync(args.out, json);
      process.stderr.write(`wrote ${args.out}\n`);
    }
    console.log(json);
  }
} finally {
  await browser.close();
}
