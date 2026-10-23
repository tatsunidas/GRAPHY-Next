/**
 * 手元のサンプルを全部取り込み、シリーズごとにレイアウトと先頭画素の取得を確かめる（API のみ。画面は見ない）。
 * 実行: GRAPHY_AUTOMATOR_HTTP_PORT=18190 GRAPHY_AUTOMATOR_SCP_PORT=18191 GRAPHY_AUTOMATOR_VITE_PORT=18193 \
 *       SAMPLE_PATHS="パス1;パス2;..." npx tsx src/spike/allSamplesCheck.ts
 */
import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";

const PATHS = (process.env.SAMPLE_PATHS ?? "").split(";").filter(Boolean);

async function j(url: string): Promise<{ status: number; body: any }> {
  const r = await fetch(url);
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text.slice(0, 80) }; }
}

async function main(): Promise<void> {
  const driver = new DesktopDriver();
  await driver.start();
  try {
    const base = `http://127.0.0.1:${driver.ports.http}/api`;
    await resetDb(driver.ports.http);
    for (const p of PATHS) {
      const r = await importPaths(driver.ports.http, [p]);
      console.log(`import ${p.split("/").slice(-2).join("/")}: imported=${r.imported} skipped=${r.skipped} failed=${r.failed}`);
    }
    // 取り込み直後はバックフィル・索引が済むのを少し待つ。
    await new Promise((r) => setTimeout(r, 3000));
    const studies = (await j(`${base}/studies`)).body as any[];
    console.log(`\n検査 ${studies.length} 件`);
    let bad = 0;
    for (const st of studies) {
      const series = (await j(`${base}/studies/${st.studyInstanceUid}/series`)).body as any[];
      for (const se of series) {
        const lay = await j(`${base}/studies/${st.studyInstanceUid}/series/${se.seriesInstanceUid}/layout`);
        const insts = (await j(`${base}/studies/${st.studyInstanceUid}/series/${se.seriesInstanceUid}/instances`)).body as any[];
        let pix = "-";
        if (Array.isArray(insts) && insts.length > 0) {
          const r = await fetch(`${base}/instances/${encodeURIComponent(insts[0].sopInstanceUid)}/file`);
          const buf = r.ok ? (await r.arrayBuffer()).byteLength : 0;
          pix = `${r.status}/${buf}B`;
          if (!r.ok || buf === 0) bad++;
        }
        const L = lay.body;
        const ok = lay.status === 200 && L && typeof L === "object";
        if (!ok) bad++;
        const ax = ok && L.axes ? `${L.axes.z?.kind ?? "slice"}/${L.axes.t?.kind ?? "temporal"}/stack=${L.axes.stackAxis}` : "default(z)";
        console.log(
          `${(se.modality ?? "?").padEnd(3)} ${String(se.seriesDescription ?? "—").slice(0, 26).padEnd(26)} SOP=${String(se.numberOfInstances).padStart(3)} 枚数=${String(se.numberOfFrames ?? "?").padStart(4)}` +
          `  layout[${lay.status}] nZ=${L?.nZ} nC=${L?.nC} nT=${L?.nT} cells=${L?.cells?.length}  axes=${ax}  先頭画素=${pix}`,
        );
      }
    }
    console.log(`\n異常（layout が 200 でない・画素が取れない）: ${bad} 件`);
  } finally {
    await driver.stop();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
