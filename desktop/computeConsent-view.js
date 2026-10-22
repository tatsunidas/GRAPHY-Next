// 同意画面の表示（computeConsent.html）。文字列は textContent で入れる（HTML として解釈しない）。
const $ = (id) => document.getElementById(id);
const fmt = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
const size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? (n / 1024).toFixed(1) + " KB" : n + " B");
window.graphyConsent.onShow(({ detail, strings: s }) => {
  const local = detail.endpointKind === "local";
  document.title = local ? s.titleLocal : s.title;
  $("title").textContent = local ? s.titleLocal : s.title;
  $("lead").textContent = fmt(local ? s.leadLocal : s.lead, { plugin: detail.pluginName });
  $("k-dest").textContent = s.destination;
  $("dest-label").textContent = local ? s.thisPc : detail.endpointLabel;
  $("dest-url").textContent = detail.endpointUrl;
  // 127.0.0.1 の http は暗号化の話ではない（外へ出ない）。代わりに「コードはこの PC で動く」を言い切らずに出す
  const localOnly = (detail.datasets || []).concat((detail.items || []).flatMap((it) => it.datasets || [])).some((d) => d.localOnly);
  if (local) { $("plaintext").hidden = false; $("plaintext").textContent = localOnly ? s.localNote + " " + s.localBurnNote : s.localNote; }
  else if (detail.plaintext) { $("plaintext").hidden = false; $("plaintext").textContent = s.plaintext; }
  // 再実行: 毎回の同意に加えて、記録の版と今の版を見せる（違えば記録のコードで走ることを言う）
  const note = window.graphyConsentRows.rerunNotice(detail);
  if (note) {
    $("rerun").hidden = false;
    const vars = { n: note.attempt, recorded: note.recorded ?? s.unknown, current: note.current ?? s.unknown };
    $("rerun").textContent = note.changed ? fmt(s.rerunChanged, vars) : fmt(s.rerunSame, vars);
  }
  $("k-anon").textContent = s.anonymization;
  $("anon").textContent = detail.anonymization;
  $("k-data").textContent = s.datasets;
  const view = window.graphyConsentRows.buildRows(detail);
  // 一括（組あり）は先頭に「組」の列を足す。対話の 1 回は今までと同じ 6 列
  const cols = (view.batch ? [s.colKey] : []).concat([s.colModality, s.colInstances, s.colFormat, s.colSize, s.colBurned, s.colSha]);
  for (const h of cols) {
    const th = document.createElement("th"); th.textContent = h; $("data-head").appendChild(th);
  }
  if (view.batch) {
    $("data-summary").hidden = false;
    $("data-summary").textContent = fmt(s.batchSummary, { items: view.itemCount, datasets: view.datasetCount, size: size(view.totalBytes) });
  }
  if (view.rows.length === 0) {
    const tr = document.createElement("tr"); const td = document.createElement("td");
    td.colSpan = cols.length; td.textContent = s.noData; tr.appendChild(td); $("data-body").appendChild(tr);
  }
  for (const row of view.rows) {
    const tr = document.createElement("tr");
    const cells = [];
    if (view.batch) cells.push({ v: row.key });
    if (row.noInput) {
      cells.push({ v: s.noInputItem, span: 6 });
    } else {
      const d = row.d;
      for (const v of [d.modality ?? "?", d.instances, d.format, size(d.bytes), d.burnedInstances, d.sha256]) {
        cells.push({ v, mono: v === d.sha256 });
      }
    }
    for (const c of cells) {
      const td = document.createElement("td"); td.textContent = String(c.v);
      if (c.mono) td.className = "mono";
      if (c.span) td.colSpan = c.span;
      tr.appendChild(td);
    }
    $("data-body").appendChild(tr);
  }
  // 送れずに外した組（黙って減らさない）
  if (view.refused.length > 0) {
    $("refused").hidden = false;
    $("k-refused").textContent = fmt(s.refusedTitle, { n: view.refused.length });
    for (const r of view.refused) {
      const li = document.createElement("li"); li.textContent = r.key + " — " + r.reason; $("refused-list").appendChild(li);
    }
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
