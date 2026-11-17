// MCP ツールの登録表・引数の検査・backend への要求の組み立て・許可/拒否の判定。設計: roadmap fw/mcp-server-design.md §6。
// electron に依存しない純モジュール。ツールの一覧の正本は main（ここ）。中継（graphy-mcp）は一覧も判断も持たない。
//
// 🔴 backend へ出す要求は `buildRequest` だけが作り、`checkBackendCall` を必ず通る（許可リストに載る組だけ。拒否リストは二重の備え）。
//    クライアントから来た UID は `projector.resolve` で戻す。解決できなければ要求を作らない（任意のパスを組ませない）。
// 🔴 `effect:"analysis"` は `allowAnalysis` がオンのときだけ一覧に出て、呼べる。
const { UID_RE } = require("./mcpProjection");

/** backend に出してよい要求（許可リスト）。パスは固定の形だけ。 */
const ALLOWED = [
  ["GET", /^\/api\/status$/],
  ["GET", /^\/api\/albums$/],
  ["GET", /^\/api\/albums\/\d{1,12}\/studies$/],
  ["GET", /^\/api\/studies$/],
  ["GET", /^\/api\/studies\/[0-9.]{1,64}\/series$/],
  ["GET", /^\/api\/studies\/[0-9.]{1,64}\/series\/[0-9.]{1,64}\/layout$/],
  ["GET", /^\/api\/studies\/[0-9.]{1,64}\/series\/[0-9.]{1,64}\/instances$/],
  ["GET", /^\/api\/instances\/[0-9.]{1,64}\/tags$/],
  ["GET", /^\/api\/compute\/jobs$/],
  ["GET", /^\/api\/compute\/jobs\/[A-Za-z0-9_-]{1,64}$/],
  ["POST", /^\/api\/radiomics\/features\/jobs$/],
  ["GET", /^\/api\/radiomics\/features\/jobs\/[A-Za-z0-9_-]{1,64}$/],
];

/** 拒否リスト（二重の備え。許可リストに誤って足しても通さない）。起点は backend の DemoModeFilter の一覧。 */
const DENIED = [
  /^\/api\/internal(\/|$)/,
  /^\/api\/(dbadmin|db-transfer|settings|share|plugin-manager|import|nifti|raw|imagej|export|series-extract|anonymizer)(\/|$)/,
  /^\/api\/dicom\/(send|qr|echo|tls-config)(\/|$)/,
  /^\/api\/instances\/[^/]+\/(file|frames)(\/|$)/,
  /^\/api\/(patients|stats|system)(\/|$)/,
  /\/(cancel|merge|split|apply|run)(\/|$)/,
];

function checkBackendCall(method, pathname) {
  if (typeof pathname !== "string" || pathname.includes("..") || pathname.includes("?") || pathname.includes("#")) return { ok: false, reason: "bad-path" };
  if (DENIED.some((re) => re.test(pathname))) return { ok: false, reason: "denied" };
  if (!ALLOWED.some(([m, re]) => m === method && re.test(pathname))) return { ok: false, reason: "not-allowed" };
  return { ok: true };
}

const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description, max = 128) => ({ type: "string", description, maxLength: max });
const int = (description, min = 0, max = 1_000_000_000) => ({ type: "integer", description, minimum: min, maximum: max });
const HANDLE = "（list/search の結果に出た値をそのまま渡す）";

/**
 * 2D ビューア窓（renderer）へ main が中継して読む種類（固定リスト）。`via: "viewer"` のツールはここにある kind しか作れない。
 * 🔴 画素を返す `captureView` と、窓を操作する `action`・`pluginTool` はここに入れない（段 4c 以降）。
 */
const VIEWER_KINDS = ["getState", "getMeasurements"];

/** effect: read | analysis。`phiOnly` の引数は includePhi=false では受けない。`via: "viewer"` は backend でなく 2D ビューア窓から読む。 */
const TOOLS = [
  { name: "get_status", effect: "read", description: "GRAPHY-Next の稼働状況（版・モード）。", inputSchema: obj({}) },
  { name: "list_albums", effect: "read", description: "アルバムの一覧（id と件数。名前は患者情報の設定がオンのときだけ）。", inputSchema: obj({}) },
  { name: "list_album_studies", effect: "read", description: "アルバムに含まれる検査の一覧。", inputSchema: obj({ albumId: int("アルバムの id", 0) }, ["albumId"]) },
  {
    name: "search_studies",
    effect: "read",
    description: "検査の検索。患者名・患者 ID での絞り込みは、患者情報の設定がオンのときだけ使える。",
    inputSchema: obj({ modality: str("モダリティ（例 CT）", 16), studyDateFrom: str("開始日 YYYYMMDD", 8), studyDateTo: str("終了日 YYYYMMDD", 8), patientName: str("患者名", 128), patientId: str("患者 ID", 64), limit: int("最大件数（既定 50）", 1, 200) }),
    phiOnly: ["patientName", "patientId"],
  },
  { name: "list_series", effect: "read", description: `検査のシリーズ一覧。${HANDLE}`, inputSchema: obj({ study: str("検査の札", 80) }, ["study"]) },
  { name: "get_series_layout", effect: "read", description: `シリーズの 5D（Z/C/T）配置。${HANDLE}`, inputSchema: obj({ study: str("検査の札", 80), series: str("シリーズの札", 80) }, ["study", "series"]) },
  { name: "list_instances", effect: "read", description: `シリーズの画像（インスタンス）一覧。${HANDLE}`, inputSchema: obj({ study: str("検査の札", 80), series: str("シリーズの札", 80) }, ["study", "series"]) },
  { name: "get_tags", effect: "read", description: `画像の DICOM タグ（撮像条件など）。患者情報のタグは設定がオンのときだけ。${HANDLE}`, inputSchema: obj({ instance: str("画像の札", 80) }, ["instance"]) },
  { name: "list_compute_jobs", effect: "read", description: "計算ジョブの一覧と状態。", inputSchema: obj({}) },
  {
    name: "get_viewer_state",
    effect: "read",
    via: "viewer",
    viewerKind: "getState",
    description: "開いている 2D ビューアの表示状態（タイルごとのモダリティ・スライス位置と枚数・窓幅/窓位・向き・倍率）。2D ビューアが開いていなければ no-viewer。画像そのものは返さない。",
    inputSchema: obj({}),
  },
  {
    name: "get_measurements",
    effect: "read",
    via: "viewer",
    viewerKind: "getMeasurements",
    description: "2D ビューアに描かれた ROI の計測値（長さ・面積・平均・標準偏差など。頂点や UID は返さない。最大 50 件）。クライアントごとに最初の 1 回、利用者の確認が出る。",
    inputSchema: obj({}),
  },
  {
    name: "radiomics_submit",
    effect: "analysis",
    description: `Radiomics の特徴量の計算を投入する（元データは変えない。結果はキャッシュ）。${HANDLE}`,
    inputSchema: obj(
      { study: str("検査の札", 80), sourceSeries: str("元シリーズの札", 80), maskSeries: str("マスク（SEG）シリーズの札", 80), recompute: { type: "boolean", description: "再計算する（既定 false＝キャッシュを使う）" } },
      ["study", "sourceSeries", "maskSeries"],
    ),
  },
  { name: "radiomics_status", effect: "analysis", description: "投入した Radiomics ジョブの状態と結果。", inputSchema: obj({ jobId: str("ジョブ ID", 64) }, ["jobId"]) },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** この設定で見せるツール（解析がオフなら analysis は出さない）。 */
function listTools({ allowAnalysis, includePhi }) {
  return TOOLS.filter((t) => allowAnalysis || t.effect !== "analysis").map((t) => {
    const props = { ...t.inputSchema.properties };
    for (const k of includePhi ? [] : t.phiOnly ?? []) delete props[k];
    return { name: t.name, description: t.description, inputSchema: { ...t.inputSchema, properties: props } };
  });
}

/** 最小の JSON Schema 検査（型・必須・長さ・範囲・未知のキー）。通ったら null、落ちたら理由。 */
function validateArgs(schema, args) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return "args-not-object";
  for (const k of Object.keys(args)) if (!(k in schema.properties)) return `unknown-arg:${k}`;
  for (const k of schema.required ?? []) if (args[k] === undefined) return `missing-arg:${k}`;
  for (const [k, v] of Object.entries(args)) {
    const p = schema.properties[k];
    if (p.type === "string") {
      if (typeof v !== "string" || v.length > (p.maxLength ?? 256)) return `bad-arg:${k}`;
      if (/[\u0000-\u001f\u007f]/.test(v)) return `bad-arg:${k}`;
    } else if (p.type === "integer") {
      if (!Number.isInteger(v) || v < (p.minimum ?? -Infinity) || v > (p.maximum ?? Infinity)) return `bad-arg:${k}`;
    } else if (p.type === "boolean") {
      if (typeof v !== "boolean") return `bad-arg:${k}`;
    }
  }
  return null;
}

/**
 * ツール呼び出し → backend への要求。落とすときは { error } を返す（要求を作らない）。
 * @returns {{ error: string } | { viewer: { kind: string } } | { method: string, path: string, query?: object, limit?: number, body?: object }}
 */
function buildRequest(name, args, { projector, prefs }) {
  const tool = BY_NAME.get(name);
  if (!tool) return { error: "unknown-tool" };
  if (tool.effect === "analysis" && !prefs.allowAnalysis) return { error: "analysis-disabled" };
  const bad = validateArgs(tool.inputSchema, args);
  if (bad) return { error: bad };
  const a = args ?? {};
  for (const k of prefs.includePhi ? [] : tool.phiOnly ?? []) if (a[k] !== undefined) return { error: `phi-disabled:${k}` };
  if (tool.via === "viewer") {
    if (!VIEWER_KINDS.includes(tool.viewerKind)) return { error: "unknown-tool" };
    return { viewer: { kind: tool.viewerKind } };
  }
  const uid = (kind, v) => projector.resolve(kind, v);
  let req;
  switch (name) {
    case "get_status":
      req = { method: "GET", path: "/api/status" };
      break;
    case "list_albums":
      req = { method: "GET", path: "/api/albums" };
      break;
    case "list_album_studies":
      req = { method: "GET", path: `/api/albums/${a.albumId}/studies` };
      break;
    case "search_studies": {
      const query = {};
      for (const k of ["modality", "studyDateFrom", "studyDateTo", "patientName", "patientId"]) if (a[k] !== undefined && a[k] !== "") query[k] = a[k];
      req = { method: "GET", path: "/api/studies", query, limit: a.limit ?? 50 };
      break;
    }
    case "list_series": {
      const s = uid("study", a.study);
      if (!s) return { error: "unknown-handle:study" };
      req = { method: "GET", path: `/api/studies/${s}/series` };
      break;
    }
    case "get_series_layout":
    case "list_instances": {
      const s = uid("study", a.study);
      const se = uid("series", a.series);
      if (!s) return { error: "unknown-handle:study" };
      if (!se) return { error: "unknown-handle:series" };
      req = { method: "GET", path: `/api/studies/${s}/series/${se}/${name === "get_series_layout" ? "layout" : "instances"}` };
      break;
    }
    case "get_tags": {
      const so = uid("instance", a.instance);
      if (!so) return { error: "unknown-handle:instance" };
      req = { method: "GET", path: `/api/instances/${so}/tags` };
      break;
    }
    case "list_compute_jobs":
      req = { method: "GET", path: "/api/compute/jobs" };
      break;
    case "radiomics_submit": {
      const s = uid("study", a.study);
      const src = uid("series", a.sourceSeries);
      const mask = uid("series", a.maskSeries);
      if (!s) return { error: "unknown-handle:study" };
      if (!src) return { error: "unknown-handle:sourceSeries" };
      if (!mask) return { error: "unknown-handle:maskSeries" };
      req = { method: "POST", path: "/api/radiomics/features/jobs", body: { studyInstanceUid: s, sourceSeriesUid: src, maskSeriesUid: mask, recompute: a.recompute === true } };
      break;
    }
    case "radiomics_status":
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(a.jobId)) return { error: "bad-arg:jobId" };
      req = { method: "GET", path: `/api/radiomics/features/jobs/${a.jobId}` };
      break;
    default:
      return { error: "unknown-tool" };
  }
  const chk = checkBackendCall(req.method, req.path);
  if (!chk.ok) return { error: chk.reason };
  return req;
}

/** backend の応答 → クライアントへ返す内容（射影）。患者情報なしでは最後に guard を通す。 */
function projectResult(name, data, projector) {
  const P = projector;
  let out;
  switch (name) {
    case "get_status":
      out = { app: data?.app ?? null, version: data?.version ?? null, mode: data?.mode ?? null };
      break;
    case "list_albums":
      out = (Array.isArray(data) ? data : []).map((d) => P.album(d));
      break;
    case "list_album_studies":
      out = { studies: (Array.isArray(data) ? data : []).map((u) => P.ref("study", u)).filter(Boolean) };
      break;
    case "search_studies":
      out = (Array.isArray(data) ? data : []).map((d) => P.study(d));
      break;
    case "list_series":
      out = (Array.isArray(data) ? data : []).map((d) => P.series(d));
      break;
    case "list_instances":
      out = (Array.isArray(data) ? data : []).map((d) => P.instance(d));
      break;
    case "get_tags":
      out = P.tags(data);
      break;
    default:
      out = P.deep(data); // get_series_layout・list_compute_jobs・radiomics_*・get_viewer_state・get_measurements：形が一定でないので構造ごと射影
  }
  return P.guard(out);
}

module.exports = { TOOLS, VIEWER_KINDS, listTools, validateArgs, buildRequest, projectResult, checkBackendCall, ALLOWED, DENIED, UID_RE };
