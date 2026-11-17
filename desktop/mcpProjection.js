// MCP のツールが返す内容の射影（患者情報を伏せる）。設計: roadmap fw/mcp-server-design.md §5。electron に依存しない純モジュール。
//
// 🔴 `includePhi=false` のときは**許可リスト**で組み直す（除外リストは漏れる）。許可リストに無い項目は、入力に付いて来ても出ない。
// 🔴 最後に `guard` が、この接続で通った患者の識別値（氏名・ID など）が出力に残っていないかを文字列で確かめ、残っていたら例外にする。
//    射影の書き漏れに対する二重の備え。応答を返す前に必ず通す。
// UID は不透明な札（`st_…` など）にする。札は鍵つきの HMAC で、鍵は接続（起動）ごとに作る。クライアントが生の UID を渡しても解決しない。
// 自由記述（SeriesDescription・アルバム名など）は氏名が入り得るので、`includePhi=false` では返さない。
const crypto = require("node:crypto");

const UID_RE = /^[0-9]+(\.[0-9]+){3,}$/;
const MAX_STRING = 512;
const MAX_DEPTH = 8;
const PREFIX = { study: "st", series: "se", instance: "so", uid: "ui" };

/** 患者を特定し得るキー（深い構造を通すときに落とす）。小文字で比較。 */
const PHI_KEYS = new Set(
  ["patientname", "patientid", "patientkey", "patientbirthdate", "patientsex", "patientage", "accessionnumber", "referringphysician", "referringphysicianname", "otherpatientids", "institutionname", "operatorsname", "performingphysicianname", "studydate", "studytime", "seriesdate", "acquisitiondate", "contentdate", "seriesdescription", "studydescription", "serieslabel", "label", "name"],
);

/** 患者情報を含まないタグの許可リスト（group+element の 8 桁・大文字）。技術的な撮像条件だけ。 */
const SAFE_TAGS = new Set([
  "00020010", "00080016", "00080060", "00080070", "00081090", "00180050", "00180060", "00180080", "00180081", "00180087", "00180088",
  "00200011", "00200013", "00200032", "00200037", "00280002", "00280004", "00280008", "00280010", "00280011", "00280030", "00280100", "00280101", "00280102", "00280103",
  "00281050", "00281051", "00281052", "00281053",
]);

const natural = (v) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const cap = (s) => (typeof s === "string" && s.length > MAX_STRING ? s.slice(0, MAX_STRING) : s);

function createProjector({ includePhi, key = crypto.randomBytes(32) }) {
  const phi = includePhi === true;
  const toUid = new Map(); // 札 → 生の UID
  const subjects = new Map(); // patientId → S001…
  const seen = new Set(); // 通った患者の識別値（guard 用）

  function note(v) {
    if (typeof v === "string" && v.trim().length >= 3) seen.add(v.trim());
  }

  /** UID を外へ出す形にする。患者情報あり→そのまま、なし→札。 */
  function ref(kind, uid) {
    if (typeof uid !== "string" || uid === "") return null;
    if (phi) return uid;
    const p = PREFIX[kind] ?? PREFIX.uid;
    const h = `${p}_${crypto.createHmac("sha256", key).update(`${kind}\u0000${uid}`).digest("hex").slice(0, 16)}`;
    toUid.set(h, uid);
    return h;
  }

  /** クライアントから来た値を生の UID に戻す。解決できなければ null。 */
  function resolve(kind, v) {
    if (typeof v !== "string") return null;
    if (phi) return UID_RE.test(v) && v.length <= 64 ? v : null;
    return toUid.get(v) ?? null;
  }

  function subject(patientId) {
    if (typeof patientId !== "string" || patientId === "") return null;
    if (!subjects.has(patientId)) subjects.set(patientId, `S${String(subjects.size + 1).padStart(3, "0")}`);
    return subjects.get(patientId);
  }

  function observe(o) {
    if (!o || typeof o !== "object") return;
    for (const k of ["patientId", "patientName", "patientBirthDate", "accessionNumber", "patientKey", "referringPhysicianName"]) note(o[k]);
  }

  function study(d) {
    observe(d);
    const out = {
      study: ref("study", d.studyInstanceUid),
      modality: d.modality ?? null,
      modalities: Array.isArray(d.modalities) ? d.modalities.filter((m) => typeof m === "string").slice(0, 16) : [],
      numberOfInstances: natural(d.numberOfInstances),
      numberOfFrames: natural(d.numberOfFrames),
    };
    if (phi) return { ...out, patientId: d.patientId ?? null, patientName: d.patientName ?? null, studyDate: d.studyDate ?? null, studyDescription: cap(d.studyDescription) ?? null };
    return { ...out, subject: subject(d.patientId) };
  }

  function series(d) {
    const out = {
      series: ref("series", d.seriesInstanceUid),
      modality: d.modality ?? null,
      seriesNumber: natural(d.seriesNumber),
      sopClassUid: d.sopClassUid ?? null,
      numberOfInstances: natural(d.numberOfInstances),
      numberOfFrames: natural(d.numberOfFrames),
    };
    return phi ? { ...out, seriesDescription: cap(d.seriesDescription) ?? null } : out;
  }

  function instance(d) {
    return { instance: ref("instance", d.sopInstanceUid), instanceNumber: natural(d.instanceNumber), sopClassUid: d.sopClassUid ?? null, transferSyntaxUid: d.transferSyntaxUid ?? null };
  }

  function album(d) {
    const out = { id: natural(d.id), count: natural(d.count) };
    return phi ? { ...out, name: cap(d.name) ?? null, createdAt: d.createdAt ?? null } : out;
  }

  /** タグのダンプ。深さ 0 だけ（シーケンスの中は患者情報があり得る）。患者情報なしでは許可リストのタグだけ。 */
  function tags(rows) {
    const out = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || r.depth !== 0) continue;
      const tag = String(r.tag ?? "").replace(/[(),\s]/g, "").toUpperCase();
      if (!phi && !SAFE_TAGS.has(tag)) {
        continue;
      }
      if (phi && /^(7FE0|0020000D|0020000E)/.test(tag)) continue; // 画素データはここで返さない
      out.push({ tag, name: r.name ?? null, vr: r.vr ?? null, value: cap(String(r.value ?? "")) });
    }
    return out;
  }

  /** 形が確かでない構造（radiomics の結果・compute のジョブなど）。伏せる側では、患者キーを落とし UID を札にする。 */
  function deep(v, depth = 0) {
    if (depth > MAX_DEPTH) return null;
    if (typeof v === "string") {
      if (phi) return cap(v);
      return UID_RE.test(v) && v.length <= 64 ? ref("uid", v) : cap(v);
    }
    if (Array.isArray(v)) return v.slice(0, 500).map((x) => deep(x, depth + 1));
    if (v && typeof v === "object") {
      observe(v);
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        if (!phi && PHI_KEYS.has(k.toLowerCase())) continue;
        o[k] = deep(x, depth + 1);
      }
      return o;
    }
    return v;
  }

  /** 出力に、通った患者の識別値が残っていないか。残っていたら例外（返さない）。 */
  function guard(out) {
    if (phi) return out;
    const s = JSON.stringify(out);
    for (const v of seen) if (s.includes(v)) throw new Error("phi-leak");
    return out;
  }

  return { includePhi: phi, ref, resolve, observe, study, series, instance, album, tags, deep, guard, subject };
}

module.exports = { createProjector, SAFE_TAGS, PHI_KEYS, UID_RE };
