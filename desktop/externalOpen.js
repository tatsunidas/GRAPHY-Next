/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 外部（RIS など）から「この検査を開く」を受ける入口の、URL・コマンドライン引数の解釈（main 側の純ロジック）。
// `electron` は import しない（`node --test` が npm install なしで走るため。窓・IPC は main.js が結線する）。
//
// 受け付けるのは `graphynext://open?studyInstanceUid=...` と `--open-study <UID>`（ネットワークは待ち受けない）。
// 🔴 外部入力なので、許可するキーだけを取り、値は厳密な形式でだけ通す。値をパス・コマンド・URL として解釈しない
//    （`..`・`;`・`|` などを含む値は形式で弾かれ、何も開かない）。

const SCHEME = "graphynext";
const UID_RE = /^[0-9.]{1,64}$/;
const DATE_RE = /^\d{8}$/;
const PATIENT_ID_MAX = 64;

/** 制御文字（0x00-0x1F, 0x7F）を含むか。 */
function hasControl(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** UID として正しい形か（数字とドット、64 文字まで。ドットの連続・先頭末尾のドットは不正）。 */
function isUid(v) {
  return typeof v === "string" && UID_RE.test(v) && !v.startsWith(".") && !v.endsWith(".") && !v.includes("..");
}

/**
 * 許可したキーの値を検証して、要求にする。
 * @param {{studyInstanceUid?: string, seriesInstanceUid?: string, patientId?: string, studyDate?: string}} raw
 * @returns {{ok:true, req:object}|{ok:false, reason:string}}
 */
function validate(raw) {
  const req = {};
  const { studyInstanceUid, seriesInstanceUid, patientId, studyDate } = raw;
  const hasStudy = studyInstanceUid !== undefined;
  const hasPatient = patientId !== undefined;
  if (!hasStudy && !hasPatient) {
    return { ok: false, reason: "検査を指定してください（studyInstanceUid、または patientId と studyDate）。" };
  }
  if (hasStudy) {
    if (!isUid(studyInstanceUid)) return { ok: false, reason: "studyInstanceUid の形式が正しくありません（数字とドットで 64 文字まで）。" };
    req.studyInstanceUid = studyInstanceUid;
  }
  if (seriesInstanceUid !== undefined) {
    if (!isUid(seriesInstanceUid)) return { ok: false, reason: "seriesInstanceUid の形式が正しくありません（数字とドットで 64 文字まで）。" };
    if (!hasStudy) return { ok: false, reason: "seriesInstanceUid を使うときは studyInstanceUid も指定してください。" };
    req.seriesInstanceUid = seriesInstanceUid;
  }
  if (hasPatient) {
    if (typeof patientId !== "string" || patientId.length < 1 || patientId.length > PATIENT_ID_MAX || hasControl(patientId)) {
      return { ok: false, reason: `patientId の形式が正しくありません（1〜${PATIENT_ID_MAX} 文字、制御文字なし）。` };
    }
    req.patientId = patientId;
  }
  if (studyDate !== undefined) {
    if (typeof studyDate !== "string" || !DATE_RE.test(studyDate) || !validYmd(studyDate)) {
      return { ok: false, reason: "studyDate の形式が正しくありません（YYYYMMDD の実在の日付）。" };
    }
    req.studyDate = studyDate;
  }
  if (!hasStudy && req.studyDate === undefined) {
    return { ok: false, reason: "patientId で指定するときは studyDate（YYYYMMDD）も指定してください。" };
  }
  return { ok: true, req };
}

function validYmd(s) {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d));
  return y >= 1900 && dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * `graphynext://open?...` を解釈する。スキーム・ホスト（open）が違うものは対象外（null）。
 * 許可していないキーは無視する（理由は付けない）。同じキーが複数あれば不正。
 * @returns {null|{ok:true, req:object}|{ok:false, reason:string}}
 */
function parseUrl(arg) {
  if (typeof arg !== "string") return null;
  if (!arg.toLowerCase().startsWith(`${SCHEME}:`)) return null;
  let u;
  try {
    u = new URL(arg);
  } catch {
    return { ok: false, reason: "URL を解釈できません。" };
  }
  if (u.hostname.toLowerCase() !== "open") return { ok: false, reason: "対応していない操作です（graphynext://open だけが使えます）。" };
  const raw = {};
  for (const key of ["studyInstanceUid", "seriesInstanceUid", "patientId", "studyDate"]) {
    const all = u.searchParams.getAll(key);
    if (all.length > 1) return { ok: false, reason: `${key} が複数指定されています。` };
    if (all.length === 1) raw[key] = all[0];
  }
  return validate(raw);
}

/**
 * コマンドライン引数（`--open-study=<UID>` と、任意の `--open-series=<UID>`）と、`graphynext://` の URL 引数を探す。
 * 該当が無ければ null（普通の起動）。URL 引数が先にあればそれを使う。
 *
 * 🔴 値は `=` でつなぐ形（`--open-study=<UID>`）を正とする。Chromium は 2 つ目の起動の引数を並べ替え、
 *    スイッチに続く値（`--open-study <UID>` の UID）を引数の末尾へ移すため、空白区切りでは値を取り違える（実測: Linux）。
 *    空白区切りは、直後が別のスイッチでないときだけ受ける（並べ替えられていない起動の救済）。
 * @param {string[]} argv
 */
function parseArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (const a of argv) {
    const r = parseUrl(a);
    if (r) return r;
  }
  const flag = (name) => {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (typeof a !== "string") continue;
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      if (a === name) {
        const next = argv[i + 1];
        return typeof next === "string" && !next.startsWith("--") ? next : "";
      }
    }
    return undefined;
  };
  const study = flag("--open-study");
  if (study === undefined) return null;
  const raw = { studyInstanceUid: study };
  const series = flag("--open-series");
  if (series !== undefined) raw.seriesInstanceUid = series;
  return validate(raw);
}

module.exports = { SCHEME, isUid, validate, parseUrl, parseArgv };
