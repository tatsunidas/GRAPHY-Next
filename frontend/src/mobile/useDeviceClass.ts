/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 端末クラスの判定と UI モードの決定（設計: `fw/mobile-ui-design.md` §3.1）。
 *
 * <p>⚠️ **既存の `standalone` / `web` は流用できない。** あれは Spring プロファイル由来の
 * 「**データ源**」を表す軸（`StatusController`）であって、端末を表さない。ここで**別の軸**を新設する。
 *
 * <p>判定は**幅とポインタ精度の両方**を見る。幅だけだと小さいウィンドウのデスクトップが
 * モバイル扱いになり、ポインタだけだとタッチ対応ノート PC がモバイル扱いになる。
 *
 * <p>**端末クラスで機能を出し分けはしない。** 3D/MPR の可否はメモリガード
 * （`fw/volume-memory-guard.md`）が必要量から判断する。端末で線引きすると、高性能タブレットで
 * 無用に制限され、低性能端末では結局落ちる。ここが決めるのは**シェル（画面構成）だけ**。
 */
import { useCallback, useEffect, useState } from "react";

/** 画面の物理的な区分。 */
export type DeviceClass = "phone" | "tablet" | "desktop";

/** 実際に描画するシェル。 */
export type UiMode = "mobile" | "desktop";

/** 利用者の明示選択。`auto` は端末クラスに従う。 */
export type UiModeOverride = "auto" | UiMode;

/** 手動切替の保存先。 */
export const UI_MODE_OVERRIDE_KEY = "graphy.ui.modeOverride";

/** phone 判定の上限幅 [px]。 */
export const PHONE_MAX_WIDTH = 768;
/** tablet 判定の上限幅 [px]。 */
export const TABLET_MAX_WIDTH = 1024;

/** {@link classifyDevice} / {@link autoUiMode} の入力（`matchMedia` の結果）。 */
export interface DeviceSignals {
  /** `(max-width: 768px)` */
  phoneWidth: boolean;
  /** `(max-width: 1024px)` */
  tabletWidth: boolean;
  /** `(pointer: coarse)` = 指/スタイラス主体 */
  coarsePointer: boolean;
}

/** 幅から端末クラスを決める。 */
export function classifyDevice(s: DeviceSignals): DeviceClass {
  if (s.phoneWidth) return "phone";
  if (s.tabletWidth) return "tablet";
  return "desktop";
}

/**
 * 自動判定の UI モード。
 *
 * <ul>
 *   <li>phone … 幅だけでモバイル（この幅にデスクトップ UI は入らない）</li>
 *   <li>tablet … **ポインタが粗いときだけ**モバイル（小さめのウィンドウで開いた
 *       デスクトップブラウザをモバイル扱いしない）</li>
 *   <li>desktop … 常にデスクトップ（タッチ対応ノート PC を巻き込まない）</li>
 * </ul>
 */
export function autoUiMode(s: DeviceSignals): UiMode {
  const cls = classifyDevice(s);
  if (cls === "phone") return "mobile";
  if (cls === "tablet" && s.coarsePointer) return "mobile";
  return "desktop";
}

/** 明示選択があればそれ、無ければ自動判定。 */
export function resolveUiMode(s: DeviceSignals, override: UiModeOverride): UiMode {
  return override === "auto" ? autoUiMode(s) : override;
}

/** 保存値を正規化する（未設定・壊れた値は `auto`）。 */
export function normalizeOverride(raw: string | null | undefined): UiModeOverride {
  return raw === "mobile" || raw === "desktop" ? raw : "auto";
}

/** 現在の `matchMedia` からシグナルを読む。`matchMedia` が無い環境では desktop 相当。 */
export function readDeviceSignals(): DeviceSignals {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return { phoneWidth: false, tabletWidth: false, coarsePointer: false };
  }
  return {
    phoneWidth: window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH}px)`).matches,
    tabletWidth: window.matchMedia(`(max-width: ${TABLET_MAX_WIDTH}px)`).matches,
    coarsePointer: window.matchMedia("(pointer: coarse)").matches,
  };
}

function readOverride(): UiModeOverride {
  try {
    return normalizeOverride(localStorage.getItem(UI_MODE_OVERRIDE_KEY));
  } catch {
    return "auto";
  }
}

/** {@link useDeviceClass} の戻り。 */
export interface DeviceClassState {
  deviceClass: DeviceClass;
  /** 明示選択を織り込んだ最終的なシェル。 */
  uiMode: UiMode;
  /** 自動判定だけの結果（設定 UI で「自動なら〜になります」を出す用）。 */
  autoMode: UiMode;
  override: UiModeOverride;
  /** 明示選択を保存する。`auto` に戻すと自動判定へ。 */
  setOverride: (next: UiModeOverride) => void;
}

/**
 * 端末クラスと UI モードを購読する。回転・ウィンドウリサイズで再評価する。
 *
 * <p>⚠️ **`uiMode` が `mobile` でも、モバイルシェルを出してよいのは web モードだけ**
 * （`fw/mobile-ui-design.md` は standalone を対象外にしている）。モード判定はこのフックの責務外なので、
 * 呼び出し側で `status.mode` と併せて判断すること。
 */
export function useDeviceClass(): DeviceClassState {
  const [signals, setSignals] = useState<DeviceSignals>(readDeviceSignals);
  const [override, setOverrideState] = useState<UiModeOverride>(readOverride);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const queries = [
      window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH}px)`),
      window.matchMedia(`(max-width: ${TABLET_MAX_WIDTH}px)`),
      window.matchMedia("(pointer: coarse)"),
    ];
    const onChange = () => setSignals(readDeviceSignals());
    // Safari 13 以前は addEventListener 非対応（addListener のみ）。iOS を対象にするので両対応にする。
    for (const q of queries) {
      if (q.addEventListener) q.addEventListener("change", onChange);
      else q.addListener?.(onChange);
    }
    return () => {
      for (const q of queries) {
        if (q.removeEventListener) q.removeEventListener("change", onChange);
        else q.removeListener?.(onChange);
      }
    };
  }, []);

  // 他ウィンドウ/他タブでの切替も反映する（localStorage の storage イベント）。
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === UI_MODE_OVERRIDE_KEY) setOverrideState(normalizeOverride(e.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setOverride = useCallback((next: UiModeOverride) => {
    setOverrideState(next);
    try {
      if (next === "auto") localStorage.removeItem(UI_MODE_OVERRIDE_KEY);
      else localStorage.setItem(UI_MODE_OVERRIDE_KEY, next);
    } catch {
      /* プライベートモード等で書けなくても、このセッション中は state で効く */
    }
  }, []);

  return {
    deviceClass: classifyDevice(signals),
    uiMode: resolveUiMode(signals, override),
    autoMode: autoUiMode(signals),
    override,
    setOverride,
  };
}
