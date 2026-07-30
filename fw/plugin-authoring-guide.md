# GRAPHY-Next プラグイン作成ガイド

> 作成日: 2026-07-02（更新: 2026-07-30 — §2-3 に host API の問い合わせ系（H1/H2）・画素読み出し（H3）・
> オーバーレイ（H4a）・派生シリーズ保存（H4b）・**ROI（計測）の読み出し（H5）**を追記）
> 対象: プラグイン開発者
> 関連: [`plugin-architecture.md`](plugin-architecture.md)（設計・全体像）

GRAPHY-Next のプラグインを作る・入れる手順を、動くサンプル付きでまとめる。
アーキテクチャの背景は [`plugin-architecture.md`](plugin-architecture.md) を参照。

---

## 0. 3 行まとめ

- 1 プラグイン = **1 フォルダ**。直下に `plugin.json`（必須）＋任意で `ui.js`（フロント面）／`*.jar`（バックエンド面）。
- そのフォルダを **プラグイン格納ディレクトリ**（`graphy.plugins.dir`、既定 `./plugins`）に置き、**アプリを再読み込み**すれば組み込まれる。
- UI だけのプラグインは **standalone / web 両方**で動く。JAR（バックエンド計算）を伴うものは現状 **standalone のみ**実行可（web はサンドボックス実装まで 501）。

---

## 1. プラグインの構成

```
<graphy.plugins.dir>/
└── my-plugin/                ← フォルダ名は任意（プラグイン 1 個）
    ├── plugin.json           ← 必須。マニフェスト
    ├── ui.js                 ← 任意。フロント面（ES モジュール）
    └── my-plugin.jar         ← 任意。バックエンド面（Java）
```

### plugin.json のフィールド

| キー | 必須 | 説明 |
|---|---|---|
| `id` | ✅ | 一意な ID（`[A-Za-z0-9._-]`、フォルダ名と揃えると分かりやすい） |
| `name` | ✅ | メニューに出る表示名 |
| `version` | ✅ | 版（例 `0.0.1`） |
| `contributes` | UI を出すなら必要 | 出す先サーフェスの配列。`"viewer2d.menu"` / `"mainscreen.menu"`（`"viewer2d.toolbar"` は予約・描画は将来） |
| `ui` | UI を出すなら必要 | フォルダ直下の ES モジュールのファイル名（例 `ui.js`） |
| `entrypoint` | バックエンド面を持つなら必要 | `GraphyPlugin` 実装クラスの完全修飾名 |
| `permissions` | 任意 | 要求権限（現状は情報表示のみ） |

**サーフェスと出る場所**（詳細は plugin-architecture.md §2.1）

| `contributes` の値 | 出る場所 | 用途 |
|---|---|---|
| `viewer2d.menu` | 2D Viewer の「Plug-ins」メニュー | 表示中の画像への処理・ツール |
| `mainscreen.menu` | MainScreen の「Plug-Ins」メニュー | DB・その他機能 |

---

## 2. サンプル A：フロントのみのプラグイン（両モード動作）

「2D Viewer では表示画像を反転」「MainScreen では選択スタディを通知」する最小例。
リポジトリ同梱の `plugins/sample-hello/` と同じもの。

### 2-1. `plugin.json`

```json
{
  "id": "sample-hello",
  "name": "Sample: Hello",
  "version": "0.0.1",
  "contributes": ["viewer2d.menu", "mainscreen.menu"],
  "ui": "ui.js"
}
```

### 2-2. `ui.js`

ES モジュールとして `activate(host)` を **named export** する（`export default { activate }` でも可）。
ビルド不要。backend が `text/javascript` として配信し、フロントが動的 `import()` で読み込む。

```js
// activate(host) がメニュークリック時に呼ばれる。host はサーフェス別のコンテキスト。
export function activate(host) {
  if (host.surface === "viewer2d.menu" || host.surface === "viewer2d.toolbar") {
    host.actions.invert();                 // 2D Viewer 面: 表示中タイルを反転
    host.notify("sample-hello: inverted current tile(s)");
  } else {
    host.notify("sample-hello: study = " + (host.selectedStudyUid || "(none)"));
  }
}
```

### 2-3. host（`activate` に渡るコンテキスト）

共通:

| プロパティ | 説明 |
|---|---|
| `surface` | 呼び出し元サーフェス（`"viewer2d.menu"` / `"mainscreen.menu"` など） |
| `pluginId` | 自分の `id` |
| `t(key)` | i18n 取得関数（ホスト言語に追従） |
| `notify(msg)` | ユーザーへの簡易通知 |
| `runBackend(payload?)` | `POST /api/plugins/{id}/run` を呼ぶ（バックエンド面がある場合）。`Promise` を返す |

サーフェス別:

| サーフェス | 追加プロパティ |
|---|---|
| `viewer2d.menu` / `viewer2d.toolbar` | `actions`（表示中タイルへの操作。`invert()` / `rotate90()` / `fit()` 等。定義は `frontend/src/viewer2d/Viewer2DToolbar.tsx` の `ViewerActions`）<br>`getTargets()` / `getViewState()` / `getPixelData()` / `showOverlay()` / `clearOverlay()` / `saveDerivedSeries()` / `getRois()` / `getRoiMeta()` / `setRoiMeta()` / `subscribeRois()`（**0.1.9 以降**。下記） |
| `mainscreen.menu` | `selectedStudyUid`（選択中スタディの UID、未選択なら `null`） |

**問い合わせ・オーバーレイ・保存・ROI（0.1.9 以降・[`plugin-architecture.md` §7](plugin-architecture.md#7-host-api-の拡張h1h5-実装済み) の H1〜H5）**:

| メソッド | 戻り |
|---|---|
| `getTargets()` | 操作対象タイル（選択→無ければ全＝`actions` と同じ対象）の配列。要素は `{ tileId, studyUid, seriesUid, seriesLabel, imageId, sliceIndex, sliceCount, c, t, modality }` |
| `getViewState(tileId?)` | `{ tileId, windowCenter, windowWidth, unit, colormap, invert, flipH, flipV, rotation, zoom, pan }`。省略時は対象の先頭タイル。取得不能なら `null` |
| `getPixelData(tileId?, opts?)` | `Promise<{ tileId, imageId, sliceIndex, rows, cols, data, unit, spacing } \| null>`。`data` は `Float32Array`（row-major・`data[y*cols+x]`）の**校正済み画素**（CT なら HU）。`opts.sliceIndex` で別スライス（既定は表示中） |
| `showOverlay(tileId?, overlay)` | 処理結果（値マップ）を表示中スライスに重ねる。`overlay = { data, rows, cols, window?, colormap?, opacity? }`。格子が現在スライスと不一致なら `false` |
| `clearOverlay(tileId?)` | オーバーレイを消す |
| `saveDerivedSeries(tileId?, req)` | 処理結果を**派生シリーズとして保存**（standalone は保管庫、web は PACS）。`Promise<{ ok, cancelled?, seriesInstanceUid?, instanceCount?, error? }>`。**本体が必ず確認ダイアログを出す** |
| `getRois(tileId?)` | ユーザーが描いた **ROI（計測）** の配列。要素は `{ roiUid, tool, label, tileId, studyUid, seriesUid, sopInstanceUid, sliceIndex, zScope, c, t, points, spacing, measurements, visible }`。**省略時は対象タイル全部**（他と違う） |
| `getRoiMeta(roiUid)` | ROI に紐付けた**このプラグインの属性**（`Record<string,string>`）。未設定なら `{}` |
| `setRoiMeta(roiUid, patch)` | 同属性を書く（マージ）。ROI が無ければ `false` |
| `subscribeRois(cb)` | ROI の追加/変更/削除を購読。返り値で解除。**差分は渡さない**ので `getRois()` を読み直す |

- **呼ぶたびに現在値を読む**。ダイアログを開いている間にユーザーがスライスを送るので、
  活性化時に一度読んだ値を持ち回らないこと。
- `colormap` は LUT ダイアログの名前（例 `"10_Percent"`）。未適用は `null`。
- `getTargets()` は**空配列を返し得る**（Fusion の子や破棄途中のタイルは現れない）。必ず扱うこと。
- `getPixelData()` の値は**表示 W/L を通していない定量値**（W/L や LUT を変えても不変）。
  カラー画像は輝度に落ちて `unit === "raw"`。
- **1 回 1 スライス**。シリーズを回すなら `sliceIndex` を変えて `await` を繰り返す
  （512×512×500 を Float32 で全部持つと 500MB を超える）。範囲外の `sliceIndex` は `null`
  ＝末尾へ丸めたりしない。
- 画素を読むプラグインは `plugin.json` の `permissions` に `"read-pixels"` を宣言する
  （導入時の同意画面に出る）。**現状これは強制ではない**（サンドボックスは P3）。

**オーバーレイ（H4a）の要点**:

- 渡すのは**値**（`Float32Array`）で、色付け（`window` / `colormap` / `opacity`）は本体がする。
  `colormap` には本体の LUT 名（`/api/luts`。例 `"Hot_Iron"`）を指定できる。
- **`NaN` は透明**。マスクや部分的なマップをそのまま渡せる。
- `rows`/`cols` は**現在スライスと一致**していること（不一致は `false`）。
- オーバーレイは**出したスライスに紐付く**（他スライスでは隠れ、戻ると再表示。シリーズ切替で破棄）。
- 本体が画像左下に `プラグイン: <名前>` のラベルを必ず出す（出所の明示）。
- **保存はされない**。派生シリーズとして保管庫や PACS へ書くのは `saveDerivedSeries()`（H4b）。

```js
// 例: 300 HU 以上（骨・造影）だけを Hot_Iron で重ねる
const px = await host.getPixelData();
if (px) {
  const mask = new Float32Array(px.data.length);
  for (let i = 0; i < px.data.length; i++) mask[i] = px.data[i] >= 300 ? px.data[i] : NaN;
  host.showOverlay(px.tileId, { data: mask, rows: px.rows, cols: px.cols, colormap: "Hot_Iron", opacity: 0.6 });
}
```

```js
// 例: 表示中スライスの平均 HU
const px = await host.getPixelData();
if (px) {
  let sum = 0;
  for (const v of px.data) sum += v;
  host.notify(`mean = ${(sum / px.data.length).toFixed(1)} ${px.unit}`);
}
```

**共通の注意**:

- `getViewState()` の W/L は**モダリティ値空間**（CT なら HU。単位は `unit`）。表示 8bit ではない。
- これらを使うプラグインは `engines.graphy` を `">=0.1.9"` に上げる
  （古い本体には導入されない＝意図した挙動）。
- **保存（`saveDerivedSeries`）の要点**:
  - **本体が必ず確認ダイアログを出す**（抑止不可）。ユーザーが拒否すると `{ ok: false, cancelled: true }`。
  - **幾何はプラグインが書かない**。各フレームは `sliceIndex`（元シリーズのどのスライスに対応するか）
    だけを申告し、IPP / IOP / PixelSpacing / 厚みは本体が元シリーズから引き継ぐ。
    `rows`/`cols` は元スライスと一致必須。
  - 画素は 16bit signed ＋ Rescale で保存される。**HU のような整数はそのまま**、確率マップのような
    小さい実数は値域から係数を決めて量子化。`NaN` は「データ無し」として値域の最小値になる。
  - 保存されたシリーズは `SeriesDescription` に **`[Plugin] ` 接頭辞**が付き、
    `DerivationDescription` / `ContributingEquipmentSequence` にプラグイン id・版が残る（消せない）。
  - **元シリーズは変更されない**（新しいシリーズが 1 本増えるだけ）。

```js
// 例: 閾値マスクを派生シリーズとして保存する
const px = await host.getPixelData();
if (px) {
  const mask = new Float32Array(px.data.length);
  for (let i = 0; i < px.data.length; i++) mask[i] = px.data[i] >= 300 ? px.data[i] : NaN;
  const res = await host.saveDerivedSeries(px.tileId, {
    seriesDescription: "Bone mask",
    derivationDescription: "Threshold >= 300 HU",
    frames: [{ sliceIndex: px.sliceIndex, data: mask }],
    rows: px.rows,
    cols: px.cols,
    unit: px.unit,
  });
  host.notify(res.ok ? `saved ${res.instanceCount}` : res.cancelled ? "cancelled" : `failed: ${res.error}`);
}
```

**ROI（H5）の要点** — 計測ドリブンのプラグイン（RECIST 1.1 等）を書くならここが本題:

- **長径・短径は 2 系統返る**。取り違えると測定値が変わるので、どちらを使うか意識して選ぶ。
  - ROI メニューの **「長径・短径（RECIST）」＝`Bidirectional`** … ユーザーが 2 軸を明示的に引く。
    `measurements.length`（長軸）/ `measurements.shortAxis`（短軸）を使う。**読影医の意図がこれ**。
  - 楕円・矩形・円・自由曲線・スプライン・Length … `measurements.longAxisMm` / `shortAxisMm`
    （形状から本体が算出。最遠 2 点と、それに**直交**する方向の広がり）。
  - **Bidirectional では形状値（`longAxisMm` / `shortAxisMm`）は `undefined`**。ユーザーが引いた
    2 軸そのものが計測値であり、交差する 2 線分から形状の長径を出すと（短軸を端に寄せた場合）
    ユーザーの長軸を超える値が出るため、意図的に出していない。
  - Angle / Probe / ArrowAnnotate、および本体が知らないツールにも形状値は出ない。
  - 短径は「長径に直交する幅」で、全方位の最小キャリパ幅（ImageJ の MinFeret）**ではない**
    （RECIST が長径に直交して測ると規定しているため）。
- **画素間隔が不明なシリーズでは算出値が `undefined`**（mm を捏造しない）。ツール値の
  `length` / `shortAxis` も同様に出ない（本体が px で計算した値を mm として渡さないため）。
  統計も取れない項目は `undefined` で、**0 では埋まらない**（「測っていない」と「0 だった」は別）。
  `mean` 等は Cornerstone が**描画時に**計算するので、画面に出ていない ROI では空になり得る。
- `measurements.unit` は**統計値**（`mean` / `stdDev` / `min` / `max`）の単位（"HU" / "SUVbw"）。
  長さは常に mm、面積は mm² なので、そこの単位ではない。
- ⚠ **`roiUid` はセッション内でしか安定しない**。本体に ROI の永続化が無く、アプリを再起動すると
  別 UID の別 ROI になる。**時系列で同じ病変を追うなら `roiUid` を鍵にしてはいけない**。
  `sopInstanceUid` ＋ `points`（画素座標）＋自分で振った ID を、プラグイン側に保存すること。
  `setRoiMeta()` の属性も ROI と同じ寿命しか持たない。
- ⚠ **`zScope === "all"`（global ROI）は弾く**。本体は全スライス共通 ROI の参照先を表示スライスへ
  追従させるので、`sliceIndex` / `sopInstanceUid` は「いま見ているスライス」を指すだけで
  病変の位置ではない。
- `getRois()` の既定対象は**対象タイル全部**（他の問い合わせ系は「先頭タイル」）。
  ベースラインと追跡を並べて開く用途を想定している。単一タイルなら `tileId` を渡す。
- `subscribeRois()` は**何が変わったかを渡さない**。通知が来たら `getRois()` を読み直す。
  ダイアログを閉じるときは**必ず解除**する。
- ROI の**書き込み（プラグインから ROI を作る・動かす）はできない**。読影医が引いた計測を
  プラグインが書き換えられないようにしてある。マスク（labelmap）の読み出しも未対応。

```js
// 例: RECIST の標的病変の和（SLD）— リンパ節は短径、それ以外は長径で足す
const unsub = host.subscribeRois(() => refresh());   // 編集に追随。閉じるときに unsub()
function refresh() {
  let sld = 0;
  for (const r of host.getRois()) {
    if (r.zScope === "all") continue;                // global ROI は病変位置を持たない
    const meta = host.getRoiMeta(r.roiUid);          // 自分が付けた属性（追跡 ID・リンパ節か 等）
    const isNode = meta.lymphNode === "true";
    // Bidirectional はユーザーが引いた軸、それ以外は形状からの算出値。
    const long = r.measurements.length ?? r.measurements.longAxisMm;
    const short = r.measurements.shortAxis ?? r.measurements.shortAxisMm;
    const size = isNode ? short : long;
    if (size === undefined) continue;                // 画素間隔不明などで測れないものは足さない
    sld += size;
  }
  host.notify(`SLD = ${sld.toFixed(1)} mm`);
}
```

> 型定義の実体は `frontend/src/plugins/pluginTypes.ts`。

---

## 3. サンプル B：バックエンド面つき（JAR）— 現状 standalone のみ

重い計算を Java 側で行う例。`GraphyPlugin` を実装した JAR を同梱し、UI から `runBackend()` で呼ぶ。

### 3-1. SPI

プラグイン JAR は次の 1 インターフェースだけ実装すればよい（JDK 標準型のみ）。

```java
package com.vis.graphynext.plugin.spi;
public interface GraphyPlugin {
    Object run(Map<String, Object> args) throws Exception;  // 戻り値は JSON 化して返る
}
```

### 3-2. 実装クラス

```java
package com.vis.plugins;

import com.vis.graphynext.plugin.spi.GraphyPlugin;
import java.util.Map;

public class HelloPlugin implements GraphyPlugin {
    @Override
    public Object run(Map<String, Object> args) {
        // args は POST /api/plugins/{id}/run の要求本文
        return Map.of("ok", true, "echo", args, "msg", "hello from backend plugin JAR");
    }
}
```

### 3-3. コンパイルと JAR 化

SPI をクラスパスに通してコンパイルする。手早くやるなら backend のビルド済みクラスを使う:

```bash
# 事前に backend をビルドしておく: (cd backend && mvn -o compile)
SPI=backend/target/classes
javac -cp "$SPI" -d out src/com/vis/plugins/HelloPlugin.java
(cd out && jar cf ../hello.jar com)
```

> Maven で作るなら、SPI を `provided` 依存として参照する薄い JAR にすればよい（SPI はランタイムで
> backend 側が供給する。プラグイン JAR に同梱しないこと）。

### 3-4. `plugin.json`

```json
{
  "id": "hello-backend",
  "name": "Hello Backend",
  "version": "0.0.1",
  "contributes": ["mainscreen.menu"],
  "ui": "ui.js",
  "entrypoint": "com.vis.plugins.HelloPlugin",
  "permissions": ["read-pixels"]
}
```

### 3-5. UI から backend を呼ぶ `ui.js`

```js
export function activate(host) {
  host.runBackend({ from: "ui" }).then((result) => host.notify(JSON.stringify(result)));
}
```

配置後の実行フロー:

```
メニュークリック → activate(host) → host.runBackend(payload)
   → POST /api/plugins/hello-backend/run
   → backend が JAR を URLClassLoader でロード → HelloPlugin.run(payload)
   → 戻り値 JSON が Promise で返る
```

> **web モードでの注意**: 共有サーバーへの任意 JAR ロードは行わないため、`run()` は現状 **501** を返す
> （サンドボックス実装は将来）。バックエンド面つきプラグインは当面 **standalone 前提**。
> UI 完結（`entrypoint` なし）のプラグインは web でも動く。

---

## 4. インストール

### 4-1. 格納先ディレクトリ

プラグインフォルダを `graphy.plugins.dir` の下に置く（既定 `./plugins`、`application.yml` / 引数 / 環境で変更可）。
このパスは backend の **CWD からの相対パス**として解決される点に注意（`PluginProperties`、既定 `./plugins`）。

- **standalone（Electron・インストール済みアプリ）**: `desktop/main.js` の `resolveDataDir()` が、
  パッケージ版では backend の CWD を **OS 標準のユーザーデータ領域**（`app.getPath("appData")` 直下の
  `GRAPHY-Next`）に固定する。`--graphy.plugins.dir` 起動引数は**渡していない**ため、実際の格納先は
  常にこの固定パス配下の `plugins/` になる（Help＞Uninstall ダイアログに出る「保存データ」パスと同一）。

  | OS | 実際の格納先 |
  |---|---|
  | Windows | `%APPDATA%\GRAPHY-Next\plugins`（実体は `C:\Users\<ユーザー名>\AppData\Roaming\GRAPHY-Next\plugins`） |
  | macOS | `~/Library/Application Support/GRAPHY-Next/plugins` |
  | Linux（AppImage） | `~/.config/GRAPHY-Next/plugins` |

  開発時（`npm run dev-desktop` 等、未パッケージ）は `resolveDataDir()` が `process.cwd()`（通常 `desktop/`）を
  そのまま使うため、`desktop/plugins/` が格納先になる。

- **web（共有サーバー）**: 運営（サーバー管理者）が審査済みプラグインを配備するフォルダを指す。
  エンドユーザーによるアップロードは提供しない。

配置例（Windows・インストール済みアプリ）:

```
%APPDATA%\GRAPHY-Next\plugins\
└── sample-hello\
    ├── plugin.json
    └── ui.js
```

`graphy.plugins.dir` を明示的に変えたい場合（standalone を独自ビルドで動かす場合など）は
`application.yml` またはプロファイル別 yml で:

```yaml
graphy:
  plugins:
    enabled: true
    dir: /home/me/.graphy-next/plugins
```

または起動引数（`desktop/main.js` は現状これを渡さないため、backend を直接起動する場合のみ有効）:

```bash
java -jar graphy-next-backend.jar --graphy.plugins.dir=/home/me/.graphy-next/plugins
```

### 4-2. 反映

- マニフェスト一覧は `GET /api/plugins` を叩くたびにディレクトリを走査するので、backend 自体の
  **再起動は不要**（走査は都度実行）。
- ただしフロントは起動時に一覧を取得してキャッシュするため、**画面のリロードが必要**。インストール済み
  パッケージ版にはリロード用の UI 操作（開発者ツール等）が用意されていないため、実務上は
  **GRAPHY-Next を完全に終了してから再起動する**のが確実な反映方法。
- 同一 `id` の JAR を差し替えた場合は、クラスローダをキャッシュしている都合上 backend の再起動
  （＝アプリの完全な終了→再起動）が確実に必要。

---

## 5. 動作確認

CLI で契約を直接叩ける（`8080` は環境に合わせる）:

```bash
# 一覧
curl -s http://localhost:8080/api/plugins

# UI バンドル配信（Content-Type: text/javascript）
curl -s http://localhost:8080/api/plugins/sample-hello/ui.js

# バックエンド実行（standalone。web は 501）
curl -s -X POST http://localhost:8080/api/plugins/hello-backend/run \
  -H 'Content-Type: application/json' -d '{"x":42}'
```

UI 上では:
- 2D Viewer の **Plug-ins** メニュー、または MainScreen の **Plug-Ins** メニューに `name` が並ぶ。
- クリックで `activate(host)` が走る。

---

## 6. うまくいかないとき

| 症状 | 見るところ |
|---|---|
| メニューに出ない | `plugin.json` の JSON 妥当性 / `id` 空でないか / `contributes` にサーフェス名があるか / アプリをリロードしたか |
| メニューには出るがクリックで無反応 | `ui.js` が `activate` を **export** しているか / ブラウザのコンソールに import エラーが出ていないか |
| `ui.js` が 404 | `plugin.json` の `ui` とファイル名が一致するか / ファイルがフォルダ直下にあるか |
| `run` が 501 | web モードは backend 実行不可（仕様）。standalone で試す |
| `run` が 404 | `id` 不一致、または `entrypoint` 未指定 |
| `run` が 500 | `entrypoint` の FQN 誤り / クラスが `GraphyPlugin` 未実装 / JAR がフォルダ直下にない。backend ログ `[plugins] run failed ...` を確認 |
| backend ログに `[plugins] ... registry root=... enabled=...` が出ない | `graphy.plugins.enabled` と `dir` を確認 |

---

## 7. 配布（GitHub Release）とテンプレート

第三者が自作プラグインを配布する場合は、**GitHub の Release タグ**で配る（GRAPHY-Next のプラグイン
マネージャが `owner/repo` から取得・検証・導入する。設計: [`plugin-manager-design.md`](plugin-manager-design.md)）。

- **雛形**: `examples/plugin-template/` を fork/コピーして始める（`plugin.json` / `ui.js` /
  型補完用 `graphy-plugin.d.ts` / タグ push で `<id>-<version>.zip`+`.sha256` を作る GitHub Action /
  任意の Java バックエンド面 `backend-optional/` 一式）。
- **配布物**: リリース資産は**直下に `plugin.json` を置いたビルド済み zip**（`<id>-<version>.zip`）。
  `.sha256` を添付するとマネージャが取得時に完全性検証する。
- **Java バックエンド面**: backend 全体ではなく薄い **`graphy-plugin-api`** に対してコンパイルする。
  GRAPHY-Next の Release に添付される `graphy-plugin-api-<version>.jar` を `provided` 依存として使う
  （`examples/plugin-template/backend-optional/README.md`）。

## 8. 参考

- **動くデモ（2026-07-29 追加）**: [`graphy-next-plugin-demos`](https://github.com/tatsunidas/graphy-next-plugin-demos)
  （ハブ＝実質の開発ガイド）／[hello](https://github.com/tatsunidas/graphy-next-plugin-hello)（最小形）／
  [mean-filter](https://github.com/tatsunidas/graphy-next-plugin-mean-filter)（表示中シリーズへの画素処理）／
  [gemini-findings](https://github.com/tatsunidas/graphy-next-plugin-gemini-findings)（JAR から外部 API）。
  各 README は単体で完結する。全体像は [`plugin-explainer.md`](plugin-explainer.md) §6
- 設計・信頼モデル・両モードの違い: [`plugin-architecture.md`](plugin-architecture.md)
- マネージャ（取得・導入・更新・削除）: [`plugin-manager-design.md`](plugin-manager-design.md)
- テンプレート: `examples/plugin-template/`
- フロント型定義・ローダ: `frontend/src/plugins/`（`pluginTypes.ts` / `pluginRegistry.ts`）
- backend 実装: `backend/.../com/vis/graphynext/plugin/`（`PluginController` / `*PluginRegistry` / `spi/GraphyPlugin` / `manager/`）
- 同梱サンプル: `plugins/sample-hello/`
