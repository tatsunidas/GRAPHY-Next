/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 導入の同意画面で「導入する」を押せるかの判定（画面と試験が同じ関数を使う）。
 *
 * backend の `installable` は「この環境で動くか（互換・OS）」だけを表し、署名は含まない。
 * 署名が invalid（改ざん・別の鍵・署名の剥がし・鍵ごとの差し替え）の配布物は、同意しても backend が必ず拒否するので、
 * 押せるようにしておくと「押せるのに必ず失敗する」ことになる。押せない理由は画面に出す（`pluginmgr.consent.sigBlocked`）。
 */
import type { PluginPreview } from "../plugins/pluginManagerApi";

/** 署名が原因で、同意しても導入できないか。 */
export function signatureBlocks(p: Pick<PluginPreview, "signature">): boolean {
  return p.signature === "invalid";
}

/** 「完全性を確認できないことを承知で導入する」の確認が要るか。導入できない配布物には出さない（承知しても入れられない）。 */
export function needsUnverifiedAck(p: Pick<PluginPreview, "integrityVerified" | "installable" | "signature">): boolean {
  return p.installable && !signatureBlocks(p) && !p.integrityVerified;
}

export function canConfirmInstall(
  p: Pick<PluginPreview, "integrityVerified" | "installable" | "signature">,
  ackUnverified: boolean,
  busy: boolean,
): boolean {
  if (busy || !p.installable || signatureBlocks(p)) return false;
  return !needsUnverifiedAck(p) || ackUnverified;
}
