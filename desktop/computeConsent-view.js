// 同意画面の表示（computeConsent.html）。文字列は textContent で入れる（HTML として解釈しない）。
const $ = (id) => document.getElementById(id);
const fmt = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
const size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? (n / 1024).toFixed(1) + " KB" : n + " B");
window.graphyConsent.onShow(({ detail, strings: s }) => {
  document.title = s.title;
  $("title").textContent = s.title;
  $("lead").textContent = fmt(s.lead, { plugin: detail.pluginName });
  $("k-dest").textContent = s.destination;
  $("dest-label").textContent = detail.endpointLabel;
  $("dest-url").textContent = detail.endpointUrl;
  if (detail.plaintext) { $("plaintext").hidden = false; $("plaintext").textContent = s.plaintext; }
  $("k-anon").textContent = s.anonymization;
  $("anon").textContent = detail.anonymization;
  $("k-data").textContent = s.datasets;
  for (const h of [s.colModality, s.colInstances, s.colFormat, s.colSize, s.colBurned, s.colSha]) {
    const th = document.createElement("th"); th.textContent = h; $("data-head").appendChild(th);
  }
  for (const d of detail.datasets) {
    const tr = document.createElement("tr");
    for (const v of [d.modality ?? "?", d.instances, d.format, size(d.bytes), d.burnedInstances, d.sha256]) {
      const td = document.createElement("td"); td.textContent = String(v);
      if (v === d.sha256) td.className = "mono";
      tr.appendChild(td);
    }
    $("data-body").appendChild(tr);
  }
  $("k-code").textContent = s.code;
  $("code").textContent = detail.code;
  $("code-meta").textContent = fmt(s.codeMeta, { lines: detail.code.split("\n").length, sha: detail.codeSha256 });
  $("ack-text").textContent = s.ack;
  $("send").textContent = s.send;
  $("cancel").textContent = s.cancel;
  $("ack").addEventListener("change", () => { $("send").disabled = !$("ack").checked; });
  $("send").addEventListener("click", () => { if ($("ack").checked) window.graphyConsent.decide(true); });
  $("cancel").addEventListener("click", () => window.graphyConsent.decide(false));
  $("cancel").focus();
});
