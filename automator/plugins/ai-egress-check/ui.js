/*
 * 実機検証用プラグイン（H40・権限あり）。
 *
 * host.ai.generate() を呼ぶ。鍵が未設定なら同意を求める前に no-api-key で返るはずで、
 * 鍵があれば**同意ダイアログが出て止まる**はず。automator はどちらの状態も検証する。
 * 実際に Gemini を叩くところまでは行かない（課金と外部依存を自動検証に持ち込まない）。
 *
 * 結果は window.__aiEgressCheck に置く（page.evaluate で読む）。
 */
export async function activate(host) {
  window.__aiEgressCheck = { started: true, pluginId: host.pluginId, hasAi: !!(host.ai && host.ai.generate), hasFile: !!(host.file && host.file.saveAs) };

  if (!host.ai || !host.ai.generate) {
    window.__aiEgressCheck.outcome = { ok: false, error: "no-host-ai" };
    return;
  }
  const target = host.getTargets()[0];
  // 中身は何でもよい。ここで見たいのはゲートの挙動だけ。
  const promise = host.ai.generate({
    model: "gemini-3.1-flash-image",
    prompt: "AUTOMATOR PROBE — this must never be sent without consent.",
    imageBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    mimeType: "image/png",
    scopeKey: target ? target.seriesUid : undefined,
  });
  window.__aiEgressCheck.pending = true;
  const outcome = await promise;
  window.__aiEgressCheck.pending = false;
  window.__aiEgressCheck.outcome = outcome;
}
