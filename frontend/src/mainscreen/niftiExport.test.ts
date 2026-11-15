import { describe, expect, it, vi } from "vitest";
import { NiftiExportRefused, type Series } from "../api";
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
    expect(niftiExportAvailability({ series: null, isStandalone: true })).toEqual({ enabled: false, reasonKey: "niftiExport.disabled.noSeries" });
  });
  it("web モードは押せない（シリーズを選んでいても）", () => {
    expect(niftiExportAvailability({ series: series(), isStandalone: false })).toEqual({ enabled: false, reasonKey: "niftiExport.disabled.web" });
  });
  it("実行中は押せない（二重実行を防ぐ）", () => {
    expect(niftiExportAvailability({ series: series(), isStandalone: true, busy: true })).toEqual({ enabled: false, reasonKey: "niftiExport.disabled.busy" });
  });
  it("standalone でシリーズを選ぶと押せる", () => {
    expect(niftiExportAvailability({ series: series(), isStandalone: true })).toEqual({ enabled: true });
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
    expect(exportSeries).toHaveBeenCalledWith("9.8", "1.2.3");
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(blob, "CT_S4.nii.gz");
    expect(r).toEqual({ error: false, text: 'niftiExport.done{"name":"CT_S4.nii.gz","n":21}' });
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
