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
| `contributes` | UI を出すなら | サーフェス配列。`"viewer2d.menu"` / `"viewer2d.menu.analysis"`（0.2.1 以降）/ `"mainscreen.menu"`（`"viewer2d.toolbar"` は予約） |
| `ui` | UI を出すなら | フロント面 ES モジュールのファイル名（例 `ui.js`） |
| `entrypoint` | backend 面を持つなら | `GraphyPlugin` 実装クラスの完全修飾名（`backend-optional/` 参照） |
| `permissions` | 任意 | 要求権限（例 `"read-pixels"`）。導入時の同意画面に表示される（**強制はまだ無い**） |
| `description`/`author`/`homepage`/`license` | 任意 | マネージャ一覧の表示・法務用 |

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

## サーフェス（`contributes`）と `host`

| サーフェス | 出る場所 | `host` の主なプロパティ |
|---|---|---|
| `viewer2d.menu` | 2D Viewer の **Plug-ins** メニュー | `actions`（`invert()` / `rotate90()` / `fit()` / `setWindowLevel()` …）<br>`getTargets()` / `getViewState()` / `getPixelData()` / `showOverlay()` / `clearOverlay()` / `saveDerivedSeries()` / `getRois()` / `getRoiMeta()` / `setRoiMeta()` / `subscribeRois()`（**0.1.9 以降**）<br>`saveStructuredReport()` / `loadStore()` / `saveStore()` / `deleteStore()`（**0.1.12 以降**）<br>`goTo()` / `selectRoi()`（**0.1.13 以降**）<br>`loadVolume()` / `estimateVolume()` / `registerVolumes()` / `resampleVolume()`（**0.2.0 以降**） |
| `viewer2d.menu.analysis` | 2D Viewer の **解析**メニュー（**0.2.1 以降**） | `viewer2d.menu` と**完全に同じ**。違うのは出る場所だけ。本体機能と並ぶので、**本体が区切り線と「（プラグイン）」の印を付ける** — 名前に「プラグイン」と入れないこと（二重に出る） |
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

`showOverlay(tileId?, { data, rows, cols, window?, colormap?, opacity? })` は処理結果を
**表示中スライスに重ねて見せる**。渡すのは値だけで、色付けは本体がする（`colormap` に本体の LUT 名、
例 `"Hot_Iron"`）。**`NaN` は透明**なのでマスクをそのまま渡せる。格子が現在スライスと不一致なら `false`。
オーバーレイは出したスライスに紐付き（他スライスでは隠れる）、本体が画像左下に
`プラグイン: <名前>` のラベルを出す。`clearOverlay(tileId?)` で消える。
`showOverlay()` は**表示だけ**。残したいときは次の保存を使う。

`saveDerivedSeries(tileId?, { seriesDescription, frames: [{ sliceIndex, data }], rows, cols, unit?, derivationDescription? })`
は処理結果を**派生シリーズとして保存**する（standalone はこの PC の保管庫、web は接続中の PACS）。
**本体が必ず確認ダイアログを出す**ので、プラグインが黙って保存することはできない（拒否されると
`{ ok: false, cancelled: true }`）。幾何は本体が元シリーズから引き継ぐため、`frames` は
「どの元スライスに対応するか」（`sliceIndex`）だけを申告する。画素は 16bit ＋ Rescale で保存され、
**`NaN`（データ無し）を含むなら `background` が必須**（未指定は拒否。CT のマスクなら空気の `-1000`
が素直で、指定値は `PixelPaddingValue` にも書かれる）。保存物には `[Plugin] ` 接頭辞とプラグイン
id・版が必ず残り、**元シリーズは変更されない**。

`getRois(tileId?)` は**ユーザーが描いた ROI（計測）**の配列を返す（`tileId` 省略時は**対象タイル全部**。
他の問い合わせ系と違う点に注意）。`subscribeRois(cb)` で編集に追随できる（**差分は渡らない**ので
通知が来たら読み直す。閉じるときに解除する）。`getRoiMeta()` / `setRoiMeta()` で ROI に自分の属性
（追跡 ID 等）を付けられる（キーは自動で `plugin.<id>.` 名前空間に入る）。

長径・短径は **2 系統返る**ので、取り違えないこと。ROI メニューの「長径・短径（RECIST）」
＝`Bidirectional` はユーザーが 2 軸を明示的に引くので `measurements.length` / `shortAxis` を使い、
楕円・矩形・自由曲線は `measurements.longAxisMm` / `shortAxisMm`（形状から本体が算出＝最遠 2 点と、
それに直交する広がり）を使う。画素間隔が不明なら算出値は `undefined`（mm は捏造されない）。

**`roiUid` はアプリを再起動しても同じ**（ROI は患者単位で永続化され、同じ `annotationUID` で
復元される）。時系列追跡の鍵に使える。`setRoiMeta()` の属性も一緒に保存される。
削除された ROI は復活しないので、`getRois()` に現れない `roiUid` は消えたものとして扱う。
`zScope === "all"` の ROI は `sliceIndex` が「いま見ているスライス」を指すだけなので、計測記録では弾く。
ROI の**書き込みはできない**（読影医の計測をプラグインが書き換えられないようにしてある）。

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
