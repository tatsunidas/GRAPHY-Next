/*
 * 実機検証用プラグイン（H40・権限なし）。
 *
 * plugin.json に ai-egress を宣言していない。**同意ダイアログを出す前に** permission-denied で
 * 弾かれることを確かめる（宣言の無いプラグインには送信経路を渡さない）。
 *
 * 結果は window.__aiEgressDenied に置く（page.evaluate で読む）。
 */
export async function activate(host) {
  window.__aiEgressDenied = { started: true, pluginId: host.pluginId, hasAi: !!(host.ai && host.ai.generate), hasFile: !!(host.file && host.file.saveAs) };

  if (!host.ai || !host.ai.generate) {
    window.__aiEgressDenied.outcome = { ok: false, error: "no-host-ai" };
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
  window.__aiEgressDenied.pending = true;
  const outcome = await promise;
  window.__aiEgressDenied.pending = false;
  window.__aiEgressDenied.outcome = outcome;
}
