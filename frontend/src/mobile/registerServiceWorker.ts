/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * モバイルシェル用の Service Worker 登録（アプリ本体のオフライン起動。患者データは扱わない）。
 *
 * <p>Electron（file://）では SW を登録できないので、http(s) のときだけ登録する。呼び出し元の
 * `MobileScreen` はモバイルシェルでだけ描画されるので、「web かつモバイルシェル」の条件はそれで満たす。
 */

/** SW を登録してよい環境か（file:// や SW 非対応のブラウザを除く）。 */
export function canRegisterServiceWorker(nav: { serviceWorker?: unknown }, protocol: string): boolean {
  return "serviceWorker" in nav && (protocol === "http:" || protocol === "https:");
}

/**
 * @param onUpdate 既に SW に制御されている画面で、新しい版の SW が有効になったとき（初回の導入では呼ばない）。
 * @returns 登録の取り消し（リスナーの解除）。
 */
export function registerServiceWorker(onUpdate: () => void): () => void {
  if (!canRegisterServiceWorker(navigator, window.location.protocol)) return () => {};
  const hadController = !!navigator.serviceWorker.controller;
  const onChange = () => {
    if (hadController) onUpdate();
  };
  navigator.serviceWorker.addEventListener("controllerchange", onChange);
  navigator.serviceWorker.register("./sw.js").catch((e) => {
    console.warn("Service Worker の登録に失敗しました", e);
  });
  return () => navigator.serviceWorker.removeEventListener("controllerchange", onChange);
}
