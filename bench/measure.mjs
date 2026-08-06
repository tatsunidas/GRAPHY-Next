#!/usr/bin/env node
// GRAPHY-Next Benchmark Phantom (GNBP-1)
// Copyright (C) 2026 Visionary Imaging Services, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
/**
 * GRAPHY-Next performance measurement harness (GNBP-1 benchmark).
 *
 * Measures:
 *   2D — time from opening a study to the first rendered image
 *      — sustained frame rate during continuous stack scrolling
 *      — peak JavaScript heap
 *   3D — time from a decoded series to the first rendered volume
 *      — sustained frame rate during continuous rotation
 *      — peak JavaScript heap
 *
 * Design constraints that shaped this harness:
 *
 *  * It instruments the page itself rather than relying on the application's
 *    `window.__graphyDebug` hook, because that hook is compiled out of
 *    production builds (`import.meta.env.DEV`). Measuring a dev build would not
 *    describe what users actually run, so the harness carries its own
 *    instrumentation and targets the production build.
 *
 *  * "Frame rate" is defined as the number of requestAnimationFrame callbacks
 *    the page services per second while an interaction is being driven. The
 *    application only schedules a frame when it needs to draw, so this tracks
 *    render rate, and it is capped by the display refresh rate. The definition
 *    is stated rather than assumed, because "fps" is otherwise ambiguous.
 *
 *  * GPU memory is deliberately absent. Chrome exposes no per-page GPU memory
 *    figure through CDP, so any number reported here would be a guess. See
 *    --probe-gpu, which records that finding rather than inventing a value.
 *
 * Usage:
 *   node measure.mjs --discover --url http://localhost:8090
 *   node measure.mjs --mode web --url http://localhost:8090 --series GNBP-1B_256 --runs 5
 *   node measure.mjs --mode desktop --electron-root ../../GRAPHY-Next/desktop --series GNBP-1B_256
 */

import { chromium, _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

// Build identity, written by run_all.sh. Embedding it in every result file is
// what makes a number attributable to a specific commit and binary.
function readBuildInfo() {
  try {
    return JSON.parse(fs.readFileSync("./results/build_info.json", "utf8"));
  } catch {
    return null;
  }
}

// --- selectors (data-testid values used by the application) -----------------
const SEL = {
  searchPatientId: "search-patientid-input",
  searchSubmit: "search-submit-button",
  studyRow: '[data-testid^="study-row-"]',
  seriesRow: '[data-testid^="series-row-"]',
  canvasHost: "viewer2d-canvas-host",
  seriesViewerRoot: "series-viewer-root",
  openViewer2d: "viewer2d-toolbar-button",
  cinePlayZ: "cine-play-z",
};

const DEFAULTS = {
  runs: 5,
  scrollSeconds: 5,
  cineSeconds: 5,
  rotateSeconds: 5,
  firstImageTimeoutMs: 120_000,
  nonBlackThreshold: 0.01,
};

// ---------------------------------------------------------------------------
// Page-side instrumentation. Installed before any application script runs.
// ---------------------------------------------------------------------------
const INIT_SCRIPT = fs.readFileSync(new URL("./init_script.js", import.meta.url), "utf8");

// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    mode: "web",
    url: "http://localhost:8090",
    series: null,
    runs: DEFAULTS.runs,
    out: null,
    discover: false,
    probeGpu: false,
    headed: false,
    electronRoot: null,
    label: null,
    shots: null,
    slices: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--mode") args.mode = next();
    else if (a === "--url") args.url = next();
    else if (a === "--series") args.series = next();
    else if (a === "--runs") args.runs = Number(next());
    else if (a === "--out") args.out = next();
    else if (a === "--discover") args.discover = true;
    else if (a === "--probe-gpu") args.probeGpu = true;
    else if (a === "--headed") args.headed = true;
    else if (a === "--electron-root") args.electronRoot = next();
    else if (a === "--label") args.label = next();
    else if (a === "--shots") args.shots = next();
    else if (a === "--slices") args.slices = Number(next());
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function summarise(xs) {
  const clean = xs.filter((x) => Number.isFinite(x));
  if (!clean.length) return null;
  return {
    n: clean.length,
    median: median(clean),
    min: Math.min(...clean),
    max: Math.max(...clean),
    values: clean,
  };
}

// --- environment record ------------------------------------------------------
/**
 * Everything a reader needs to interpret the numbers, captured automatically so
 * the record cannot drift from the machine that produced them. The display
 * refresh rate is included deliberately: any frame-rate figure is capped by it,
 * so a result reported without it is not interpretable.
 */
function sh(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function describeEnvironment() {
  const cpus = os.cpus();
  const env = {
    os: `${os.type()} ${os.release()}`,
    distro: sh(". /etc/os-release && echo $PRETTY_NAME"),
    kernel: sh("uname -r"),
    platform: os.platform(),
    arch: os.arch(),
    cpu_model: cpus.length ? cpus[0].model.trim() : null,
    cpu_logical_cores: cpus.length,
    cpu_physical_cores: Number(sh("lscpu | awk -F: '/^Core\\(s\\) per socket/{c=$2} /^Socket\\(s\\)/{s=$2} END{print c*s}'")) || null,
    cpu_max_mhz: Number(sh("lscpu | awk -F: '/^CPU max MHz/{print $2}'")) || null,
    total_memory_bytes: os.totalmem(),
    free_memory_bytes_at_start: os.freemem(),
    load_average_at_start: os.loadavg(),
    node: process.version,
  };
  const gpu = sh("lspci | grep -iE 'vga|3d controller|display'");
  env.gpu = gpu ? gpu.split("\n").map((s) => s.trim()) : null;
  const disks = sh("lsblk -d -o NAME,MODEL,SIZE,ROTA --noheadings");
  env.disks = disks ? disks.split("\n").map((s) => s.trim()) : null;
  const displays = sh("xrandr --current | grep -E ' connected|\\*'");
  env.displays = displays ? displays.split("\n").map((s) => s.trim()) : null;
  env.display_env = process.env.DISPLAY ?? null;
  return env;
}

// --- CDP helpers -------------------------------------------------------------
async function jsHeapUsed(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return m.JSHeapUsedSize ?? null;
}

/**
 * Sample the JS heap while `fn` runs and report the peak. Sampling rather than
 * a single end-of-run reading, because the peak is what constrains a machine,
 * and it can occur mid-decode rather than at the end.
 */
async function withHeapSampling(cdp, fn, intervalMs = 250) {
  let peak = 0;
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        const used = await jsHeapUsed(cdp);
        if (used && used > peak) peak = used;
      } catch { /* page may be navigating */ }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();
  try {
    const result = await fn();
    return { result, peakJsHeapBytes: peak };
  } finally {
    stop = true;
    await loop;
  }
}

// --- probes ------------------------------------------------------------------
async function waitForFirstImage(page, timeoutMs) {
  const start = Date.now();
  await page.waitForFunction(
    (threshold) => {
      const b = window.__bench;
      if (!b) return false;
      const s = b.primaryStats();
      return !!s && s.nonBlackFraction > threshold;
    },
    DEFAULTS.nonBlackThreshold,
    { timeout: timeoutMs, polling: 50 },
  );
  return Date.now() - start;
}

/**
 * Drive continuous stack scrolling and report the frame rate and how many
 * distinct images were actually shown.
 *
 * Two earlier versions of this function measured the harness rather than the
 * viewer, and both are worth recording because the failures are silent:
 *
 *  1. Driving with `page.mouse.wheel()` and awaiting each call made the CDP
 *     round trip the bottleneck; the reported rate (~25/s) was the harness's
 *     own event rate.
 *  2. Dispatching a synthetic `WheelEvent` from inside the page was fast but
 *     the application did not act on it — the frame rate looked like a healthy
 *     62/s while only 8 distinct images appeared in five seconds.
 *
 * So: events are delivered as *real* input through CDP `Input.dispatchMouseEvent`
 * (which the application cannot distinguish from a physical wheel), and the
 * in-page sampler counts distinct images so that a repaint-without-advance is
 * visible rather than flattering.
 */
async function measureScroll(page, cdp, seconds, maxEvents = Infinity) {
  const host = page.getByTestId(SEL.canvasHost).first();
  const box = await host.boundingBox();
  if (!box) throw new Error("2D canvas host has no bounding box");
  const cx = Math.round(box.x + box.width / 2);
  const cy = Math.round(box.y + box.height / 2);
  await page.mouse.move(cx, cy);

  await page.evaluate(() => {
    const b = window.__bench;
    b.resetRaf();
    b._seen = new Set();
    b._latencies = [];
    b._pending = null;

    // Per-event latency, timed entirely inside the page: from the moment a
    // wheel event arrives to the moment the viewport's content actually
    // changes. This is independent of how fast the harness can deliver events,
    // which is what makes it a measurement of the viewer rather than of CDP
    // round-trip time (~30 events/s, well below what the viewer can service).
    if (!b._wheelHooked) {
      window.addEventListener("wheel", () => { b._pending = performance.now(); }, { capture: true });
      b._wheelHooked = true;
    }

    // The sampler uses the unpatched rAF so it is not counted as an
    // application frame.
    b._sampling = true;
    let lastHash = null;
    const tick = () => {
      if (!b._sampling) return;
      const s = b.primaryStats();
      if (s) {
        b._seen.add(s.hash);
        if (lastHash !== null && s.hash !== lastHash && b._pending !== null) {
          b._latencies.push(performance.now() - b._pending);
          b._pending = null;
        }
        lastHash = s.hash;
      }
      b.rawRaf(tick);
    };
    b.rawRaf(tick);
  });

  const t0 = Date.now();
  const deadline = t0 + seconds * 1000;
  let events = 0;
  // Stop before the stack wraps around. On a short series a five-second scroll
  // returns to slices that are already cached, and the cache hits drag the
  // median latency down by a factor of seven (2.7 ms vs 19 ms on 64 slices) —
  // it would look as though small volumes scroll faster, when in fact they were
  // simply measured twice.
  while (Date.now() < deadline && events < maxEvents) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: cx,
      y: cy,
      deltaX: 0,
      deltaY: 120,
      modifiers: 0,
      pointerType: "mouse",
    });
    events++;
  }
  const elapsed = (Date.now() - t0) / 1000;

  const { frames, distinct, latencies } = await page.evaluate(() => {
    const b = window.__bench;
    b._sampling = false;
    return { frames: b.readRaf(), distinct: b._seen.size, latencies: b._latencies };
  });

  const lat = [...latencies].sort((a, b) => a - b);
  // The sampler observes content changes once per animation frame, so a latency
  // is quantised to a multiple of the display's frame interval (~16.7 ms at
  // 60 Hz). Values cluster at ~2.6 ms and ~18.6 ms for exactly this reason.
  // Reporting the median alone would claim sub-frame precision the method does
  // not have; the fraction serviced within one frame is what the data supports.
  const FRAME_MS = 1000 / 60;
  const withinOneFrame = lat.filter((x) => x <= FRAME_MS).length;
  const medianLatency = lat.length ? (lat.length % 2 ? lat[(lat.length - 1) / 2]
    : (lat[lat.length / 2 - 1] + lat[lat.length / 2]) / 2) : null;

  return {
    seconds: elapsed,
    // Delivery is CDP-bound at roughly 30 events/s; it bounds the observed
    // rates below but not the per-event latency.
    wheelEventsDelivered: events,
    frames,
    observedFps: frames / elapsed,
    distinctImages: distinct,
    observedDistinctImagesPerSecond: distinct / elapsed,
    sliceRenderLatencyMs: {
      n: lat.length,
      median: medianLatency,
      min: lat.length ? lat[0] : null,
      max: lat.length ? lat[lat.length - 1] : null,
      quantisation_ms: FRAME_MS,
      within_one_frame: withinOneFrame,
      within_one_frame_fraction: lat.length ? withinOneFrame / lat.length : null,
    },
    // Deliberately not summarised as a headline "slices per second": with the
    // latency quantised to the display frame, 1000/median extrapolates beyond
    // what the measurement resolves. Kept per-run for completeness only.
    impliedSlicesPerSecond: medianLatency ? 1000 / medianLatency : null,
  };
}

/**
 * Maximum slice throughput, measured with the viewer's own cine playback.
 *
 * Wheel events cannot answer this question: the harness can only deliver about
 * 30 through CDP per second, well under what the viewer can service, so a
 * wheel-driven figure measures the harness. Cine playback is driven by the
 * application itself, so counting distinct rendered images per second while it
 * runs gives the rate the viewer can actually sustain.
 */
async function measureCineThroughput(page, seconds) {
  const play = page.getByTestId(SEL.cinePlayZ).first();
  if (!(await play.count())) return null;

  await page.evaluate(() => {
    const b = window.__bench;
    b.resetRaf();
    b._seen = new Set();
    b._sampling = true;
    const tick = () => {
      if (!b._sampling) return;
      const s = b.primaryStats();
      if (s) b._seen.add(s.hash);
      b.rawRaf(tick);
    };
    b.rawRaf(tick);
  });

  const t0 = Date.now();
  await play.click();
  await page.waitForTimeout(seconds * 1000);
  const elapsed = (Date.now() - t0) / 1000;
  const { frames, distinct } = await page.evaluate(() => {
    const b = window.__bench;
    b._sampling = false;
    return { frames: b.readRaf(), distinct: b._seen.size };
  });
  await play.click().catch(() => {});

  return {
    seconds: elapsed,
    frames,
    fps: frames / elapsed,
    distinctImages: distinct,
    distinctImagesPerSecond: distinct / elapsed,
  };
}

/**
 * Move from the main screen's preview into the 2D Viewer proper. Measuring the
 * main screen would describe a thumbnail-sized preview rather than the viewer
 * under test; an early run did exactly that (one 900x512 canvas, 21 MB peak
 * heap for a 64-slice series).
 */
async function openViewer2d(page, baseUrl) {
  const ctx = page.context();
  await page.getByTestId(SEL.openViewer2d).click();
  for (let i = 0; i < 20; i++) {
    const opened = ctx.pages().find((p) => p !== page && p.url().includes("2dviewer"));
    if (opened) {
      await opened.waitForLoadState("domcontentloaded");
      return opened;
    }
    if (page.url().includes("2dviewer")) return page;
    await page.waitForTimeout(500);
  }
  if (baseUrl) {
    await page.goto(`${baseUrl}/#2dviewer`, { waitUntil: "domcontentloaded" });
    return page;
  }
  throw new Error("could not reach the 2D viewer");
}

/** Continuous left-drag across the viewport; used for 3D rotation. */
async function measureRotation(page, seconds, hostTestId) {
  const host = page.getByTestId(hostTestId).first();
  const box = await host.boundingBox();
  if (!box) throw new Error(`${hostTestId} has no bounding box`);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const r = Math.min(box.width, box.height) * 0.3;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.evaluate(() => window.__bench.resetRaf());

  const t0 = Date.now();
  const deadline = t0 + seconds * 1000;
  let i = 0;
  while (Date.now() < deadline) {
    const a = (i++ / 40) * Math.PI * 2;
    await page.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  const elapsed = (Date.now() - t0) / 1000;
  await page.mouse.up();

  const frames = await page.evaluate(() => window.__bench.readRaf());
  return { seconds: elapsed, frames, fps: frames / elapsed };
}

// --- application flow --------------------------------------------------------
async function openSeries(page, seriesPattern) {
  await page.getByTestId(SEL.searchPatientId).waitFor({ state: "visible", timeout: 60_000 });

  // Widen the date range explicitly. The search defaults to today's date on
  // both ends, and the phantom carries a fixed StudyDate (kept fixed so the
  // generated files stay byte-identical), so the default search returns
  // nothing the day after the phantom was generated. Clearing the fields with
  // fill("") does not work — the application falls back to its defaults.
  const dates = page.locator('input[type="date"]');
  const nDates = await dates.count();
  if (nDates >= 2) {
    await dates.nth(0).fill("2000-01-01");
    await dates.nth(1).fill("2099-12-31");
  }
  await page.getByTestId(SEL.searchSubmit).click();

  const studies = page.locator(SEL.studyRow);
  await studies.first().waitFor({ state: "visible", timeout: 60_000 });

  // Pick the study by name, not the first row: each phantom size is its own
  // study, and taking row 0 would silently measure whichever series happened
  // to sort first.
  let studyRow = studies.first();
  if (seriesPattern) {
    const n = await studies.count();
    let found = false;
    for (let i = 0; i < n; i++) {
      const text = (await studies.nth(i).textContent()) ?? "";
      if (text.includes(seriesPattern)) { studyRow = studies.nth(i); found = true; break; }
    }
    if (!found) {
      const all = [];
      for (let i = 0; i < n; i++) all.push((await studies.nth(i).textContent())?.trim());
      throw new Error(`study for "${seriesPattern}" not found. available: ${JSON.stringify(all)}`);
    }
  }
  await studyRow.click();

  const rows = page.locator(SEL.seriesRow);
  await rows.first().waitFor({ state: "visible", timeout: 60_000 });

  let target = rows.first();
  if (seriesPattern) {
    const n = await rows.count();
    let found = false;
    for (let i = 0; i < n; i++) {
      const text = (await rows.nth(i).textContent()) ?? "";
      if (text.includes(seriesPattern)) { target = rows.nth(i); found = true; break; }
    }
    if (!found) {
      const all = [];
      for (let i = 0; i < n; i++) all.push((await rows.nth(i).textContent())?.trim());
      throw new Error(`series "${seriesPattern}" not found. available: ${JSON.stringify(all)}`);
    }
  }

  const clickedAt = Date.now();
  await target.click();
  return clickedAt;
}

async function discover(page) {
  const ids = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-testid]"))
      .map((el) => el.getAttribute("data-testid"))
      .filter(Boolean)
      .sort(),
  );
  const canvases = await page.evaluate(() =>
    Array.from(document.querySelectorAll("canvas")).map((c) => ({
      width: c.width, height: c.height,
      testid: c.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
    })),
  );
  const hasDebugApi = await page.evaluate(() => typeof window.__graphyDebug !== "undefined");
  return { testIds: [...new Set(ids)], canvases, hasDebugApi };
}

async function probeGpuMemory(cdp) {
  // Recorded as a finding, not as a metric: if Chrome does not expose a
  // per-page GPU memory figure, that absence is what gets reported rather than
  // an invented number.
  const out = { available: false, detail: null };
  try {
    const info = await cdp.send("SystemInfo.getInfo");
    out.detail = { gpuDevices: info?.gpu?.devices ?? null };
  } catch (e) {
    out.detail = { error: String(e) };
  }
  return out;
}

// --- launchers ---------------------------------------------------------------
/**
 * A browser context dedicated to one run.
 *
 * Runs must not share a context. When they did, every metric drifted: on the
 * 64-slice series the slice latency fell from 19.2 ms on the first run to
 * 2.7 ms on the fifth, and the "peak" heap climbed monotonically from 24 to
 * 55 MiB, converging on the image cache's ceiling rather than reflecting the
 * volume. A fresh context gives each run its own HTTP cache and its own heap;
 * the HTTP cache is also disabled outright so that no run is quietly warmer
 * than another.
 */
async function newRunContext(browser, args) {
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

async function launchWeb(args) {
  const browser = await chromium.launch({ headless: !args.headed });
  return {
    kind: "web",
    browser,
    browserVersion: browser.version(),
    newRun: () => newRunContext(browser, args),
    close: () => browser.close(),
  };
}

async function launchDesktop(args) {
  if (!args.electronRoot) throw new Error("--electron-root is required for --mode desktop");
  const app = await electron.launch({
    args: [path.resolve(args.electronRoot)],
    env: { ...process.env, GRAPHY_DEV: "0" },
  });
  const page = await app.firstWindow();
  await page.addInitScript(INIT_SCRIPT);
  await page.reload();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  // Electron gives one window and one context, so desktop runs cannot be
  // isolated the way web runs are. Each run still reloads the page, which
  // discards the application's own caches, but the HTTP cache persists —
  // recorded here so the difference is visible in the results.
  return {
    kind: "desktop",
    page, cdp,
    runsAreIsolated: false,
    browserVersion: `electron ${await app.evaluate(({ app: a }) => a.getVersion())}`,
    newRun: async () => ({ page, cdp, dispose: async () => {} }),
    close: () => app.close(),
  };
}

// --- main --------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);
  const session = args.mode === "desktop" ? await launchDesktop(args) : await launchWeb(args);

  try {
    if (args.discover) {
      const { page, dispose } = await session.newRun();
      await page.waitForTimeout(3000);
      const shell = await discover(page);
      let viewer = null;
      if (args.series) {
        // Discovery is far more useful inside the viewer than on the shell:
        // that is where the measurement tools live.
        await openSeries(page, args.series);
        await waitForFirstImage(page, DEFAULTS.firstImageTimeoutMs);
        const vp = await openViewer2d(page, args.mode === "web" ? args.url : null);
        await vp.getByTestId(SEL.seriesViewerRoot).first().waitFor({ state: "visible", timeout: 60_000 });
        await vp.waitForTimeout(2000);
        viewer = await discover(vp);
      }
      console.log(JSON.stringify({ shell, viewer }, null, 2));
      await dispose();
      return;
    }

    const record = {
      phantom_series: args.series,
      label: args.label ?? args.series,
      mode: args.mode,
      url: args.mode === "web" ? args.url : null,
      browser: session.browserVersion,
      environment: describeEnvironment(),
      build_info: readBuildInfo(),
      metric_definitions: {
        time_to_first_image_ms:
          "wall clock from the click that opens the series on the main screen to the first frame in which the largest canvas has more than 1% non-black pixels",
        time_to_viewer_first_image_ms:
          "wall clock from the click that opens the 2D Viewer to the first rendered image inside it",
        viewer_js_heap_bytes:
          "JSHeapUsedSize of the 2D Viewer context, read once after the scroll measurement",
        stack_scroll_fps:
          "requestAnimationFrame callbacks serviced by the application per second while real wheel events are delivered continuously through CDP Input.dispatchMouseEvent; the harness's own sampling loop uses an unpatched requestAnimationFrame and is not counted",
        slice_render_latency_ms:
          "cold-cache median time from a wheel event arriving in the page to the viewport's rendered content changing; measured in page time so it does not depend on how fast the harness can deliver events. The scroll is capped at one pass through the stack so that no slice is measured twice from cache",
        slice_latency_within_one_frame_fraction:
          "fraction of wheel events whose rendered result appeared within one display frame (16.7 ms at 60 Hz). This, not a slices-per-second figure, is what the measurement resolves: the sampler detects content changes once per frame, so latencies are quantised to frame multiples",
        observed_fps:
          "application frames per second actually observed during the scroll; bounded by the harness's CDP event delivery rate (~30/s) and therefore a lower bound, not a capability",
        wheel_events_serviced:
          "distinct images rendered divided by wheel events delivered. A value near 1 means the viewer kept up with every event it was given",
        rotation_fps:
          "requestAnimationFrame callbacks serviced per second while the pointer is dragged in a circle with the button held",
        peak_js_heap_bytes:
          "maximum JSHeapUsedSize reported by CDP Performance.getMetrics, sampled every 250 ms for the duration of the run",
        cine_images_per_second:
          "distinct rendered images per second during the viewer's own cine playback. This is the application's configured playback rate sustained without dropping images — NOT an upper bound on what the renderer could do. Neither this nor the wheel-driven figure measures a maximum: the harness cannot deliver wheel events faster than about 30/s, and cine runs at its configured rate",
        gpu_memory: "not measured — Chrome exposes no per-page GPU memory figure through CDP",
      },
      runs: [],
    };

    // Isolation status belongs with the numbers: without it a reader cannot
    // tell whether later runs were quietly warmer than earlier ones.
    record.runs_are_isolated = session.kind === "web";

    // Which renderer actually served WebGL. A software renderer (SwiftShader,
    // llvmpipe) would invalidate every frame-rate number here, so this is
    // recorded with the results rather than assumed.
    const probeRun = await session.newRun();
    record.webgl_renderer = await probeRun.page.evaluate(() => {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      if (!gl) return { error: "no webgl context" };
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        version: gl.getParameter(gl.VERSION),
      };
    });

    if (args.probeGpu) record.gpu_probe = await probeGpuMemory(probeRun.cdp);
    await probeRun.dispose();

    for (let run = 0; run < args.runs; run++) {
      process.stderr.write(`run ${run + 1}/${args.runs} ...\n`);
      // A fresh context per run: no shared HTTP cache, no carried-over heap.
      const { page, cdp, dispose } = await session.newRun();
      await page.waitForTimeout(1500);

      let viewerPage = page;
      let viewerCdp = cdp;

      const { result, peakJsHeapBytes } = await withHeapSampling(cdp, async () => {
        await openSeries(page, args.series);
        const firstImageMs = await waitForFirstImage(page, DEFAULTS.firstImageTimeoutMs);
        await page.getByTestId(SEL.canvasHost).first().waitFor({ state: "visible" });

        const viewerT0 = Date.now();
        viewerPage = await openViewer2d(page, args.mode === "web" ? args.url : null);
        if (viewerPage !== page) {
          viewerCdp = await viewerPage.context().newCDPSession(viewerPage);
          await viewerCdp.send("Performance.enable");
        }
        await viewerPage.getByTestId(SEL.seriesViewerRoot).first()
          .waitFor({ state: "visible", timeout: DEFAULTS.firstImageTimeoutMs });
        await waitForFirstImage(viewerPage, DEFAULTS.firstImageTimeoutMs);
        const viewerReadyMs = Date.now() - viewerT0;

        await viewerPage.waitForTimeout(1000);
        // Diagnostics: record what was actually on screen when the metrics were
        // taken. Without this there is no way to tell a genuine measurement
        // from one that timed a thumbnail or an empty viewport.
        const canvases = await viewerPage.evaluate(() => window.__bench.allCanvasStats());
        const scroll = await measureScroll(
          viewerPage, viewerCdp, DEFAULTS.scrollSeconds,
          args.slices ? args.slices - 1 : Infinity,
        );
        const cine = await measureCineThroughput(viewerPage, DEFAULTS.cineSeconds);
        return { firstImageMs, viewerReadyMs, scroll, cine, canvases };
      });

      // The viewer may live in its own window; take its heap, not the shell's.
      const viewerHeap = await jsHeapUsed(viewerCdp).catch(() => null);

      if (args.shots) {
        const dir = path.resolve(args.shots);
        fs.mkdirSync(dir, { recursive: true });
        await viewerPage.screenshot({ path: path.join(dir, `${record.label ?? "run"}-${run + 1}.png`) });
      }

      record.runs.push({
        run: run + 1,
        time_to_first_image_ms: result.firstImageMs,
        time_to_viewer_first_image_ms: result.viewerReadyMs,
        stack_scroll: result.scroll,
        cine_throughput: result.cine,
        peak_js_heap_bytes: peakJsHeapBytes,
        viewer_js_heap_bytes: viewerHeap,
        canvases_at_measurement: result.canvases,
      });

      if (viewerPage !== page) await viewerPage.close().catch(() => {});
      await dispose();
    }

    record.summary = {
      time_to_first_image_ms: summarise(record.runs.map((r) => r.time_to_first_image_ms)),
      time_to_viewer_first_image_ms: summarise(record.runs.map((r) => r.time_to_viewer_first_image_ms)),
      viewer_js_heap_bytes: summarise(record.runs.map((r) => r.viewer_js_heap_bytes)),
      slice_render_latency_ms: summarise(record.runs.map((r) => r.stack_scroll.sliceRenderLatencyMs.median)),
      observed_fps: summarise(record.runs.map((r) => r.stack_scroll.observedFps)),
      peak_js_heap_bytes: summarise(record.runs.map((r) => r.peak_js_heap_bytes)),
      cine_images_per_second: summarise(record.runs.map((r) => r.cine_throughput?.distinctImagesPerSecond)),
      slice_latency_within_one_frame_fraction:
        summarise(record.runs.map((r) => r.stack_scroll.sliceRenderLatencyMs.within_one_frame_fraction)),
    };

    const json = JSON.stringify(record, null, 2);
    if (args.out) {
      fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
      fs.writeFileSync(args.out, json);
      process.stderr.write(`wrote ${args.out}\n`);
    }
    console.log(json);
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
