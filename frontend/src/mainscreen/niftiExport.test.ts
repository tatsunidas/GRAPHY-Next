import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NiftiExportRefused, exportSeriesNiftiWeb, type Series } from "../api";
import { ja } from "../i18n/ja";
import { en } from "../i18n/en";
import {
  NIFTI_REFUSAL_REASONS,
  niftiExportAvailability,
  niftiFileName,
  niftiRefusalKey,
  runNiftiExport,
} from "./niftiExport";

const series = (over: Partial<Series> = {}): Series => ({
  seriesInstanceUid: "1.2.3",
  modality: "CT",
  seriesNumber: 4,
  seriesDescription: "山田太郎 腹部造影",
  sopClassUid: null,
  numberOfInstances: 10,
  ...over,
});

describe("niftiFileName", () => {
  it("<モダリティ>_S<系列番号>.nii.gz。患者情報・説明文は入れない", () => {
    const n = niftiFileName(series());
    expect(n).toBe("CT_S4.nii.gz");
    expect(n).not.toContain("山田");
  });
  it("使えない文字は消え、決まらなければ volume", () => {
    expect(niftiFileName(series({ modality: "C/T ", seriesNumber: 0 }))).toBe("CT_S0.nii.gz");
    expect(niftiFileName(series({ modality: null, seriesNumber: null }))).toBe("volume.nii.gz");
    expect(niftiFileName(series({ modality: "PT", seriesNumber: null }))).toBe("PT.nii.gz");
    expect(niftiFileName(null)).toBe("volume.nii.gz");
  });
});

describe("niftiExportAvailability", () => {
  it("既定（シリーズ未選択）は押せず理由が出る", () => {
    expect(niftiExportAvailability({ series: null })).toEqual({ enabled: false, reasonKey: "niftiExport.disabled.noSeries" });
  });
  it("実行中は押せない（二重実行を防ぐ）", () => {
    expect(niftiExportAvailability({ series: series(), busy: true })).toEqual({ enabled: false, reasonKey: "niftiExport.disabled.busy" });
  });
  it("シリーズを選ぶと押せる（standalone でも web でも。web はジョブで書き出す）", () => {
    expect(niftiExportAvailability({ series: series() })).toEqual({ enabled: true });
  });
});

describe("理由コード", () => {
  it("既知のコードは、すべて ja・en に文言がある（文言の抜けが画面に出ない）", () => {
    for (const code of NIFTI_REFUSAL_REASONS) {
      const key = niftiRefusalKey(code)!;
      expect(key, code).toBeTruthy();
      expect((ja as Record<string, string>)[key], `ja ${key}`).toBeTruthy();
      expect((en as Record<string, string>)[key], `en ${key}`).toBeTruthy();
    }
    expect((ja as Record<string, string>)["niftiExport.refused.npz-bits"]).toBeTruthy();
    expect(niftiRefusalKey("npz-bits-12")).toBe("niftiExport.refused.npz-bits");
  });
  it("未知のコードは null（画面が生のコードを添える）", () => {
    expect(niftiRefusalKey("something-new")).toBeNull();
  });
});

describe("runNiftiExport", () => {
  const t = (key: string, p?: Record<string, string | number>) => `${key}${p ? JSON.stringify(p) : ""}`;
  const st = { studyInstanceUid: "9.8" };

  it("成功: 選んだシリーズで書き出し、保存は既定名で 1 回、枚数つきの文言", async () => {
    const blob = new Blob(["x"]);
    const exportSeries = vi.fn().mockResolvedValue({ blob, slices: 21 });
    const save = vi.fn();
    const r = await runNiftiExport(st, series(), { exportSeries, save, t });
    expect(exportSeries).toHaveBeenCalledWith("9.8", "1.2.3", undefined, undefined);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(blob, "CT_S4.nii.gz");
    expect(r).toEqual({ error: false, text: 'niftiExport.done{"name":"CT_S4.nii.gz","n":21}' });
  });
  it("web: 進行と中止の信号を書き出しへ渡す。中止されたら保存せず「中止」の文言（エラー扱いにしない）", async () => {
    const ctl = new AbortController();
    const onProgress = vi.fn();
    const exportSeries = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));
    const save = vi.fn();
    const r = await runNiftiExport(st, series(), { exportSeries, save, t, onProgress, signal: ctl.signal });
    expect(exportSeries).toHaveBeenCalledWith("9.8", "1.2.3", onProgress, ctl.signal);
    expect(save).not.toHaveBeenCalled();
    expect(r).toEqual({ error: false, text: "niftiExport.cancelled" });
  });
  it("枚数が分からなければ枚数なしの文言", async () => {
    const r = await runNiftiExport(st, series(), { exportSeries: async () => ({ blob: new Blob(), slices: null }), save: () => {}, t });
    expect(r.text).toContain("niftiExport.doneNoCount");
  });
  it("負例: 断られたら保存しない。理由の文言（ガントリーチルト）が出る", async () => {
    const save = vi.fn();
    const r = await runNiftiExport(st, series(), {
      exportSeries: async () => { throw new NiftiExportRefused("volume-sheared", 422); },
      save,
      t,
    });
    expect(save).not.toHaveBeenCalled();
    expect(r.error).toBe(true);
    expect(r.text).toContain("niftiExport.refused.volume-sheared");
  });
  it("未知の理由コードは握りつぶさずコードを添える。想定外の例外も文言にする", async () => {
    const unknown = await runNiftiExport(st, series(), { exportSeries: async () => { throw new NiftiExportRefused("brand-new", 422); }, save: () => {}, t });
    expect(unknown.text).toContain("niftiExport.failedUnknown");
    expect(unknown.text).toContain("brand-new");
    const other = await runNiftiExport(st, series(), { exportSeries: async () => { throw new Error("network error"); }, save: () => {}, t });
    expect(other.error).toBe(true);
    expect(other.text).toContain("network error");
  });
});

describe("exportSeriesNiftiWeb（web のジョブ）", () => {
  // apiBase() は window.__GRAPHY_API_BASE__ を読む（node 環境には window が無い）
  beforeEach(() => vi.stubGlobal("window", {}));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  type Reply = { status?: number; json?: unknown; body?: string; headers?: Record<string, string> };
  /** URL の末尾と method で応答を返す偽の fetch。呼ばれた (method, path) を記録する。 */
  function fakeFetch(replies: Record<string, Reply[]>) {
    const calls: string[] = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, "http://x").pathname;
      const key = `${init?.method ?? "GET"} ${path}`;
      calls.push(key);
      const q = replies[key];
      if (!q || q.length === 0) throw new Error(`unexpected ${key}`);
      const r = q.length > 1 ? q.shift()! : q[0];
      return new Response(r.json !== undefined ? JSON.stringify(r.json) : (r.body ?? ""), {
        status: r.status ?? 200,
        headers: { "Content-Type": r.json !== undefined ? "application/json" : "application/gzip", ...(r.headers ?? {}) },
      });
    });
    return { f, calls };
  }
  const st = (state: string, over: object = {}) => ({ jobId: "j1", state, total: 5, processed: 2, ...over });

  it("投入 → 状態 → 受け取り。書き込みには X-Graphy-Request を付ける。進行を通知し、枚数をヘッダから返す", async () => {
    vi.useFakeTimers();
    const { f, calls } = fakeFetch({
      "POST /api/nifti/export-job": [{ status: 202, json: st("QUEUED") }],
      "GET /api/anonymizer/jobs/j1": [{ json: st("RUNNING") }, { json: st("DONE", { processed: 5 }) }],
      "GET /api/nifti/export-job/j1/file": [{ body: "GZ", headers: { "X-Graphy-Slices": "5" } }],
    });
    vi.stubGlobal("fetch", f);
    const progress = vi.fn();
    const p = exportSeriesNiftiWeb("9.8", "1.2.3", progress);
    await vi.advanceTimersByTimeAsync(3000);
    const r = await p;
    expect(r.slices).toBe(5);
    expect(await r.blob.text()).toBe("GZ");
    expect(progress).toHaveBeenCalledWith(2, 5);
    expect((f.mock.calls[0][1]!.headers as Record<string, string>)["X-Graphy-Request"]).toBe("1");
    expect(calls.at(-1)).toBe("GET /api/nifti/export-job/j1/file");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("負例: ジョブが FAILED なら理由コードで断られ、ファイルは取りに行かない", async () => {
    const { f, calls } = fakeFetch({
      "POST /api/nifti/export-job": [{ status: 202, json: st("QUEUED") }],
      "GET /api/anonymizer/jobs/j1": [{ json: st("FAILED", { reason: "burnin-declared" }) }],
    });
    vi.stubGlobal("fetch", f);
    const err = await exportSeriesNiftiWeb("9.8", "1.2.3").catch((e) => e);
    expect(err).toBeInstanceOf(NiftiExportRefused);
    expect((err as NiftiExportRefused).reason).toBe("burnin-declared");
    expect(calls.some((c) => c.includes("/file"))).toBe(false);
    vi.unstubAllGlobals();
  });
  it("投入が断られたら（501 など）そのまま断りとして投げる", async () => {
    const { f } = fakeFetch({ "POST /api/nifti/export-job": [{ status: 501, json: { error: "not-web-mode" } }] });
    vi.stubGlobal("fetch", f);
    const err = await exportSeriesNiftiWeb("9.8", "1.2.3").catch((e) => e);
    expect(err).toBeInstanceOf(NiftiExportRefused);
    expect((err as NiftiExportRefused).status).toBe(501);
    vi.unstubAllGlobals();
  });
  it("中止: ジョブを DELETE して AbortError を投げ、受け取りには行かない", async () => {
    vi.useFakeTimers();
    const { f, calls } = fakeFetch({
      "POST /api/nifti/export-job": [{ status: 202, json: st("QUEUED") }],
      "GET /api/anonymizer/jobs/j1": [{ json: st("RUNNING") }],
      "DELETE /api/anonymizer/jobs/j1": [{ body: "" }],
    });
    vi.stubGlobal("fetch", f);
    const ctl = new AbortController();
    const p = exportSeriesNiftiWeb("9.8", "1.2.3", undefined, ctl.signal).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10);
    ctl.abort();
    await vi.advanceTimersByTimeAsync(1500);
    const err = await p;
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
    expect(calls).toContain("DELETE /api/anonymizer/jobs/j1");
    expect(calls.some((c) => c.includes("/file"))).toBe(false);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
