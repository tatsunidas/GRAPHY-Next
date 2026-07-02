# GRAPHY-Next プラグイン作成ガイド

> 作成日: 2026-07-02
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
| `viewer2d.menu` / `viewer2d.toolbar` | `actions`（表示中タイルへの操作。`invert()` / `rotate90()` / `fit()` 等。定義は `frontend/src/viewer2d/Viewer2DToolbar.tsx` の `ViewerActions`） |
| `mainscreen.menu` | `selectedStudyUid`（選択中スタディの UID、未選択なら `null`） |

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

- **standalone（Electron）**: AppImage 等は読み取り専用のため、**ユーザー書込可能な場所**を使う。
  推奨は `~/.graphy-next/plugins`。Electron 起動時に backend へ `--graphy.plugins.dir=<path>` として渡す想定。
- **web（共有サーバー）**: 運営（サーバー管理者）が審査済みプラグインを配備するフォルダを指す。
  エンドユーザーによるアップロードは提供しない。

配置例:

```
~/.graphy-next/plugins/
└── sample-hello/
    ├── plugin.json
    └── ui.js
```

設定で明示する場合（`application.yml` またはプロファイル別 yml）:

```yaml
graphy:
  plugins:
    enabled: true
    dir: /home/me/.graphy-next/plugins
```

または起動引数:

```bash
java -jar graphy-next-backend.jar --graphy.plugins.dir=/home/me/.graphy-next/plugins
```

### 4-2. 反映

- マニフェスト一覧は `GET /api/plugins` を叩くたびにディレクトリを走査するので、**アプリ（ビューア画面）を
  再読み込み**すれば新しいプラグインがメニューに出る（フロントは起動時に一覧を取得しキャッシュするため、
  追加後はリロードが必要）。
- backend プロセスの**再起動は不要**（走査は都度実行）。ただし同一 `id` の JAR を差し替えた場合は、
  クラスローダをキャッシュしている都合上 backend の再起動が確実。

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

## 7. 参考

- 設計・信頼モデル・両モードの違い: [`plugin-architecture.md`](plugin-architecture.md)
- フロント型定義・ローダ: `frontend/src/plugins/`（`pluginTypes.ts` / `pluginRegistry.ts`）
- backend 実装: `backend/.../com/vis/graphynext/plugin/`（`PluginController` / `*PluginRegistry` / `spi/GraphyPlugin`）
- 同梱サンプル: `plugins/sample-hello/`
