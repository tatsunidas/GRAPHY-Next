/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { metaData } from "@cornerstonejs/core";
import { fetchLutData, type Instance, type LutData, type Series, type Study } from "../api";
import { createValueStack, releaseValueStack, updateValueStackWindow } from "../plugins/pluginVolumeScheme";
import type { PluginTransientSeriesHandle, PluginTransientSeriesSpec } from "../plugins/pluginTypes";
import { buildTransientLayout, type TransientGeometry } from "../viewer/transientLayout";
import { disposeTransient } from "../viewer/transientDispose";
import { queryViewerCommand } from "../viewer/viewerCommands";
import { runSeriesCommand } from "../viewer/seriesCommands";
import {
  createTransientHandle,
  notifyTransientClosed,
  notifyTransientDim,
  syntheticSeriesUid,
  validateTransientSpec,
  type TransientOpened,
} from "../viewer/transientSeries";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** `Viewer2DScreen` の `Tile` のうち、一時タイルが埋める部分。 */
export interface TransientTileInit {
  id: string;
  study: Study;
  series: Series;
  instances: Instance[];
  syncEnabled: false;
  transient: TransientOpened;
}

let counter = 0;

/** 一時タイルが今どのマップを出しているか（seriesUid → C）。古い適用が新しい切替を上書きしないための印。 */
const shownMap = new Map<string, number>();

/**
 * マップの窓とカラーマップをタイルへ当てる。C を切り替えると、**手で変えた W/L は戻る**（マップごとの窓が正）。
 * 画像の読み込みの直後に既定の VOI で上書きされることがあるので、少し遅らせて当て直す。
 */
export async function applyTransientDisplay(tr: TransientOpened, c: number): Promise<void> {
  const m = tr.maps[c];
  if (!m) return;
  let lut: LutData | null = null;
  if (m.colormap) {
    try {
      lut = await fetchLutData(m.colormap);
    } catch {
      lut = null; // 取れなければグレースケール（黙って別の色を当てない）
    }
  }
  const apply = () => {
    if (shownMap.get(tr.seriesUid) !== c) return;
    queryViewerCommand(tr.tileId, (cmd) => {
      cmd.applyLut(lut);
      cmd.setWindowLevel(m.window.center, m.window.width);
    });
  };
  apply();
  for (const ms of [250, 900]) window.setTimeout(apply, ms);
}

/** タイルが表示中の C・Z を報告する（`SeriesViewer.onDimChange` から）。C が変わったときだけ表示を当てる。 */
export function onTransientDim(tr: TransientOpened, c: number, z: number): void {
  notifyTransientDim(tr.seriesUid, c, z);
  if (shownMap.get(tr.seriesUid) === c) return;
  shownMap.set(tr.seriesUid, c);
  void applyTransientDisplay(tr, c);
}

/** タイルが消えたときの後始末（スタック・annotation・購読者への通知）。 */
export function finishTransient(tr: TransientOpened): void {
  disposeTransient(tr);
  shownMap.delete(tr.seriesUid);
  notifyTransientClosed(tr.seriesUid);
}

/** 参照スタックの幾何（best-effort。取れなければ null）。 */
function readGeometry(nativeIds: string[]): { geometry: TransientGeometry; inPlane: { rows: number; columns: number } | null } {
  const plane = (id: string): Any => {
    try {
      return metaData.get("imagePlaneModule", id);
    } catch {
      return undefined;
    }
  };
  const p0 = plane(nativeIds[0]);
  let normal: [number, number, number] | null = null;
  const r = p0?.rowCosines ?? p0?.imageOrientationPatient?.slice(0, 3);
  const c = p0?.columnCosines ?? p0?.imageOrientationPatient?.slice(3, 6);
  if (r?.length === 3 && c?.length === 3) {
    const n = [r[1] * c[2] - r[2] * c[1], r[2] * c[0] - r[0] * c[2], r[0] * c[1] - r[1] * c[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len > 0) normal = [n[0] / len, n[1] / len, n[2] / len];
  }
  const inPlane = p0 && p0.rows > 0 && p0.columns > 0 ? { rows: p0.rows as number, columns: p0.columns as number } : null;
  return {
    geometry: {
      normal,
      ippAt: (z) => {
        const ipp = plane(nativeIds[z])?.imagePositionPatient;
        return ipp?.length === 3 ? [ipp[0], ipp[1], ipp[2]] : null;
      },
    },
    inPlane,
  };
}

/**
 * `host.openTransientSeries` の実体。検証はすべてスタックを作る前に行い、作った後に失敗したら解放する
 * （解放されないスタックは Float32 のボリューム 1 本分ずつ積み上がる）。
 */
export function openTransientTile(args: {
  spec: PluginTransientSeriesSpec;
  producer: { id: string; name: string };
  ref: { id: string; study: Study; series: Series } | undefined;
  referenceId: string | undefined;
  addTile: (tile: TransientTileInit) => void;
  removeTile: (tileId: string) => void;
  /** タイルが今表示している C・Z（初期位置が効いたかの確認用）。 */
  getDims: (tileId: string) => { c: number; z: number } | undefined;
}): PluginTransientSeriesHandle {
  const { spec, producer, ref } = args;
  if (!ref) throw new Error(`openTransientSeries: reference tile ${args.referenceId ?? "(none)"} cannot be resolved`);
  const nativeIds = queryViewerCommand(ref.id, (c) => c.getStackImageIds());
  if (!nativeIds || nativeIds.length === 0) {
    throw new Error(`openTransientSeries: the reference tile ${ref.id} has no image stack`);
  }
  const { geometry, inPlane } = readGeometry(nativeIds);
  validateTransientSpec(spec, nativeIds.length, inPlane);

  counter += 1;
  const tileId = `plugin-transient|${producer.id}|${counter}`;
  const seriesUid = syntheticSeriesUid();
  const created: string[] = [];
  let opened: TransientOpened;
  try {
    const maps = spec.maps.map((m, c) => {
      const s = createValueStack({
        pluginId: producer.id,
        data: m.volume.data,
        dims: m.volume.dims,
        nativeIds,
        unit: m.volume.unit,
        window: m.window,
        transient: { seriesUid, description: `[Plugin ${producer.name}] ${spec.label} ·${m.name}（未保存）`, c },
      });
      created.push(s.token);
      return {
        name: m.name,
        token: s.token,
        imageIds: s.imageIds,
        unit: m.volume.unit ?? "",
        window: { ...m.window },
        colormap: m.colormap ?? null,
      };
    });
    opened = {
      tileId,
      pluginId: producer.id,
      pluginName: producer.name,
      label: spec.label,
      seriesUid,
      maps,
      layout: buildTransientLayout(maps, geometry),
      scaleBar: spec.scaleBar ?? true,
    };
  } catch (e) {
    for (const token of created) releaseValueStack(token);
    throw e;
  }

  const handle = createTransientHandle({
    tileId,
    seriesUid,
    requestClose: () => args.removeTile(tileId),
    setMapDisplay: (c, d) => {
      const m = opened.maps[c];
      if (!m) throw new Error(`setMapDisplay: map ${c} does not exist`);
      if (d.window) {
        if (!(Number.isFinite(d.window.center) && Number.isFinite(d.window.width) && d.window.width > 0)) {
          throw new Error("setMapDisplay: window needs finite center and width > 0");
        }
        updateValueStackWindow(m.token, d.window);
        m.window = { ...d.window };
      }
      if (d.colormap !== undefined) m.colormap = d.colormap;
      if (shownMap.get(seriesUid) === c) void applyTransientDisplay(opened, c);
    },
  });

  args.addTile({
    id: tileId,
    study: ref.study,
    series: {
      ...ref.series,
      seriesInstanceUid: seriesUid,
      seriesNumber: null,
      seriesDescription: `[Plugin ${producer.name}] ${spec.label}（未保存）`,
      modality: "MR",
    },
    instances: [],
    syncEnabled: false,
    transient: opened,
  });

  const wantC = spec.initialC ?? 0;
  const wantZ = spec.initialZ;
  if (wantC > 0 || (wantZ !== undefined && wantZ > 0)) {
    // SeriesViewer がマウントされ、コマンドが登録されるまで待つ（登録前の goTo は黙って捨てられる）。
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      const d = args.getDims(tileId);
      const done = d && d.c === wantC && (wantZ === undefined || d.z === wantZ);
      if (done || tries > 20 || handle.closed) {
        window.clearInterval(timer);
        return;
      }
      runSeriesCommand([tileId], (cmd) => cmd.goTo({ c: wantC, ...(wantZ !== undefined ? { z: wantZ } : {}) }));
    }, 150);
  }
  return handle;
}
