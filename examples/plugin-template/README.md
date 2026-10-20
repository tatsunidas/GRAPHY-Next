# GRAPHY-Next プラグイン テンプレート

GRAPHY-Next のプラグインを作るための最小の雛形です。GitHub の「**Use this template**」で自分のリポジトリを作り、
プラグインを書いて、**Release タグ**で配布します。GRAPHY-Next の利用者は、プラグインマネージャ
（環境設定 ＞ プラグイン）から導入できます。索引に載せると「見つける」の一覧にも出ます（下の「索引に載せる」）。

ライセンスは MIT です（`LICENSE`）。この雛形から作ったプラグインは、公開・非公開、オープンソース・商用を問わず、自由に配布できます。

## 中身

```
plugin.json                     ← 必須。マニフェスト（id/name/version/engines/contributes/ui …）
ui.js                           ← フロント面（ES モジュール・ビルド不要）。activate(host) を export
graphy-plugin.d.ts              ← エディタ型補完用（ビルド不要。ui.js から参照）
LICENSE                         ← MIT。自分のプラグイン用に年と名前を書き換える
.github/workflows/release.yml   ← タグ push で <id>-<version>.zip + .sha256（+ 署名）を作り Release に添付
backend-optional/               ← 任意。Java のバックエンド面（重い計算・standalone のみ）
```

## クイックスタート（署名つきで Release を出すまで）

1. 「**Use this template**」で自分のリポジトリを作る（**公開**リポジトリにする。索引に載せるのに必要）。
2. `plugin.json` を編集する（`id` を一意に、`name` / `version` / `author` / `homepage` / `license` を自分用に）。`LICENSE` の年と名前も直す。
3. `ui.js` の `activate(host)` を実装する。
4. **署名鍵を作る**（1 回だけ。下の「署名」）。公開鍵 `minisign.pub` をリポジトリ直下にコミットし、秘密鍵をリポジトリの secrets に登録する。
5. `plugin.json` の `version` を上げ、同じ版で**タグ `v<version>`** を push する（例 `v0.1.0`）。
   GitHub Actions が `<id>-<version>.zip`（直下に `plugin.json`）・`.sha256`・`.minisig`・`minisign.pub` を Release に添付する。
   タグと `plugin.json` の版が違うと CI が止まる。
6. Release の資産が 4 つ（zip・sha256・minisig・minisign.pub）揃っていることを確認する。
7. GRAPHY-Next の環境設定 ＞ プラグイン ＞「URL / ZIP」に `owner/repo` を入れて導入してみる（導入には「プラグインの導入を許可する」の ON が要る）。
8. 他の人に見つけてもらうには、索引に載せる（下の「索引に載せる」）。

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

## 署名

署名は任意ですが、**索引に載せるには必須**です。署名があると、利用者の導入で次のようになります。

- **初回導入**: 署名が検証され、その鍵が記録される（確認画面が出る）
- **2 回目以降の更新**: 同じ鍵で署名されていれば**確認画面なしで導入**される
- **鍵が変わった / 署名が壊れている / 署名が無い**: 導入を**拒否**する（作者のすり替え・改竄の検知。実際の GitHub で確認済み）

### 鍵を作って登録する

```bash
minisign -G -p minisign.pub -s minisign.key   # 鍵を作る（1 回だけ。パスフレーズを聞かれる）
git add minisign.pub && git commit -m "add signing public key"   # 公開鍵はコミットしてよい
```

- `minisign.key`（秘密鍵）は**リポジトリに入れない**。中身を GitHub の secrets `MINISIGN_SECRET_KEY` に、パスフレーズを `MINISIGN_PASSWORD` に登録する（Settings ＞ Secrets and variables ＞ Actions）。
- 同梱の `release.yml` が、secrets があれば署名まで行う（未設定なら署名ステップは自動でスキップされ、署名なしの Release になる）。
- パスフレーズ無しの鍵（`minisign -G -W`）でも署名できる（`MINISIGN_PASSWORD` は未設定でよい。実際の Release で確認済み）。パスフレーズ付きの鍵での CI 署名は、この雛形では未検証。
- minisign は公式サイト（<https://jedisct1.github.io/minisign/>）から入れる。

### 守ること

- ⚠ **秘密鍵を失う・変える＝利用者は更新できなくなります**（拒否されます）。復旧は利用者がアンインストールして入れ直す以外にありません。鍵は必ず別の場所にも保管してください。
- 利用者側は**初回導入で見た鍵を固定する**方式です。**最初に導入される前にリポジトリが乗っ取られた場合は、この仕組みでは防げません**（初回の鍵が攻撃者のものになる）。リポジトリのアクセス権（2 段階認証など）を守ってください。
- 署名は「同じ作者の物であること」までの保証で、**プラグインの中身の安全は保証しません**。

## 索引に載せる

GRAPHY-Next の「見つける」一覧に出すには、公式の索引リポジトリ
[`tatsunidas/graphy-next-plugin-index`](https://github.com/tatsunidas/graphy-next-plugin-index) の `index.json` に 1 行足す Pull Request を出します
（申請の手順と検査の内容は、そのリポジトリの README を参照）。載っていなくても、`owner/repo` を直接入力すれば導入できます。

**索引に載っていることは、安全の保証ではありません。** 導入のたびに署名と中身が検査され、同意画面が出ます。

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
- `.sha256` を添付すると、マネージャが取得時に完全性を検証する（推奨。無いと利用者は「承知のうえで導入」の確認が必要になる）。
- 署名（minisign）は上の「署名」。信頼の表示は、当社の公式鍵で署名されたものが「公式」、それ以外は初回に確認画面が出る。
- private リポジトリのプラグインは、マネージャ側の GitHub トークン設定（`graphy.plugins.github-token`）で取得できる。

## 参考

- GRAPHY-Next 本体: <https://github.com/tatsunidas/GRAPHY-Next>
- 型定義: `graphy-plugin.d.ts`（`host` の全 API。エディタで補完が効く）
