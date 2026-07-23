# GRAPHY-Next プラグイン テンプレート

GRAPHY-Next のプラグインを作るための最小の雛形。これをコピー（または「Use this template」で fork）して、
自分のプラグインを作り、GitHub の **Release タグ**で配布する。GRAPHY-Next のユーザーはプラグイン
マネージャ（Settings ＞ プラグイン）から **GitHub の `owner/repo`** を指定して導入できる。

> このフォルダは GRAPHY-Next 本体リポジトリ内の雛形。実運用では独立した GitHub リポジトリ
> （例 `graphy-next-plugin-template`）として「Use this template」可能にすることを想定している。

## 中身

```
plugin.json                     ← 必須。マニフェスト（id/name/version/engines/contributes/ui …）
ui.js                           ← フロント面（ES モジュール・ビルド不要）。activate(host) を export
graphy-plugin.d.ts              ← エディタ型補完用（ビルド不要。ui.js から参照）
.github/workflows/release.yml   ← タグ push で <id>-<version>.zip + .sha256 を作り Release に添付
backend-optional/               ← 任意。Java のバックエンド面（重い計算・standalone のみ）
```

## 1 分クイックスタート

1. このテンプレを fork / コピーする。
2. `plugin.json` を編集（`id` を一意に、`name` / `version` / `author` / `homepage` を自分用に）。
3. `ui.js` の `activate(host)` を実装する。
4. `plugin.json` の `version` を上げ、同じ版で **タグ `v<version>`** を push する（例 `v0.1.0`）。
   → GitHub Actions が `<id>-<version>.zip`（直下に `plugin.json`）と `.sha256` を Release に添付する。
5. GRAPHY-Next の Settings ＞ プラグイン ＞「GitHub から導入」に `owner/repo` を入れて導入。

> ローカルで試すだけなら、`plugin.json` と `ui.js` を GRAPHY-Next のプラグインフォルダ
> （`<appData>/GRAPHY-Next/plugins/<id>/`）へ直接置いてアプリを再起動してもよい。

## plugin.json のフィールド

| キー | 必須 | 説明 |
|---|---|---|
| `id` | ✅ | 一意な ID（`[A-Za-z0-9._-]`）。フォルダ名と揃えると分かりやすい |
| `name` | ✅ | メニュー表示名 |
| `version` | ✅ | 版（semver）。**リリースタグ `v<version>` と一致必須** |
| `engines.graphy` | 推奨 | 対応するコアの範囲（例 `">=0.1.0 <0.3.0"`）。マネージャが互換判定に使う |
| `contributes` | UI を出すなら | サーフェス配列。`"viewer2d.menu"` / `"mainscreen.menu"`（`"viewer2d.toolbar"` は予約） |
| `ui` | UI を出すなら | フロント面 ES モジュールのファイル名（例 `ui.js`） |
| `entrypoint` | backend 面を持つなら | `GraphyPlugin` 実装クラスの完全修飾名（`backend-optional/` 参照） |
| `permissions` | 任意 | 要求権限（現状は表示のみ） |
| `description`/`author`/`homepage`/`license` | 任意 | マネージャ一覧の表示・法務用 |

## サーフェス（`contributes`）と `host`

| サーフェス | 出る場所 | `host` の主なプロパティ |
|---|---|---|
| `viewer2d.menu` | 2D Viewer の Plug-ins メニュー | `actions`（`invert()` / `rotate90()` / `fit()` / `setWindowLevel()` …） |
| `mainscreen.menu` | MainScreen の Plug-Ins メニュー | `selectedStudyUid`（選択中スタディ UID） |

共通: `pluginId` / `t(key)`（i18n）/ `notify(msg)` / `runBackend(payload?)`（backend 面がある場合）。
型は `graphy-plugin.d.ts` を参照（`ui.js` 先頭の `/// <reference ...>` + `// @ts-check` で補完が効く）。

## 配布と信頼

- 配布は **GitHub Release のビルド済み zip 資産**（直下に `plugin.json`）。ソース tarball ではない。
- `.sha256` を添付すると、マネージャが取得時に完全性を検証する（推奨）。
- 署名（minisign 等）・信頼ティア表示・GitHub OAuth（private の列挙）は GRAPHY-Next 側で今後対応予定。
- private プラグインは当面、マネージャ側の GitHub トークン設定（PAT）で列挙・取得する。

## 参考

- 作成ガイド: GRAPHY-Next `fw/plugin-authoring-guide.md`
- マネージャ設計: GRAPHY-Next `fw/plugin-manager-design.md`
- 実行レイヤ設計: GRAPHY-Next `fw/plugin-architecture.md`
