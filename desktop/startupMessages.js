// 起動スプラッシュの表示文言（ja / en）。
//
// メインプロセス（main.js）とスプラッシュのレンダラ（splash.html）の両方から読むため、
// CommonJS と <script> 読み込みの両対応にしてある（Electron の sandbox 下でも
// file:// 相対の <script src> は読める）。
//
// 方針:
//   - 失敗は「起動に失敗しました」で丸めない。何がどこで起きたかを名指しする。
//     利用者が次に取れる行動（再起動する / ポートを空ける / ネットワーク無しでも使える）が
//     読み取れる文にする。
//   - 技術的な一次情報（backend の最後のログ行・終了コード）は detail として別行に出す。
//     訳さない。問い合わせのときにそのまま転記できることの方が大事。
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.GraphyStartupMessages = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  const STEPS = {
    ja: {
      init: "起動を開始しています",
      folders: "必要なフォルダを確認しています",
      database: "データベースを確認・マイグレーションしています",
      scp: "DICOM 受信(SCP)を開始しています",
      plugins: "プラグインを読み込んでいます",
      pluginsDone: "プラグインを読み込みました",
      pluginsNone: "プラグインはありません",
      pluginsFailed: "プラグインの読み込みに失敗しました",
      ready: "起動が完了しました",
    },
    en: {
      init: "Starting up",
      folders: "Checking required folders",
      database: "Checking / migrating the database",
      scp: "Starting DICOM receiver (SCP)",
      plugins: "Loading plugins",
      pluginsDone: "Plugins loaded",
      pluginsNone: "No plugins",
      pluginsFailed: "Failed to load plugins",
      ready: "Startup complete",
    },
  };

  // 段階を文中で指すときの短い名前（「{step} の段階で…」の {step}）。
  const STEP_NOUNS = {
    ja: {
      init: "起動開始",
      folders: "フォルダ確認",
      database: "データベース",
      scp: "DICOM 受信(SCP)",
      plugins: "プラグイン",
      ready: "仕上げ",
    },
    en: {
      init: "startup",
      folders: "folders",
      database: "database",
      scp: "DICOM receiver (SCP)",
      plugins: "plugins",
      ready: "finishing",
    },
  };

  const CODES = {
    ja: {
      sub: "起動しています…",
      "jar-missing": "backend の実行ファイルが見つかりません",
      "jar-broken": "backend の実行ファイルを読み込めません（壊れている可能性があります）",
      "java-missing": "Java が見つかりません（同梱の JRE も、PATH の java も実行できませんでした）",
      "java-too-old": "Java のバージョンが古く backend を実行できません（Java 21 以上が必要です）",
      "spawn-failed": "backend のプロセスを起動できませんでした",
      "port-in-use":
        "ポート {port} が既に使われています（GRAPHY-Next が既に起動しているか、別のアプリが同じポートを使っています）",
      "db-locked":
        "データベースを開けませんでした（GRAPHY-Next が既に起動している可能性があります）",
      "backend-exited": "backend が起動の途中で終了しました（終了コード {code}）",
      "backend-timeout":
        "backend が {seconds} 秒たっても応答しませんでした（{step} の段階で停止）。画面は開きます",
      "backend-stalled":
        "{step} の段階で {seconds} 秒 応答がありません（ネットワークに繋がらない環境では時間がかかることがあります）。このまま待ちます",
      unknown: "起動処理でエラーが発生しました",
    },
    en: {
      sub: "Starting…",
      "jar-missing": "The backend executable was not found",
      "jar-broken": "The backend executable could not be read (it may be corrupt)",
      "java-missing": "Java was not found (neither the bundled JRE nor java on PATH could be run)",
      "java-too-old": "The Java version is too old to run the backend (Java 21 or later is required)",
      "spawn-failed": "The backend process could not be started",
      "port-in-use":
        "Port {port} is already in use (GRAPHY-Next may already be running, or another app uses the same port)",
      "db-locked": "The database could not be opened (GRAPHY-Next may already be running)",
      "backend-exited": "The backend exited during startup (exit code {code})",
      "backend-timeout":
        "The backend did not respond within {seconds}s (stalled at: {step}). The window will open anyway",
      "backend-stalled":
        "No response for {seconds}s at: {step} (this can take a while without network access). Still waiting",
      unknown: "An error occurred during startup",
    },
  };

  function norm(locale) {
    return locale === "en" ? "en" : "ja";
  }

  /** 段階の識別子 → スプラッシュの行に出す文。未知の step は null。 */
  function stepLabel(locale, step) {
    return STEPS[norm(locale)][step] || null;
  }

  /** 段階の識別子 → 文中で使う短い名前。未知の step はそのまま返す。 */
  function stepNoun(locale, step) {
    return STEP_NOUNS[norm(locale)][step] || step || "";
  }

  /** コード＋パラメータ → 表示文。未知のコードは unknown にフォールバックする。 */
  function format(locale, code, params) {
    const l = norm(locale);
    const template = CODES[l][code] || CODES[l].unknown;
    const p = params || {};
    return template.replace(/\{(\w+)\}/g, (whole, key) => {
      if (key === "step") return stepNoun(l, p.step);
      return p[key] === undefined ? whole : String(p[key]);
    });
  }

  return { format, stepLabel, stepNoun, subtitle: (locale) => CODES[norm(locale)].sub };
});
