# GRAPHY-Next プラグインマネージャ 設計

> 作成日: 2026-07-23
> ステータス: **P1 backend コア実装済み（standalone・テスト green）**。フロント UI / テンプレ配布 / 署名 / OAuth は将来。
> 関連: [`plugin-architecture.md`](plugin-architecture.md)（実行レイヤ＝継ぎ目）、[`plugin-authoring-guide.md`](plugin-authoring-guide.md)

ImageJ/Fiji の "update site" に相当する、プラグインの**配布・取得・ライフサイクル管理**レイヤ。
実行レイヤ（`PluginRegistry` / `/api/plugins` / `ui.js` 動的 import / JAR 実行）は
[`plugin-architecture.md`](plugin-architecture.md) で実装済みで、本書はその**上に載る管理レイヤ**を定義する。

---

## 1. 2 レイヤ構成

```
┌─ 管理レイヤ（本書・新規）───────────────────────────────────┐
│ 発見(index/GitHub) → 取得(Release資産DL) → 検証(sha256/署名)  │
│ → 展開(<pluginsDir>/<id>/) → 台帳(installed.json)            │
│ → 更新/削除/再インストール/有効無効/互換チェック             │
│   REST: /api/plugin-manager/*                                │
└──────────────────────────┬────────────────────────────────┘
                           │ フォルダ＋台帳＋.disabled マーカーを書くだけ
┌─ 実行レイヤ（既存・plugin-architecture.md）───────────────────┐
│ FileSystemPluginRegistry がフォルダ走査 → /api/plugins 配信    │
│ → React が動的 import(ui.js) / POST run で JAR 実行           │
└──────────────────────────────────────────────────────────┘
```

**原則**: 実行レイヤの契約（`/api/plugins`）は変えない。管理は別 API・別パッケージ
（`com.vis.graphynext.plugin.manager`）に隔離する。有効/無効は実行レイヤが `.disabled`
マーカーを見てスキップするだけ（疎結合）。

---

## 2. 配布モデル — GitHub Release の「ビルド済み zip 資産」

タグ＝バージョン（semver `v1.2.3`）。各リリースは以下の資産を持つ:

| 資産 | 内容 | 状態 |
|---|---|---|
| `<id>-<version>.zip` | `plugin.json` ＋任意 `ui.js` / `*.jar` | P1（必須） |
| `<id>-<version>.zip.sha256` | 完全性検証 | P1（あれば検証、無ければskip） |
| `<id>-<version>.zip.minisig` | 署名（真正性） | P2 |

- zip は**直下に `plugin.json`** を置く構成が基本。単一ラップフォルダ（`repo-1.2.3/plugin.json`）
  も自動で剥がす（`PluginPackage.manifestBasePrefix`）。
- source tarball ではなく**ビルド済み zip 資産**を使う（`ui.js` はトランスパイル後、`*.jar` は
  コンパイル後の成果物が要るため）。テンプレの GitHub Action で自動生成（将来）。

---

## 3. マニフェスト拡張（`plugin.json`）

実行レイヤは未知フィールドを無視する前方互換のため、管理用は**加算のみ**（`PluginDescriptor` に実装済み）:

```jsonc
{
  "id": "computed-dwi", "name": "Computed DWI", "version": "1.2.3",
  "contributes": ["viewer2d.menu"], "ui": "ui.js", "entrypoint": "...", "permissions": ["read-pixels"],
  "engines": { "graphy": ">=0.2.0 <0.3.0" },   // ★ コア互換範囲（/api/status の version と照合）
  "description": "...", "author": "...", "homepage": "...", "license": "Apache-2.0"  // ★ 表示・法務
}
```

互換判定は最小 SemVer（`SemVer.satisfies`）。演算子 `>= <= > < =`＋空白 AND。`*`/空/未指定は常に互換。
コアが非 semver（dev ビルドの `"dev"`）ならゲートしない。

---

## 4. インストール台帳 `installed.json`

folder 走査だけでは「どこから来たか・完全性・有効か」が分からないため別途保持する
（`<pluginsDir>/installed.json`、`PluginLedger` が原子的に書く）:

```jsonc
[{ "id":"computed-dwi", "version":"1.2.3",
   "source":{"type":"github","ref":"owner/computed-dwi"},   // type: github|file|index
   "sha256":"…", "enabled":true, "pinned":false, "installedAt":"2026-…Z", "trust":"community" }]
```

---

## 5. 実装（P1・backend・standalone）

パッケージ `com.vis.graphynext.plugin.manager`:

| 型 | 役割 |
|---|---|
| `SemVer` | 最小 semver 比較＋`engines` 範囲判定（外部依存なし） |
| `PluginPackage` | zip の sha256 / manifest 読取 / 展開。**zip slip・サイズ超過ガード** |
| `PluginLedger` | `installed.json` の読み書き（temp→原子的 move、破損時は空扱い） |
| `InstalledPlugin` | 台帳エントリ（record、`Source` 入れ子） |
| `PluginInstaller` | **コア（Spring 非依存＝単体テスト可能）**。install/uninstall/enable/disable/互換判定 |
| `GitHubReleaseClient` | 継ぎ目（interface）。`HttpGitHubReleaseClient`＝JDK `HttpClient` 実装 |
| `PluginManagerService` | 取得元解決（release 選択・zip資産・sha256資産）＋モードゲート |
| `PluginManagerController` | `/api/plugin-manager/*`。例外→HTTP 写像 |

REST（`/api/plugin-manager`）:

```
GET    /status                     導入操作の可否（canManage / standalone / managerEnabled / hasToken）
GET    /installed                  導入済み一覧（台帳）※常に可
GET    /versions?repo=owner/repo   リリース一覧（新しい順）
POST   /install/github  {repo, version?}   version 未指定＝最新の非 prerelease
POST   /install/file    (multipart)        ローカル zip（オフライン/エアギャップ導入）
POST   /{id}/reinstall             取得元から再取得（github のみ。file は再アップロード）
POST   /{id}/enable | /{id}/disable
DELETE /{id}                       アンインストール
```

例外写像: 403（モード非許可）/ 404（未導入）/ 422（検証失敗）/ 400（不正引数）/ 500。

**セキュリティ実装済み**: sha256 検証、zip slip 防止、id 検証（`[A-Za-z0-9._-]`・`..` 拒否）、
`owner/repo` 形式検証（SSRF/注入対策）、展開サイズ/件数上限。

**モードゲート**（`PluginManagerService.requireMutable`）: 導入系は
`standalone` かつ `graphy.plugins.manager-enabled=true` のときのみ許可。web は 403
（共有サーバー＝運営キュレーション前提、[`plugin-architecture.md §3`](plugin-architecture.md)）。
一覧・status は常に可。

設定（`graphy.plugins.*` / `PluginProperties`）: `manager-enabled`（既定 false）、`github-token`（PAT・任意）、
`index-url`（将来の discovery・任意）。

テスト: `SemVerTest`(6) / `PluginInstallerTest`(10) / `PluginManagerServiceTest`(5) = 21、全 green。
ネットワーク非依存（zip はメモリ生成、GitHub は fake client）。

---

## 6. 私有・クローズドなプラグイン

- **個人/組織内 private** → GitHub 認証で可視化。P1 は PAT（`github-token`）で private repo の
  列挙・資産取得。P2 で **OAuth Device Flow**（本人トークンをサーバ側に暗号化保持）。
  組織配布は **private 索引リポジトリ**（`myorg/graphy-plugins-private`）をカスタムソース指定。
- **商用クローズド製品** → GitHub のアクセス制御に頼らず、**配布は開放・利用をライセンスキー/
  エンタイトルメントで制限**（既存 EULA 2 トラックと整合、[[eula-structure-decision]]）。P3。

---

## 7. web モードの扱い

[`plugin-architecture.md §3`](plugin-architecture.md) の通り、web は共有 JVM・`run()` 501・
本番 read_only コンテナのため**エンドユーザー install 不可**。マネージャは web では
「運営配備済みの一覧閲覧＋UI-only 起動」に縮退（導入系 API は 403）。
ユーザー自由 install を web で実現するなら **クライアント WASM** か **サーバ側サンドボックス
（別プロセス/コンテナ/サイドカー）**。dcm4chee 前提なら後者が「プラグイン＝独立 DICOMweb
クライアント・サービス（WADO-RS 取得→STOW-RS 書き戻し・スコープ付き AE・ATNA 監査）」として
最も自然に成立する。

---

## 8. ロードマップ

- **P1（実装済み・backend）**: 台帳／GitHub install（sha256）／オフライン zip／
  uninstall・reinstall・enable-disable／`engines` 互換／`/api/plugin-manager/*`／モードゲート。
- **P2**: フロント Plugin Manager 画面／`graphy-plugin-api` 公開パッケージ＋テンプレリポジトリ＋
  GitHub Action／公式索引 discovery／GitHub OAuth Device Flow／**minisign 署名＋3 信頼ティア＋
  インストール時同意画面**／更新通知＋changelog／再起動反映（`graphy:relaunch`）。
- **P3**: フロント iframe/Worker サンドボックス／backend プロセス隔離／web サンドボックス
  （DICOMweb サイドカー）／商用ライセンスキー／ロールバック履歴／障害プラグインの自動無効化。

---

## 9. 既知の制約（P1）

- **JAR 差し替えの反映**: `StandalonePluginRegistry` がクラスローダを id 単位でキャッシュするため、
  同 id の JAR 更新は backend 再起動（＝アプリ再起動）まで反映されない。UI-only は画面リロードで反映。
- **フロント UI 未実装**: 現状 API のみ。`curl` / 将来の Plugin Manager 画面から叩く。
- **署名・権限 enforce 未実装**: `trust` は github=community / file=local を機械的に付与。
  署名検証と権限の実強制は P2/P3。
- **discovery 未実装**: `index-url` は設定のみ。索引取得＋トピック検索は P2。
- **file 由来の reinstall 不可**: zip を保持しないため再アップロードが必要。
