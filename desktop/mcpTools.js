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
const num = (description, min, max) => ({ type: "number", description, minimum: min, maximum: max });
const oneOf = (description, values) => ({ type: "string", description, enum: values, maxLength: 32 });
const HANDLE = "（list/search の結果に出た値をそのまま渡す）";
const CONTROL_NOTE = "操作の対象は、利用者が今 2D ビューアで選んでいるタイル。元に戻せる（undo_viewer_action）。2D ビューアが開いていなければ no-viewer。";
const EDIT_NOTE = "対象は、利用者が今 2D ビューアで選んでいるタイル。実行のたびに、アプリが利用者に確認する（拒否されると declined）。2D ビューアが開いていなければ no-viewer。";

/**
 * 2D ビューア窓（renderer）へ main が中継して読む種類（固定リスト）。`via: "viewer"` のツールはここにある kind しか作れない。
 * 🔴 画素を返す `captureView` はここに入れない。`pluginTool` はプラグインの AI ツール（名前は main の一覧で引き直す。`pluginTools` で公開したプラグインだけ）。
 *    `action` は下の `VIEWER_ACTIONS`（表示操作）と `VIEWER_WRITE_ACTIONS`（allowViewerEdit のときだけ。実行のたびに確認）だけ、
 *    `undo` は main が持つ履歴を戻す操作（窓への kind ではない）。
 */
const VIEWER_KINDS = ["getState", "getMeasurements", "action", "undo", "pluginTool"];

/**
 * 外部 AI クライアントが行える 2D ビューアの表示操作（固定リスト）。**すべて元に戻せる display の操作**（allowViewerControl）。
 * 🔴 データを変える write は入れない（下の VIEWER_WRITE_ACTIONS）。アシスタント専用の removeAssistantRoi は UNDO_ONLY_ACTIONS。
 *    frontend/src/assistant/actions/registry.ts の display の action（removeAssistantRoi を除く）と一致することを mcp.test.js が検査する。
 */
const VIEWER_ACTIONS = ["setWindowLevel", "resetWindow", "applyWlPreset", "rotate90", "flipH", "flipV", "invert", "goToSlice", "setLayout", "setTool"];
/**
 * データを変える操作（allowViewerEdit のときだけ。2D 窓の dryRun で検査してから、main が利用者に**毎回**確認する）。
 * registry.ts の `effect: "write"` と一致することを mcp.test.js が検査する。clearMeasurements は元に戻せない。
 */
const VIEWER_WRITE_ACTIONS = ["createRoi", "createContourRoi", "clearMeasurements"];
/** 逆操作（undo）でだけ main が再実行する。ツールとしては出さない（ROI は createRoi で作った出自のものだけ消せる）。 */
const UNDO_ONLY_ACTIONS = ["removeAssistantRoi"];
/** setTool に渡せるツール（registry.ts の DISPLAY_TOOLS と一致させる）。 */
const DISPLAY_TOOLS = ["windowLevel", "pan", "zoom", "magnify", "length", "angle"];

/**
 * effect: read | analysis | control | edit。`phiOnly` の引数は includePhi=false では受けない。`via: "viewer"` は backend でなく 2D ビューア窓から読む／操作する。
 * `control` は allowViewerControl がオンのときだけ（利用者の画面が動く）。`edit` は allowViewerEdit がオンのときだけ（データを変える）。
 */
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
    name: "set_window_level",
    effect: "control",
    via: "viewer",
    viewerKind: "action",
    viewerAction: "setWindowLevel",
    description: `2D ビューアの窓位（center）と窓幅（width）を設定する（モダリティの単位。CT は HU）。${CONTROL_NOTE}`,
    inputSchema: obj({ center: num("窓位", -100000, 100000), width: num("窓幅（1 以上）", 1, 200000) }, ["center", "width"]),
  },
  { name: "reset_window", effect: "control", via: "viewer", viewerKind: "action", viewerAction: "resetWindow", description: `窓位・窓幅を DICOM の既定に戻す。${CONTROL_NOTE}`, inputSchema: obj({}) },
  {
    name: "apply_window_preset",
    effect: "control",
    via: "viewer",
    viewerKind: "action",
    viewerAction: "applyWlPreset",
    description: `名前つきの窓条件を適用する（brain=脳・soft=軟部・lung=肺・bone=骨・abdomen=腹部・liver=肝、または利用者のプリセット名）。${CONTROL_NOTE}`,
    inputSchema: obj({ name: str("プリセットの名前", 60) }, ["name"]),
  },
  {
    name: "rotate_view",
    effect: "control",
    via: "viewer",
    viewerKind: "action",
    viewerAction: "rotate90",
    description: `画像を時計回りに 90 度ずつ回す（times 回。既定 1）。${CONTROL_NOTE}`,
    inputSchema: obj({ times: int("90 度の回数", 1, 3) }),
  },
  { name: "flip_horizontal", effect: "control", via: "viewer", viewerKind: "action", viewerAction: "flipH", description: `左右反転（もう一度呼ぶと戻る）。${CONTROL_NOTE}`, inputSchema: obj({}) },
  { name: "flip_vertical", effect: "control", via: "viewer", viewerKind: "action", viewerAction: "flipV", description: `上下反転（もう一度呼ぶと戻る）。${CONTROL_NOTE}`, inputSchema: obj({}) },
  { name: "invert_colors", effect: "control", via: "viewer", viewerKind: "action", viewerAction: "invert", description: `白黒反転（ネガポジ。もう一度呼ぶと戻る）。${CONTROL_NOTE}`, inputSchema: obj({}) },
  {
    name: "go_to_slice",
    effect: "control",
    via: "viewer",
    viewerKind: "action",
    viewerAction: "goToSlice",
    description: `指定のスライスへ移動する。index は 0 始まり（N 枚目は N-1、最初は 0、最後は sliceCount-1。sliceCount は get_viewer_state）。範囲外は端に寄せる。${CONTROL_NOTE}`,
    inputSchema: obj({ index: int("0 始まりのスライス番号", 0, 1_000_000) }, ["index"]),
  },
  {
    name: "set_layout",
    effect: "control",
    via: "viewer",
    viewerKind: "action",
    viewerAction: "setLayout",
    description: `ビューアの列数（画像を横に並べる数）を設定する。表示するスライスは変わらない。${CONTROL_NOTE}`,
    inputSchema: obj({ cols: int("列数", 1, 8) }, ["cols"]),
  },
  {
    name: "set_tool",
    effect: "control",
    via: "viewer",
    viewerKind: "action",
    viewerAction: "setTool",
    description: `左ボタンのツールを選ぶ（表示・計測表示用のツールだけ）。${CONTROL_NOTE}`,
    inputSchema: obj({ tool: oneOf("ツール名", DISPLAY_TOOLS) }, ["tool"]),
  },
  {
    name: "undo_viewer_action",
    effect: "control",
    undo: true, // allowViewerEdit だけでも出す（ROI の作成を戻すため）
    via: "viewer",
    viewerKind: "undo",
    description: "この接続が行った表示操作・ROI の作成のうち、直近の 1 つを元に戻す（履歴は最大 20 件。アプリ側が持つ）。ROI は、この接続が作ったものだけ消える。計測の全削除は戻せない。履歴が無ければ nothing-to-undo。",
    inputSchema: obj({}),
  },
  {
    name: "create_roi",
    effect: "edit",
    via: "viewer",
    viewerKind: "action",
    viewerAction: "createRoi",
    description: `表示中のスライスに ROI（楕円または矩形）を 1 つ追加する。位置は見えている画像の領域に対する割合（u=0 左…1 右、v=0 上…1 下。画面に見えるとおり）、大きさは画面の横・縦方向の半径（mm）。この ROI は undo_viewer_action で消せる。${EDIT_NOTE}`,
    inputSchema: obj(
      { shape: oneOf("形", ["ellipse", "rectangle"]), u: num("中心の横位置（0〜1）", 0, 1), v: num("中心の縦位置（0〜1）", 0, 1), radiusXmm: num("横方向の半径（mm）", 0.1, 500), radiusYmm: num("縦方向の半径（mm）", 0.1, 500) },
      ["shape", "u", "v", "radiusXmm", "radiusYmm"],
    ),
  },
  {
    name: "create_contour_roi",
    effect: "edit",
    via: "viewer",
    viewerKind: "action",
    viewerAction: "createContourRoi",
    description: `表示中のスライスに、頂点で囲んだ閉じた ROI を 1 つ追加する。各頂点は [u, v]（見えている画像の領域に対する割合。u=0 左…1 右、v=0 上…1 下）で、輪郭に沿った順に並べる（最初の点を繰り返さない）。polygon は直線で結び、freehand は自由曲線（頂点を多く）。3〜64 個。輪郭が自分自身と交差してはならない。この ROI は undo_viewer_action で消せる。${EDIT_NOTE}`,
    inputSchema: obj(
      {
        shape: oneOf("形", ["polygon", "freehand"]),
        points: { type: "array", description: "頂点 [u, v] の並び", minItems: 3, maxItems: 64, items: { type: "array", minItems: 2, maxItems: 2, items: { type: "number", minimum: 0, maximum: 1 } } },
      },
      ["shape", "points"],
    ),
  },
  {
    name: "clear_measurements",
    effect: "edit",
    via: "viewer",
    viewerKind: "action",
    viewerAction: "clearMeasurements",
    description: `2D ビューアの計測（長さ・角度など）をすべて消す。**元に戻せない**（undo_viewer_action でも戻らない）。ロックされた計測は残る。利用者が明示的に頼んだときだけ使う。${EDIT_NOTE}`,
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

/** この設定でツールを使えるか（解析・表示操作・データを変える操作は、それぞれ別の許可）。 */
function allowedBy(t, p) {
  switch (t.effect) {
    case "analysis":
      return p.allowAnalysis === true;
    case "control":
      return p.allowViewerControl === true || (t.undo === true && p.allowViewerEdit === true);
    case "edit":
      return p.allowViewerEdit === true;
    default:
      return true;
  }
}
const DISABLED = { analysis: "analysis-disabled", control: "control-disabled", edit: "edit-disabled" };

/** この設定で見せるツール（解析・表示操作・データを変える操作は、それぞれの許可がオンのときだけ）。 */
function listTools(prefs) {
  const { includePhi } = prefs;
  return TOOLS.filter((t) => allowedBy(t, prefs)).map((t) => {
    const props = { ...t.inputSchema.properties };
    for (const k of includePhi ? [] : t.phiOnly ?? []) delete props[k];
    return { name: t.name, description: t.description, inputSchema: { ...t.inputSchema, properties: props } };
  });
}

/** 値が JSON Schema（型・長さ・範囲・要素数・enum）に合うか。array は要素を再帰的に検査する（registry.ts の points と同じ形）。 */
function valueOk(p, v) {
  if (p.type === "string") {
    if (typeof v !== "string" || v.length > (p.maxLength ?? 256) || /[\u0000-\u001f\u007f]/.test(v)) return false;
  } else if (p.type === "integer") {
    if (!Number.isInteger(v) || v < (p.minimum ?? -Infinity) || v > (p.maximum ?? Infinity)) return false;
  } else if (p.type === "number") {
    if (typeof v !== "number" || !Number.isFinite(v) || v < (p.minimum ?? -Infinity) || v > (p.maximum ?? Infinity)) return false;
  } else if (p.type === "boolean") {
    if (typeof v !== "boolean") return false;
  } else if (p.type === "array") {
    if (!Array.isArray(v) || v.length < (p.minItems ?? 0) || v.length > (p.maxItems ?? 1000)) return false;
    if (p.items && !v.every((x) => valueOk(p.items, x))) return false;
  }
  if (p.enum && !p.enum.includes(v)) return false;
  return true;
}

/** 最小の JSON Schema 検査（型・必須・長さ・範囲・要素数・未知のキー）。通ったら null、落ちたら理由。 */
function validateArgs(schema, args) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return "args-not-object";
  for (const k of Object.keys(args)) if (!(k in schema.properties)) return `unknown-arg:${k}`;
  for (const k of schema.required ?? []) if (args[k] === undefined) return `missing-arg:${k}`;
  for (const [k, v] of Object.entries(args)) if (!valueOk(schema.properties[k], v)) return `bad-arg:${k}`;
  return null;
}

/**
 * ツール呼び出し → backend への要求。落とすときは { error } を返す（要求を作らない）。
 * @returns {{ error: string } | { viewer: { kind: string, id?: string, params?: object } } | { method: string, path: string, query?: object, limit?: number, body?: object }}
 */
function buildRequest(name, args, { projector, prefs }) {
  const tool = BY_NAME.get(name);
  if (!tool) return { error: "unknown-tool" };
  if (!allowedBy(tool, prefs)) return { error: DISABLED[tool.effect] };
  const bad = validateArgs(tool.inputSchema, args);
  if (bad) return { error: bad };
  const a = args ?? {};
  for (const k of prefs.includePhi ? [] : tool.phiOnly ?? []) if (a[k] !== undefined) return { error: `phi-disabled:${k}` };
  if (tool.via === "viewer") {
    if (!VIEWER_KINDS.includes(tool.viewerKind)) return { error: "unknown-tool" };
    if (tool.viewerKind === "action") {
      // 引数は検査済み（validateArgs）。id は固定リストにあるものだけ（write・アシスタント専用の操作は作れない）
      if (!VIEWER_ACTIONS.includes(tool.viewerAction) && !VIEWER_WRITE_ACTIONS.includes(tool.viewerAction)) return { error: "unknown-tool" };
      return { viewer: { kind: "action", id: tool.viewerAction, params: { ...a } } };
    }
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

module.exports = { TOOLS, VIEWER_KINDS, VIEWER_ACTIONS, VIEWER_WRITE_ACTIONS, UNDO_ONLY_ACTIONS, DISPLAY_TOOLS, listTools, validateArgs, buildRequest, projectResult, checkBackendCall, ALLOWED, DENIED, UID_RE };
