/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 設定画面を、特定のカテゴリを開いた状態で呼び出すための窓口。
// 設定ダイアログは App が持っている（ショートカット Mod+, と同じ経路）ので、別画面
// （3D ビューア等）からは App へ window イベントで頼む。

const EVENT = "graphy:open-settings";

/** 設定画面を開く。`categoryId` を渡すとそのカテゴリを選んだ状態で開く。 */
export function requestOpenSettings(categoryId?: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { categoryId } }));
}

/** {@link requestOpenSettings} を受ける。戻り値は購読解除。 */
export function onOpenSettingsRequest(handler: (categoryId: string | undefined) => void): () => void {
  const listener = (e: Event) => {
    const id = (e as CustomEvent<{ categoryId?: string }>).detail?.categoryId;
    handler(typeof id === "string" ? id : undefined);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
