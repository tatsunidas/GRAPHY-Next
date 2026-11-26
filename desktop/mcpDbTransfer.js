// 外部 AI クライアント（MCP）からの、検査のコピー（別の PC へ運ぶ荷物の書き出し）と荷物の取り込み。設計: roadmap fw/mcp-server-design.md。
//
// 🔴 AI ができるのは「依頼」と「状況の確認」だけ。実行の許可とフォルダの選択は、利用者が main のダイアログで行う。
//    フォルダの場所は AI に返さない。書き出しは **コピーだけ**（移動を表す引数もコードも持たない）。
// 依頼はすぐ jobId を返し、裏で進める（利用者の応答と大きな検査のコピーは、呼び出しの打ち切りより長い）。ジョブは同時に 1 件。
// electron に依存しない（ダイアログ・backend は呼ぶ側が渡す）。
const crypto = require("node:crypto");
const { oneLine } = require("./mcpAudit");
const { CONFIRM_TIMEOUT_MS } = require("./mcpConfirm");

const JOB_ID_RE = /^dbj_[0-9a-f]{32}$/;
/** 確認の文面に 1 件ずつ並べる検査の数（超えた分は件数で示す。ダイアログが画面からはみ出さないための表示の都合）。 */
const LISTED_STUDIES = 12;
/** 取り込みの状況を backend に聞く間隔と、待つ上限（画面のコピーの打ち切りと同じ 60 分）。 */
const POLL_MS = 2000;
const WAIT_LIMIT_MS = 60 * 60 * 1000;

const ACTIVE = new Set(["awaiting-user", "running"]);

function studyLine(s) {
  const f = (v, n) => oneLine(v, n) || "—";
  return `・${f(s.patientId, 40)} ${f(s.patientName, 40)} ／ ${f(s.studyDate, 10)} ${f(s.modality, 8)} ${oneLine(s.studyDescription, 40)}（${Number(s.numberOfInstances) || 0} 枚）`;
}

/** 検査を持ち出す前の確認の文面。患者の情報を出すのは、利用者が読むこのダイアログだけ。 */
function copyConfirmText(client, studies) {
  const patients = new Set(studies.map((s) => `${s.patientId ?? ""}\u0000${s.patientName ?? ""}`)).size;
  const lines = studies.slice(0, LISTED_STUDIES).map(studyLine);
  if (studies.length > LISTED_STUDIES) lines.push(`ほか ${studies.length - LISTED_STUDIES} 件`);
  return {
    message: `外部 AI クライアント「${oneLine(client, 64)}」が、検査 ${studies.length} 件（患者 ${patients} 人）を、この PC の別のフォルダ（外付けドライブなど）へコピーするよう求めています。`,
    detail: `${lines.join("\n")}\n\nコピーする DICOM には患者情報が含まれます。ROI・レポート・プラグインの記録も一緒に書き出し、書き出し先は暗号化されません。` +
      "移し元のデータは消しません。続けると、書き出し先のフォルダを選ぶ画面が出ます。心当たりがなければ［取り消す］を選んでください（答えなければ取り消し）。\nクライアント名は相手の自己申告で、確認できません。",
  };
}

function importRequestText(client) {
  return {
    message: `外部 AI クライアント「${oneLine(client, 64)}」が、外付けドライブなどの荷物を、今の DB に取り込むよう求めています。`,
    detail: "続けると、荷物のあるフォルダを選ぶ画面が出ます。中身を確認してから取り込みます。今の DB にあるデータは上書きしません。心当たりがなければ［取り消す］を選んでください（答えなければ取り消し）。\nクライアント名は相手の自己申告で、確認できません。",
  };
}

/**
 * @param deps {
 *   describeStudies(uids): Promise<object[]|null>,        // 利用者に見せる検査の情報（見つからないものがあれば null）
 *   ask(options, {timeoutMs}): Promise<{response:number}>,// 確認ダイアログ（mcpConfirm の待ち行列）
 *   pickTargetDirectory(): Promise<string|null>,
 *   validateTarget(path): {ok:boolean, folder?:string, reason?:string},
 *   copy(uids, folder): Promise<{ok:true, body:object}|{ok:false, reason:string}>,
 *   importFlow: {start(overrides), status(jobId)},        // dbImportFlow
 *   audit(record): void,
 *   sleep?(ms), now?(), newId?()
 * }
 */
function createMcpDbTransfer(deps) {
  const jobs = new Map();
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || Date.now;
  const newId = deps.newId || (() => `dbj_${crypto.randomBytes(16).toString("hex")}`);

  const busy = () => [...jobs.values()].some((j) => ACTIVE.has(j.state));

  function submit(kind, client, run, extra = {}) {
    if (busy()) return { ok: false, error: "busy" };
    const job = { jobId: newId(), kind, client, state: "awaiting-user", ...extra };
    jobs.set(job.jobId, job);
    job.finished = Promise.resolve()
      .then(() => run(job))
      .catch(() => finish(job, "failed", "internal"))
      .then(() => {
        const outcome = job.state === "failed" ? `failed-${job.error}`.slice(0, 40) : job.state;
        deps.audit({ event: kind === "copy" ? "db-copy" : "db-import", client, outcome, bytes: job.bytes ?? null, includePhi: false });
      });
    return { ok: true, data: view(job) };
  }

  function finish(job, state, error) {
    job.state = state;
    if (error) job.error = /^[a-z0-9-]{1,32}$/.test(error) ? error : "other";
  }

  async function agreed(client, text, label) {
    const r = await deps.ask(
      { type: "warning", buttons: [label, "取り消す"], defaultId: 1, cancelId: 1, title: "外部 AI クライアントの操作の確認", message: text.message, detail: text.detail },
      { timeoutMs: CONFIRM_TIMEOUT_MS },
    );
    return r.response === 0;
  }

  function submitCopy(client, studyUids) {
    return submit("copy", client, async (job) => {
      const studies = await deps.describeStudies(studyUids);
      if (!studies) return finish(job, "failed", "study-not-found");
      if (!(await agreed(client, copyConfirmText(client, studies), "書き出し先を選ぶ"))) return finish(job, "declined");
      const picked = await deps.pickTargetDirectory();
      if (!picked) return finish(job, "declined");
      const target = deps.validateTarget(picked);
      if (!target.ok) return finish(job, "failed", `target-${target.reason}`);
      job.state = "running";
      const r = await deps.copy(studyUids, target.folder);
      if (!r.ok) return r.reason === "timeout" ? finish(job, "timeout") : finish(job, "failed", r.reason);
      job.files = r.body.files;
      job.bytes = r.body.bytes;
      job.plugins = r.body.pluginVersions || [];
      return finish(job, "done");
    }, { studyUids });
  }

  function submitImport(client) {
    return submit("import", client, async (job) => {
      if (!(await agreed(client, importRequestText(client), "取り込み元を選ぶ"))) return finish(job, "declined");
      const started = await deps.importFlow.start({
        ja: true, // MCP の確認ダイアログは日本語なので、要約も合わせる
        confirm: async (detail) => agreed(client, { message: `この荷物を今の DB に取り込みますか？（外部 AI クライアント「${oneLine(client, 64)}」の依頼）`, detail }, "取り込む"),
      });
      if (!started.ok) return started.canceled ? finish(job, "declined") : finish(job, "failed", started.reason);
      job.state = "running";
      const until = now() + WAIT_LIMIT_MS;
      for (;;) {
        const s = await deps.importFlow.status(started.jobId);
        if (!s.ok) return finish(job, "failed", s.reason);
        job.packages = s.packages;
        if (s.state !== "running") {
          job.studyUids = s.studyUids;
          return finish(job, s.state === "done" ? "done" : "failed", s.state === "done" ? undefined : "import-stopped");
        }
        if (now() > until) return finish(job, "timeout");
        await sleep(POLL_MS);
      }
    });
  }

  /** AI に返す形に組み立てる前の内部の値（クライアント名と完了の待ち口は出さない）。 */
  function view(job) {
    const { client, finished, ...rest } = job;
    return { ...rest };
  }

  function status(jobId) {
    const job = JOB_ID_RE.test(String(jobId)) ? jobs.get(jobId) : undefined;
    return job ? { ok: true, data: view(job) } : { ok: false, error: "job-not-found" };
  }

  /** mcpBridge の口。 */
  async function run(kind, { client }, desc) {
    if (kind === "dbCopy") return submitCopy(client, desc.studyUids);
    if (kind === "dbImport") return submitImport(client);
    if (kind === "dbStatus") return status(desc.jobId);
    return { ok: false, error: "unknown-tool" };
  }

  return { run, status, whenFinished: (jobId) => jobs.get(jobId)?.finished };
}

module.exports = { createMcpDbTransfer, copyConfirmText, importRequestText, JOB_ID_RE, LISTED_STUDIES };
