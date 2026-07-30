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
| `engines.os` | 推奨 | 対応 OS（`win32` / `darwin` / `linux`）。GRAPHY-Next は OS ごとにリリースが分かれるため、**導入前に実行中の OS と突き合わせて非対応なら拒否**する。JNI やネイティブバイナリを含むなら必ず絞る。省略＝OS 非依存 |

## 署名（推奨）

リリースに `<zip>.minisig` と `minisign.pub` を添えると、GRAPHY-Next 側で署名を自動検証します。

```bash
minisign -G -p minisign.pub -s minisign.key   # 鍵を作る（1 回だけ）
git add minisign.pub && git commit -m "add signing public key"   # 公開鍵はコミットしてよい
```

`minisign.key` の中身を GitHub の secrets `MINISIGN_SECRET_KEY`、パスワードを `MINISIGN_PASSWORD`
に登録すると、同梱の `release.yml` が署名まで行います（未設定なら署名ステップは自動でスキップ）。

利用者側の挙動:

- **初回導入**: 署名が検証され、その鍵が記録される（確認画面が出る）
- **2 回目以降の更新**: 同じ鍵で署名されていれば**確認画面なしで導入**される
- **鍵が変わった / 署名が壊れている**: 導入を**拒否**する（作者すり替え・改竄の検知）

⚠ **秘密鍵を失う・変える＝利用者は更新できなくなります**（拒否されます）。鍵は必ず保管してください。
| `contributes` | UI を出すなら | サーフェス配列。`"viewer2d.menu"` / `"mainscreen.menu"`（`"viewer2d.toolbar"` は予約） |
| `ui` | UI を出すなら | フロント面 ES モジュールのファイル名（例 `ui.js`） |
| `entrypoint` | backend 面を持つなら | `GraphyPlugin` 実装クラスの完全修飾名（`backend-optional/` 参照） |
| `permissions` | 任意 | 要求権限（現状は表示のみ） |
| `description`/`author`/`homepage`/`license` | 任意 | マネージャ一覧の表示・法務用 |

## サーフェス（`contributes`）と `host`

| サーフェス | 出る場所 | `host` の主なプロパティ |
|---|---|---|
| `viewer2d.menu` | 2D Viewer の Plug-ins メニュー | `actions`（`invert()` / `rotate90()` / `fit()` / `setWindowLevel()` …）<br>`getTargets()` / `getViewState(tileId?)` / `getPixelData(tileId?, opts?)`（**0.1.9 以降**） |
| `mainscreen.menu` | MainScreen の Plug-Ins メニュー | `selectedStudyUid`（選択中スタディ UID） |

`getTargets()` は操作対象タイル（選択→無ければ全）の
`{ tileId, studyUid, seriesUid, seriesLabel, imageId, sliceIndex, sliceCount, c, t, modality }` を、
`getViewState(tileId?)` は `{ windowCenter, windowWidth, unit, colormap, invert, flipH, flipV, rotation, zoom, pan }`
を返す。**呼ぶたびに現在値を読む**ので、活性化時のスナップショットを持ち回らないこと。
使う場合は `engines.graphy` を `">=0.1.9"` に上げる（古い本体には導入されなくなる＝意図した挙動）。

`getPixelData(tileId?, opts?)` は `Promise` で
`{ tileId, imageId, sliceIndex, rows, cols, data, unit, spacing }` を返す。`data` は
`Float32Array`（row-major・`data[y * cols + x]`）の**校正済み画素**＝CT なら HU で、
**表示 W/L は掛かっていない**（W/L や LUT を変えても値は不変）。カラー画像は輝度で `unit="raw"`。
**1 回 1 スライス**（`opts.sliceIndex` で指定。既定は表示中スライス、範囲外は `null`）。
画素を読むなら `permissions` に `"read-pixels"` を宣言する（同意画面に出る。現状強制ではない）。

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
