# GRAPHY-Next プラグイン アーキテクチャ設計

> 作成日: 2026-06-28
> ステータス: 設計確定（実装は未着手）
> 関連: [`development-phases.md`](development-phases.md)、[`dicom-data-layer.md`](dicom-data-layer.md)

GRAPHY のプラグイン機構を、standalone / web の 2 モードに対応する形で再設計する。

---

## 1. GRAPHY 現状（出発点）

- `plugins/` フォルダに **Java の JAR**（例: `ComputedDWI`, `LesionEvanesco`）を置く。
- `PluginShelf` ＋ `PluginClassLoader`（URLClassLoader）が起動時にフォルダを走査し、
  **`PlugIn` インターフェース**（`ToolbarPlugIn`＝ツールバー追加、`PlugInFunction` 等）を実装した
  クラスを `Class.getDeclaredConstructor().newInstance()` で生成、`run(args)` で実行。
- つまり **「Java コードを JVM 内に動的ロードし、ツールバー追加＋画像処理を行う」in-process 方式**。

---

## 2. GRAPHY-Next の基本モデル: プラグインは“2 面”

Spring Boot(Java) ＋ React(JS) の分離構成のため、1 プラグインが最大 2 つの成果物を持つ。

| 面 | 中身 | 実行場所 |
|---|---|---|
| **バックエンド面** | 計算・画像処理（Java JAR） | Spring Boot の JVM |
| **フロント面** | ツールバー / パネル等の UI（JS / ES モジュール） | ブラウザ（React） |

両者を **`PluginRegistry` という継ぎ目**で抽象化する（`DicomDataService` と同じ思想）。
フロントは常に **`GET /api/plugins`（マニフェスト）** を叩くだけで、プラグインの出所を意識しない。

```
React  ──fetch /api/plugins──▶ マニフェスト(id, 名前, UIバンドルURL, backend entrypoint, 必要権限)
  │                                    ▲
  └─動的 import(UIバンドル)            │ StandalonePluginRegistry / WebPluginRegistry
                                       │
ツール実行 ──POST /api/plugins/{id}/run──▶ backend の処理（JAR内の処理 or サンドボックス）
```

### プラグイン マニフェスト（案）
```json
{
  "id": "computed-dwi",
  "name": "Computed DWI",
  "version": "0.0.1",
  "frontend": { "bundleUrl": "/api/plugins/computed-dwi/ui.js", "contributes": ["toolbar"] },
  "backend":  { "entrypoint": "com.vis.plugins.ComputedDwi", "permissions": ["read-pixels"] }
}
```

---

## 3. モード別の設計

### standalone（Electron + 同梱 Spring Boot）
- backend が **ローカルの `plugins/` フォルダを走査し JAR をクラスローダで読み込む**（GRAPHY と同じ）。
  単一ユーザー＝自分のマシンなので任意 JAR ロードは許容範囲。
- フロント面の JS バンドルも backend がそのフォルダから配信 → React が動的 import。
- **重要な注意**: Electron の AppImage 等は**読み取り専用**。`plugins/` は
  **ユーザー書込可能な場所**（例 `~/.graphy-next/plugins`）に置く。`graphy.plugins.dir` で設定し、
  Electron 起動時に backend へ渡す。GRAPHY の「起動フォルダ直下」は配布形態では使えないことが多い。

### web（共有サーバー）
backend が**共有サーバー（マルチユーザーになり得る）**である点が決定的な違いを生む。

**① ユーザーが JAR をサーバーへ落として動的ロード、は不可（セキュリティ）**
共有 JVM に任意 JAR を読み込ませると、そのプラグインは**サーバー権限で全実行**＝他患者データ読み取り・
サーバー停止・他テナント侵害が可能。standalone の「フォルダから自由にロード」を web に持ち込めない。

**② web のバックエンド面プラグインは「運営が審査・配備」する**
- **管理者キュレーション方式（推奨・現実的）**: 運営（病院IT）が審査済み JAR をサーバー側へ配備。
  エンドユーザーはアップロード不可。`WebPluginRegistry` は「配備済み一覧」を返すだけ。
- **サンドボックス方式（自由だが重い）**: 信頼できないプラグインも動かすなら、別プロセス / 別コンテナ
  （gVisor 等）/ サイドカー マイクロサービスとして隔離実行し、定義済み API 越しに呼ぶ。共有 JVM には load しない。
- **テナント単位**: 各病院が自分のサーバーインスタンスを持つなら、その plugins はテナント管理者が配備＝実質①。

**③ フロント面は web も standalone も同じ**
UI バンドルは backend が ES モジュールとして配信し、React が `import()` で動的ロード。
`/api/plugins` の契約が同一なので、**フロントのプラグイン読み込みコードは両モード共通**。

**④ （将来オプション）クライアント側 WASM プラグイン**
web で計算もクライアント完結させたい場合、プラグインを **WebAssembly** で配布しブラウザ内サンドボックスで
実行する選択肢。サーバー負荷・隔離問題を回避できるが現時点では将来候補。

---

## 4. 対比まとめ

| | standalone | web |
|---|---|---|
| バックエンド面の入手元 | ローカル `plugins/` フォルダ（ユーザー書込可） | **運営配備 or サンドボックス**（ユーザーアップロード不可） |
| 信頼モデル | 単一ユーザー＝自己責任で任意ロード可 | 共有＝審査必須・隔離 |
| フロント面 | backend 配信の JS を動的 import | **同左（共通）** |
| 継ぎ目 | `PluginRegistry` + `/api/plugins` | **同左（共通）** |

**要点**: フロント面と契約（`/api/plugins`）は両モード共通。違いは
バックエンド面の「どこから・どの信頼レベルで load するか」だけ。standalone はローカルフォルダ、
web は運営配備 / サンドボックス。

---

## 5. 実装ステップ（将来）

1. `PluginRegistry` インターフェース + `PluginManifest` DTO。
2. `StandalonePluginRegistry`: `graphy.plugins.dir` を走査、URLClassLoader で JAR ロード、
   `PlugIn` 実装を検出（GRAPHY の `PluginShelf` を移植・整理）。
3. `WebPluginRegistry`: サーバー配備済みプラグインの一覧を返す（ユーザーアップロード不可）。
4. REST: `GET /api/plugins`（マニフェスト）、`GET /api/plugins/{id}/ui.js`（UIバンドル配信）、
   `POST /api/plugins/{id}/run`（backend 処理実行）。
5. フロント: `/api/plugins` を取得 → ツールバー等へ動的 import で組み込む（両モード共通）。
6. UI Phase 2 のツールバーは最初からこの契約に乗せる（後付けより楽）。
7. （後続）サンドボックス実行・権限モデル・署名検証・WASM 対応。
