# GRAPHY-Next プラグインマネージャ 設計

> 作成日: 2026-07-23（最終更新: 2026-07-28）
> ステータス: **P1 backend コア＋P2 フロント UI＋開発キット 実装済み（standalone・テスト green）**。
> 2026-07-28 に導入ゲートを「管理者ゲート＋ユーザーのオプトイン トグル」の 2 段に変更（§5）。
> 署名 / discovery / OAuth は将来（§8 の P2 残）。
> 関連: [`plugin-architecture.md`](plugin-architecture.md)（実行レイヤ＝継ぎ目）、[`plugin-authoring-guide.md`](plugin-authoring-guide.md)
>
> 📖 **全体像を先に掴むなら [`plugin-explainer.md`](plugin-explainer.md)**（2 レイヤ・導入の全経路・
> 4 段の検証・web/desktop の違いを 1 本にまとめた解説。GRAPHY Lab 記事の原稿もここから）

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
GET    /status                     導入操作の可否（canManage / standalone / managerEnabled /
                                   installEnabled / canOptIn / hasToken）
GET    /installed                  導入済み一覧（台帳）※常に可
GET    /versions?repo=owner/repo   リリース一覧（新しい順）
POST   /inspect/github {repo, version?}    取得して中身を検査（展開しない）→ PluginPreview
POST   /inspect/file   (multipart)         同上（ローカル zip）
POST   /install/github {repo, version?, confirmedSha256?, acknowledgeUnverified?}
POST   /install/file   (multipart + confirmedSha256?)  ローカル zip（オフライン/エアギャップ導入）
POST   /{id}/reinstall             取得元から再取得（github のみ。file は再アップロード）
POST   /{id}/enable | /{id}/disable
DELETE /{id}                       アンインストール
```

例外写像: 403（モード非許可）/ 404（未導入）/ 422（検証失敗）/ 400（不正引数）/ 500。

**セキュリティ実装済み**: sha256 検証、zip slip 防止、id 検証（`[A-Za-z0-9._-]`・`..` 拒否）、
`owner/repo` 形式検証（SSRF/注入対策）、展開サイズ/件数上限。

**導入ゲート**（`PluginManagerService.requireMutable`）: 導入系は次の 3 条件が**すべて**揃ったときのみ許可。
一覧・status は常に可。

| # | 条件 | 主体 | 既定 |
|---|---|---|---|
| 1 | `standalone` プロファイル | モード | web は常に 403（共有サーバー＝運営キュレーション前提、[`plugin-architecture.md §3`](plugin-architecture.md)） |
| 2 | `graphy.plugins.manager-enabled=true` | **管理者ゲート**（yml） | **true**。false にすると 3 のトグルごと封じられ閲覧のみ（施設が一律禁止する用） |
| 3 | 設定キー `plugins.installEnabled=true` | **ユーザーのオプトイン**（環境設定＞プラグインのトグル） | **false** |

3 を分けた理由: プラグインはアプリと同じ権限で動くが**署名検証が未実装**（P2）のため、既定で
導入可能にはしない。一方 2 だけだと yml を手編集できないエンドユーザーには事実上開けられず、
機能が死蔵する（v0.1.8 まで実際にそうなっていた）。よって「環境として許すか（管理者）」と
「今それを使うか（ユーザー）」を分離した。

- 継ぎ目: `InstallOptIn`（関数型 interface）。既定実装 `SettingsInstallOptIn` が設定ストアを読む。
  書き込みは専用 API を作らず、フロントが `PUT /api/settings` に投げる（`setPluginInstallEnabled`）。
- `status` は `canManage` / `standalone` / `managerEnabled` / `installEnabled` / `canOptIn` /
  `hasGithubToken` を返す。フロントは `canOptIn` でトグルの表示可否、`installEnabled` でトグル状態、
  `canManage` で導入 UI と行内操作の表示を決める。
- トグルを OFF に戻しても**導入済みプラグインは動き続ける**（実行レイヤは疎結合。停止したいなら
  各プラグインを無効化する）。

設定（`graphy.plugins.*` / `PluginProperties`）: `manager-enabled`（既定 **true**＝管理者ゲート）、
`github-token`（PAT・任意）、`index-url`（将来の discovery・任意）。

テスト: `SemVerTest`(6) / `OsCompatTest`(5) / `PluginInstallerTest`(10) / `PluginManagerServiceTest`(14)
= 35、全 green。ネットワーク非依存（zip はメモリ生成、GitHub は fake client、オプトインはラムダ）。

---

## 5.1 導入前の検査と同意（2026-07-28 追加）

**背景**: 入口ゲート（§5）は「導入操作を許すか」を制御するだけで、許可後は任意の GitHub リリース
zip を取得・展開していた。プラグインは**アプリと同じ権限で動く**（backend: `URLClassLoader` に
親ローダ付きで同一 JVM ／ frontend: `import()` でレンダラのコンテキスト）ため、
「何を受け入れるのか」を提示しないまま導入するのは危険と判断した。

**導入は 2 段階**にした。取得と展開の間に検査と同意を挟む:

```
POST /inspect/github | /inspect/file   取得 → zip を展開せず読む → PluginPreview を返す
   ↓（フロントが同意画面を表示・ユーザーが承諾）
POST /install/github | /install/file   confirmedSha256 付きで再取得 → 一致確認 → 展開
```

`PluginPreview` が返すもの: id/name/version/説明/作者/ライセンス、**同梱 JAR の一覧**（＝アプリ権限で
動くコードの有無）、`ui.js` の有無、ファイル数・総サイズ、宣言 `permissions`、
**対応 OS の突き合わせ結果**、コア版数の互換、`sha256` と `integrityVerified`、同 id 導入済みか。

- **対応 OS の突き合わせ**（`engines.os`・`OsCompat`）: GRAPHY-Next 本体は OS ごとにリリースが
  分かれ、プラグインも JNI/ネイティブバイナリを含めば OS 専用になる。トークンは Node 互換の
  `win32` / `darwin` / `linux`（`windows` / `mac` / `osx` 等の別名も受理）。未宣言＝OS 非依存。
  **非対応なら同意しても導入できない**（`PluginInstaller.checkCompat` が展開前に落とす＝fail-closed）。
- **TOCTOU 対策**: 同意画面で提示した zip の sha256 を `confirmedSha256` として install に渡し、
  実際に取得したものと一致しなければ拒否する（同意〜導入の間にリリース資産が差し替わっても、
  ユーザーが見ていない成果物は入らない）。
- **完全性**: `<zip>.sha256` 資産が無ければ `integrityVerified=false` とし、
  **既定で導入を拒否**する。同意画面のチェックボックス（`acknowledgeUnverified`）で明示的に
  承知した場合のみ通す。あわせて資産名の照合を**完全一致のみ**に厳格化した
  （以前は「末尾が `.sha256` の最初の資産」も拾い、無関係な資産のハッシュを期待値にしていた）。

**sha256 だけでは守れないこと**: sha256 は同じリリースから取るため、**リポジトリを支配する側の
改竄は検知できない**（＝完全性であって真正性ではない）。これに対する答えが §5.2 の署名で、
署名がある配布物については乗っ取り・改竄を検知できる。**未署名の配布物については依然として
「ユーザーが配布元を信頼し、中身を見たうえで同意する」ことが唯一の防御線**であり、同意画面は
その判断材料を出すためのものである。権限の強制と実行時の隔離は未実装（P3）。

---

## 5.2 署名（minisign / Ed25519）と TOFU（2026-07-28 追加）

**方針**: ユーザーは鍵を一切扱わない。検証は導入時に自動で走り、**通常操作は「導入を押すだけ」のまま**。
摩擦が出るのは未署名・未知の配布者・検証失敗のときだけ。

**実装**（外部依存なし・JDK 21 の `Signature("Ed25519")`）:

| 型 | 役割 |
|---|---|
| `Blake2b` | BLAKE2b-512。minisign の prehashed 署名（algo `ED`）用。JDK にも既存依存にも無いため自前 |
| `Minisign` | 公開鍵 / `.minisig` のパースと検証。本体署名＋**global 署名（trusted comment）**の両方を検証 |

リリース資産は `<zip>.minisig`（署名）と `minisign.pub`（公開鍵）。資産名は完全一致で探す。

**鍵の選び方は 3 段階**（`PluginManagerService.evaluateSignature`）:

| # | 使う鍵 | 状態 | 結果 |
|---|---|---|---|
| ① | 本体設定 `graphy.plugins.trusted-keys` | `trusted` | `trust=verified`・**同意画面なしで導入** |
| ② | 台帳に固定済みの鍵（前回導入時） | `pinned` | **同意画面なしで導入**（更新は押すだけ） |
| ③ | リリースが提示する `minisign.pub` | `first-use` | 同意画面を出す。導入時にその鍵を台帳へ固定 |
| — | 上記いずれでも検証失敗・鍵 ID 不一致 | `invalid` | **無条件で拒否**（`acknowledgeUnverified` でも通さない） |
| — | 固定鍵があるのに**署名が無い**（剥がし） | `invalid` | 同上。乗っ取り側が `.minisig` を出さないだけで TOFU を回避できてしまうため |

②が **TOFU**（trust on first use）の要。台帳（`InstalledPlugin.signerKeyId` / `signerPublicKey`）に
初回の鍵を固定し、更新時は**リリースが同梱してくる鍵ではなく固定した鍵で**検証する。
これによりリポジトリ乗っ取り・作者すり替えは**更新の時点で自動的に弾ける**。
初回の作者が本人であることまでは保証しない（①の信頼鍵だけがそれを保証する）。

**フロントの分岐**: `PluginPreview.autoInstallable`（＝`trusted`/`pinned` かつ互換 OK）が真なら
`PluginManagerPanel` は同意画面を出さずにそのまま install する。署名で真正性が取れている場合は
`<zip>.sha256` 資産の有無を問わない（署名の方が強い保証のため）。

**prehash（BLAKE2b）は必須**: 実物の **minisign 0.12 は `-H` を付けなくても prehashed（algo `ED`）で
署名する**（2026-07-28 に実機で確認）。legacy（`Ed`）だけの対応では実運用の署名を丸ごと弾くため、
BLAKE2b の自前実装は省略できない。

**鍵 ID の表記**: minisign CLI は鍵 ID を**バイト逆順・大文字 hex** で表示する
（`minisign public key E8F18C554EEC1FE7`）。同意画面の表示を CLI の出力と見比べられるよう、
`Minisign.keyId()` で同じ表記に揃えている（内部比較は大小無視）。

**テストの担保**: 暗号と書式の正しさは<b>別実装の固定ベクタ</b>で検証しており、自作で署名して
自作で検証する循環になっていない。
`Blake2bTest` は `openssl dgst -blake2b512`（＋RFC 7693 公表値）。
`MinisignTest` は **実物の minisign 0.12 が出力した署名**（実運用と同じ経路）と、
`openssl genpkey -algorithm ed25519` / `pkeyutl -sign -rawin` で組み立てた legacy・prehashed
両方の署名（分岐の網羅）。サービス側の方針（信頼鍵・TOFU・不正拒否）は
`PluginManagerServiceTest` が実行時生成の鍵で検証する。

**運用上の注意**: 配布者が秘密鍵を失う／鍵を変えると、既存利用者は更新できなくなる（拒否される）。
復旧はアンインストール→再導入。鍵の生成・保管・ローテーション手順は
[`plugin-signing-runbook.md`](plugin-signing-runbook.md) にまとめた（**公式鍵の生成はまだ未了**）。

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
- **P2 進行中**:
  - ✅ フロント Plugin Manager 画面（Settings＞プラグイン。`PluginManagerPanel.tsx` / `pluginManagerApi.ts`）
  - ✅ 導入ゲートの 2 段化＝管理者ゲート＋ユーザー オプトイン トグル（2026-07-28・§5）
  - ✅ 導入前の検査＋同意画面／対応 OS（`engines.os`）の突き合わせ／sha256 の既定必須化・
    資産照合の厳格化／同意した成果物との一致保証（2026-07-28・§5.1）
  - ✅ `graphy-plugin-api` 薄い jar（backend が `spi/**` だけの副成果物を生成→Release 添付）＋
    **テンプレート `examples/plugin-template/`**（`plugin.json`/`ui.js`/`graphy-plugin.d.ts`/GitHub Action/
    `backend-optional/`）＝第三者が作り始められる状態
  - ✅ minisign 署名（Ed25519）＋TOFU＋信頼ティアの実体化（2026-07-28・§5.2）
  - 残: 公式索引 discovery／GitHub OAuth Device Flow／更新通知＋changelog／
    再起動反映（`graphy:relaunch`）／`examples/plugin-template/` を独立
    「Use this template」リポジトリへ昇格／**公式署名鍵の生成と `trusted-keys` への設定**（運用）
- **P3**: フロント iframe/Worker サンドボックス／backend プロセス隔離／web サンドボックス
  （DICOMweb サイドカー）／商用ライセンスキー／ロールバック履歴／障害プラグインの自動無効化。

---

## 9. 既知の制約

- **JAR 差し替えの反映**: `StandalonePluginRegistry` がクラスローダを id 単位でキャッシュするため、
  同 id の JAR 更新は backend 再起動（＝アプリ再起動）まで反映されない。UI-only は画面リロードで反映。
- **署名・権限 enforce 未実装**: `trust` は github=community / file=local を機械的に付与。
  署名検証と権限の実強制は P2/P3。
- **discovery 未実装**: `index-url` は設定のみ。索引取得＋トピック検索は P2。
- **file 由来の reinstall 不可**: zip を保持しないため再アップロードが必要。
