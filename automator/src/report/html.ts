import { countStatuses, type FeatureReport, type ModeReport, type StatusCounts, type SubStatus } from "./collect.js";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

const STATUS_CLASS: Record<SubStatus, string> = {
  自動PASS: "pass",
  要人間確認: "human",
  FAIL: "fail",
  未着手: "todo",
};

const STATUS_ORDER: SubStatus[] = ["FAIL", "要人間確認", "自動PASS", "未着手"];

function badge(status: SubStatus): string {
  return `<span class="badge ${STATUS_CLASS[status]}">${esc(status)}</span>`;
}

function summaryBar(c: StatusCounts): string {
  const seg = (label: SubStatus, n: number) =>
    n > 0 ? `<div class="seg ${STATUS_CLASS[label]}" style="flex:${n}" title="${esc(label)}: ${n}"></div>` : "";
  const done = c.自動PASS + c.要人間確認;
  const pct = c.total > 0 ? Math.round((done / c.total) * 100) : 0;
  return `
    <div class="bar">
      ${seg("FAIL", c.FAIL)}${seg("要人間確認", c.要人間確認)}${seg("自動PASS", c.自動PASS)}${seg("未着手", c.未着手)}
    </div>
    <div class="counts">
      <span class="badge pass">自動PASS ${c.自動PASS}</span>
      <span class="badge human">要人間確認 ${c.要人間確認}</span>
      <span class="badge fail">FAIL ${c.FAIL}</span>
      <span class="badge todo">未着手 ${c.未着手}</span>
      <span class="total">計 ${c.total} 項目 / 検証着手率 ${pct}%</span>
    </div>`;
}

function featureCard(f: FeatureReport): string {
  const c = countStatuses([f]);
  const rows = f.items
    .map(
      (it) => `
        <tr class="${STATUS_CLASS[it.status]}-row">
          <td class="num">${it.n}</td>
          <td>${esc(it.title)}</td>
          <td class="st">${badge(it.status)}</td>
          <td class="date">${esc(it.lastRun || "—")}</td>
        </tr>`,
    )
    .join("");
  const src = f.source ? `<span class="src">${esc(f.source)}</span>` : "";
  return `
    <section class="feature">
      <h3>${esc(f.title)} ${src}</h3>
      <div class="mini">${summaryBar(c)}</div>
      <table>
        <thead><tr><th>#</th><th>小項目</th><th>状態</th><th>最終実行</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function modeSection(r: ModeReport, active: boolean): string {
  const c = countStatuses(r.features);
  const cards = r.features.map(featureCard).join("");
  const body =
    r.features.length > 0
      ? cards
      : `<p class="empty">（${esc(r.mode)} モードのチェックリストはまだありません）</p>`;
  return `
    <div class="mode-section" id="panel-${esc(r.mode)}" role="tabpanel"${active ? "" : " hidden"}>
      <div class="overall">${summaryBar(c)}</div>
      ${body}
    </div>`;
}

function tabButton(r: ModeReport, active: boolean): string {
  const c = countStatuses(r.features);
  const done = c.自動PASS + c.要人間確認;
  return `<button class="tab" role="tab" data-mode="${esc(r.mode)}" aria-selected="${active}"${active ? "" : ""}>` +
    `<span class="tab-name">${esc(r.mode)}</span>` +
    `<span class="tab-count">${done}/${c.total}</span>` +
    `</button>`;
}

/** モード別レポートを 1 枚の自己完結 HTML に描画する。generatedAt は呼び出し側で確定した文字列。 */
export function renderReport(reports: ModeReport[], generatedAt: string): string {
  const tabs = reports.map((r, i) => tabButton(r, i === 0)).join("");
  const sections = reports.map((r, i) => modeSection(r, i === 0)).join("");
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GRAPHY-Next 検証レポート</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, "Segoe UI", "Hiragino Sans", Meiryo, sans-serif; margin: 0; background: #f6f7f9; color: #1c2126; }
  @media (prefers-color-scheme: dark) { body { background: #14171a; color: #e6e9ec; } }
  header { padding: 20px 28px; border-bottom: 1px solid #d5d9dd; }
  header h1 { margin: 0 0 4px; font-size: 20px; }
  header .meta { color: #7a838c; font-size: 13px; }
  .tabs { display: flex; gap: 4px; padding: 0 28px; border-bottom: 1px solid #d5d9dd; background: #eef1f4; }
  @media (prefers-color-scheme: dark) { .tabs { background: #1a1e22; border-color: #2c333a; } }
  .tab { display: flex; align-items: center; gap: 8px; border: none; background: transparent; cursor: pointer;
    padding: 12px 18px; font-size: 14px; font-weight: 600; color: #6a737c; border-bottom: 2px solid transparent;
    margin-bottom: -1px; text-transform: capitalize; font-family: inherit; }
  .tab:hover { color: #1c2126; }
  @media (prefers-color-scheme: dark) { .tab:hover { color: #e6e9ec; } }
  .tab[aria-selected="true"] { color: #2563c9; border-bottom-color: #2563c9; }
  @media (prefers-color-scheme: dark) { .tab[aria-selected="true"] { color: #6ba4ff; border-bottom-color: #6ba4ff; } }
  .tab-count { font-size: 12px; font-weight: 600; color: #8a929a; background: #dfe4e9; border-radius: 999px; padding: 1px 8px; }
  @media (prefers-color-scheme: dark) { .tab-count { background: #2c333a; color: #9aa2aa; } }
  .mode-section { padding: 18px 28px 28px; }
  .mode-section[hidden] { display: none; }
  .overall { margin-bottom: 16px; }
  .feature { background: #fff; border: 1px solid #e2e6ea; border-radius: 10px; padding: 14px 16px; margin: 12px 0; }
  @media (prefers-color-scheme: dark) { .feature { background: #1d2126; border-color: #2c333a; } }
  .feature h3 { margin: 0 0 8px; font-size: 15px; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .src { font-weight: 400; font-size: 12px; color: #8a929a; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eceff2; }
  @media (prefers-color-scheme: dark) { th, td { border-color: #262c32; } }
  th { color: #7a838c; font-weight: 600; font-size: 12px; }
  td.num { color: #9aa2aa; width: 28px; }
  td.st { width: 96px; }
  td.date { width: 96px; color: #8a929a; white-space: nowrap; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .badge.pass { background: #dff5e3; color: #1a7f3c; }
  .badge.human { background: #fff2d6; color: #9a6b00; }
  .badge.fail { background: #fde0e0; color: #c02626; }
  .badge.todo { background: #e9edf1; color: #78828c; }
  @media (prefers-color-scheme: dark) {
    .badge.pass { background: #123a20; color: #64d68a; }
    .badge.human { background: #3d2f0a; color: #ecc25b; }
    .badge.fail { background: #3d1717; color: #f08a8a; }
    .badge.todo { background: #262c32; color: #9aa2aa; }
  }
  .bar { display: flex; height: 10px; border-radius: 6px; overflow: hidden; background: #e9edf1; margin-bottom: 8px; }
  @media (prefers-color-scheme: dark) { .bar { background: #262c32; } }
  .seg.pass { background: #2fae57; } .seg.human { background: #e0a72e; }
  .seg.fail { background: #d93b3b; } .seg.todo { background: #c3cbd2; }
  @media (prefers-color-scheme: dark) { .seg.todo { background: #3a424a; } }
  .counts { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12px; }
  .counts .total { color: #7a838c; margin-left: auto; }
  .mini .bar { height: 6px; }
  .mini .counts { display: none; }
  .empty { color: #8a929a; font-style: italic; }
  .fail-row td:first-child { box-shadow: inset 3px 0 0 #d93b3b; }
</style>
</head>
<body>
<header>
  <h1>GRAPHY-Next 検証レポート</h1>
  <div class="meta">生成: ${esc(generatedAt)} ・ automator report</div>
</header>
<div class="tabs" role="tablist">${tabs}</div>
${sections}
<script>
  (function () {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
    function activate(mode) {
      tabs.forEach(function (t) {
        var on = t.getAttribute('data-mode') === mode;
        t.setAttribute('aria-selected', String(on));
      });
      document.querySelectorAll('.mode-section').forEach(function (p) {
        p.hidden = p.id !== 'panel-' + mode;
      });
    }
    tabs.forEach(function (t) {
      t.addEventListener('click', function () { activate(t.getAttribute('data-mode')); });
    });
  })();
</script>
</body>
</html>`;
}
