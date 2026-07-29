# GRAPHY-Next プラグインの仕組み（解説）

> 作成日: 2026-07-29（更新: 2026-07-29 — §6 にデモ リポジトリ 4 本、§7 に host API / CSP の制約を追記）
> 目的: **この 1 本を読めば、別セッションのエージェントも初見の人も全体像を把握できる**ようにする。
> GRAPHY Lab の解説ページの原稿もここから抽出する。
>
> 設計の詳細・決定の経緯は各文書にある。本書は**それらを俯瞰して繋ぐ**役割:
> - [`plugin-architecture.md`](plugin-architecture.md) … 実行レイヤ（どう動かすか）
> - [`plugin-manager-design.md`](plugin-manager-design.md) … 管理レイヤ（どう配って入れるか）
> - [`plugin-signing-runbook.md`](plugin-signing-runbook.md) … 署名鍵の運用手順
> - [`plugin-authoring-guide.md`](plugin-authoring-guide.md) … 作者向けガイド

---

## 1. なぜプラグインがあるのか

GRAPHY は研究・臨床の現場ごとに「あと一歩の処理」が違う。すべてを本体に取り込むと肥大化し、
取り込まなければ各自がフォークする。ImageJ/Fiji が **update site** で解いた問題と同じ構図なので、
同じ方向 — **本体は薄く保ち、機能は外から足せるようにする** — を採る。

ただし ImageJ と違い、GRAPHY は**患者データを扱う医用画像アプリ**である。「動けばよい」では済まず、
**誰が配ったコードなのか**を確かめられる必要がある。この一点が、後述の署名・同意画面・OS 突き合わせ
といった仕掛けの理由になっている。

---

## 2. 2 レイヤ構成

プラグイン機構は**独立した 2 つの層**でできている。混ぜないことが設計の芯。

```
┌─ 管理レイヤ ── 「どう配って、どう入れるか」 ───────────────┐
│  発見 → 取得 → 検証 → 展開 → 台帳 → 更新/削除/有効無効     │
│  REST: /api/plugin-manager/*                              │
│  Java: com.vis.graphynext.plugin.manager                  │
└────────────────────────┬──────────────────────────────┘
                         │ フォルダと台帳と .disabled マーカーを書くだけ
┌─ 実行レイヤ ── 「どう動かすか」 ─────────────────────────┐
│  フォルダ走査 → /api/plugins で配信                        │
│  → React が ui.js を動的 import ／ POST run で JAR 実行     │
│  Java: com.vis.graphynext.plugin                          │
└──────────────────────────────────────────────────────┘
```

**依存は一方向**。管理レイヤは実行レイヤの契約（`/api/plugins`）を変えず、ファイルを置くだけ。
だから「管理レイヤを使わず手でフォルダに置く」運用も成立するし、逆に実行レイヤを触らずに
配布方式だけ差し替えられる。

### 実行レイヤ（`com.vis.graphynext.plugin`）

| 型 | 役割 |
|---|---|
| `PluginRegistry` | 一覧と実行の抽象 |
| `FileSystemPluginRegistry` | `<pluginsDir>/<id>/plugin.json` を走査してマニフェストを配信 |
| `StandalonePluginRegistry` | JAR を `URLClassLoader` で読み、`entrypoint` の実装を実行 |
| `WebPluginRegistry` | web 用。一覧と UI 配信のみ。`run()` は **501**（サンドボックス未実装） |
| `PluginController` | `/api/plugins` |

フロント側は `frontend/src/plugins/pluginRegistry.ts` が `/api/plugins` を読み、
`frontend.bundleUrl`（＝`ui.js`）を **`import()` で動的読み込み**して `activate()` を呼ぶ。
プラグインが出せる場所（`contributes`）は `viewer2d.menu` / `viewer2d.toolbar` / `mainscreen.menu` の 3 つ。

### 管理レイヤ（`com.vis.graphynext.plugin.manager`）

| 型 | 役割 |
|---|---|
| `PluginManagerService` | 全体の取りまとめ（取得元解決・ゲート・署名判定） |
| `PluginPackage` | zip の読取・展開。**zip slip / サイズ上限**のガード |
| `PluginInstaller` | 展開・台帳更新・互換判定（Spring 非依存＝単体テスト可能） |
| `PluginLedger` | `installed.json` を原子的に書く |
| `GitHubReleaseClient` | 取得の継ぎ目（実装は JDK `HttpClient`） |
| `Minisign` / `Blake2b` | 署名検証（外部依存なし） |
| `OsCompat` / `SemVer` | 対応 OS / コア版数の突き合わせ |

---

## 3. 導入の全経路

環境設定＞プラグインで `owner/repo` を入れて「GitHub から導入」を押したとき、何が起きるか。

```
[1] ゲート判定            standalone か？ / 管理者ゲート / ユーザーのオプトイン
      │ どれか欠ければ 403（閲覧のみ）
      ▼
[2] 取得                  GitHub Release から <id>-<ver>.zip
                          ＋ .zip.sha256（あれば）＋ .zip.minisig / minisign.pub（あれば）
      │  ※ この時点ではまだ展開していない
      ▼
[3] 検査 (POST /inspect)  zip を展開せずに読む
                          中身（ui.js / 同梱 JAR / ファイル数）・宣言権限・対応 OS・
                          コア版数・sha256・署名の状態を PluginPreview として返す
      │
      ├─ 署名が既知の鍵で通った  ─────────────► [5] へ直行（確認画面なし＝押すだけ）
      │
      └─ 未署名 / 未知の鍵 / 警告あり
      ▼
[4] 同意画面              何を受け入れるのかを提示して承諾を得る
                          （JAR 同梱は「アプリと同じ権限で動く」と赤字で明示）
      │ 互換 NG なら同意しても導入できない
      ▼
[5] 導入 (POST /install)  再取得 → 同意した sha256 と一致するか確認（TOCTOU 対策）
                          → 検証をすべて通す → 一時ディレクトリへ展開
                          → 既存を消して**原子的 move** → 台帳に記録
      ▼
[6] 反映                  UI のみ → 画面リロード
                          JAR 入り → **アプリ再起動**（再起動バナーを出す）
```

**[1] のゲートは 3 条件の AND**（`PluginManagerService.requireMutable`）:

| # | 条件 | 誰が決めるか | 既定 |
|---|---|---|---|
| 1 | `standalone` プロファイル | モード | web は常に 403 |
| 2 | `graphy.plugins.manager-enabled` | 管理者（yml） | `true`（`false` で施設一律禁止） |
| 3 | 設定キー `plugins.installEnabled` | **ユーザー**（環境設定のトグル） | `false` |

②と③を分けたのは、「環境として許すか」と「今それを使うか」が別の判断だから。
②だけだと yml を編集できないエンドユーザーは永久に開けられず、機能が死蔵する
（実際 v0.1.8 まではどこでも `true` にされておらず、画面はあるのに使えなかった）。

---

## 4. 何を検証しているか

導入時の検証は**4 段**あり、それぞれ守っている性質が違う。ここを混同しないことが重要。

| 段 | 何を見るか | 守れる性質 | 失敗したら |
|---|---|---|---|
| A | zip の構造・`id`・展開先 | **安全な展開**（zip slip / 巨大 zip / パス脱出） | 422 で拒否 |
| B | `engines.os` / `engines.graphy` | **動く環境か**（OS 別リリース・コア版数） | 展開前に 422（同意しても不可） |
| C | `<zip>.sha256` | **完全性**（転送中の破損・部分的な差し替え） | 既定で拒否。明示承諾時のみ通す |
| D | `.minisig`（Ed25519 署名） | **真正性**（誰が作ったか・乗っ取り検知） | **無条件で拒否** |

### B: 対応 OS の突き合わせ

GRAPHY-Next 本体は OS ごとにリリースが分かれ、プラグインも JNI やネイティブバイナリを含めば
OS 専用になる。`engines.os` に `win32` / `darwin` / `linux` を宣言させ、**展開前に**実行中の OS と
突き合わせる。未宣言は「OS 非依存」とみなす。

### C: 完全性（sha256）だけでは足りない理由

sha256 は**同じリリースから取ってくる**。リポジトリを支配した側は zip とハッシュを両方差し替え
られるので、これは「壊れていないこと」しか保証しない。**誰が作ったかは分からない**。

### D: 真正性（署名）と TOFU

そこで minisign（Ed25519）署名を検証する。鍵は次の順で探す。

| 順 | 鍵の出どころ | 状態 | 挙動 |
|---|---|---|---|
| ① | 本体設定 `trusted-keys`（公式配布鍵） | `trusted` | **確認画面なしで導入** |
| ② | 台帳に固定した前回の鍵 | `pinned` | **確認画面なしで導入** |
| ③ | リリース同梱の `minisign.pub`（初回のみ） | `first-use` | 確認画面を出し、導入時にこの鍵を固定 |
| — | 検証失敗・鍵 ID 不一致・**署名の剥がし** | `invalid` | **拒否**（承知しても通さない） |

②が **TOFU（trust on first use）** の核心。初回に見た鍵を台帳に固定し、更新時は
**リリースが同梱してくる鍵ではなく固定した鍵で**検証する。これにより
**リポジトリ乗っ取りや作者すり替えは、更新の時点で自動的に弾ける**。

「署名を剥がして未署名として出す」抜け道も塞いである（固定鍵がある id の未署名パッケージは
`invalid` 扱い）。その代わり、配布者にとって署名は**片道の約束**になる。

> **ユーザーは鍵を一切扱わない。** 鍵の生成・保管は配布者、信頼鍵の同梱は本体側の仕事で、
> 利用者から見れば「署名されているものは押すだけで入る」だけ。

---

## 5. デスクトップ版と Web 版の違い

**環境設定から導入できるのはデスクトップ版（standalone）だけ。** Web 版は閲覧のみ。

| | デスクトップ（standalone） | Web |
|---|---|---|
| 導入操作 | ✅ 環境設定＞プラグイン | ❌ **403**（一覧の閲覧のみ） |
| 追加方法 | ユーザーが GitHub / ローカル zip から | **運営がイメージに焼き込む**（`COPY` して再デプロイ） |
| JAR の実行 | ✅ 同一 JVM（`URLClassLoader`） | ❌ **501**（サンドボックス未実装） |
| UI のみ | ✅ | ✅（運営配備分のみ） |

理由は backend が**共有サーバー**であること。任意の JAR を共有 JVM に読ませると、そのコードは
サーバー権限で全実行でき、**他患者データの読み取りや他テナント侵害**まで届く。standalone の
「フォルダから自由にロード」は web に持ち込めない。

デモ環境（`deploy/demo/`）は `/app/plugins` をマウントせず、コンテナも `read_only: true` なので、
稼働中に書き込む手段自体が無い（＝プラグイン追加はコード変更・再デプロイ扱い）。

### インストール先（デスクトップ）

backend は `graphy.plugins.dir`（既定 `./plugins`）を **CWD 相対**で作り、Electron が CWD を固定する。

| OS | 場所 |
|---|---|
| Windows | `%APPDATA%\GRAPHY-Next\plugins\<id>\` |
| macOS | `~/Library/Application Support/GRAPHY-Next/plugins/<id>/` |
| Linux | `~/.config/GRAPHY-Next/plugins/<id>/` |
| 開発時 | CWD（通常 `desktop/plugins/<id>/`） |

**インストール先ではなくユーザーデータ領域**に入る。AppImage のように本体が読み取り専用でも
書けるうえ、アンインストーラがユーザーデータを巻き添えで消さずに済む。
同じフォルダ直下の `installed.json` が台帳（取得元・sha256・署名鍵・同梱 JAR・有効無効）。

### 反映のタイミング

| 種類 | 必要な操作 | 理由 |
|---|---|---|
| UI のみ（`ui.js`） | 画面のリロード | フロントが起動時に `/api/plugins` を読むため |
| JAR を含む | **アプリの再起動** | クラスローダが id 単位でキャッシュされ、同 id の差し替えを拾わないため |

JAR 入りを導入・更新・削除・有効無効したときは、全ウィンドウに再起動バナーを出し、
「今すぐ再起動」で Electron が再起動する。

---

## 6. 作者向け: 作り方と配布

雛形は `examples/plugin-template/`、動くサンプルは**独立したデモ リポジトリ**（2026-07-29 追加）。
デモの README は**それぞれ単体で完結**するように書いてあり（重複は意図的）、
作成・リリース・導入・署名まで 1 本で追える。GRAPHY Lab の「プラグインを作る」節から辿れる。

| # | リポジトリ | 内容 | 構成 |
|---|---|---|---|
| — | [`graphy-next-plugin-demos`](https://github.com/tatsunidas/graphy-next-plugin-demos) | ハブ。仕組み・全フィールド・配布・導入・鍵方式をまとめた実質の開発ガイド | ドキュメント＋`graphy-plugin.d.ts` |
| 1 | [`graphy-next-plugin-hello`](https://github.com/tatsunidas/graphy-next-plugin-hello) | メニューを押すと挨拶。最小形 | UI のみ |
| 2 | [`graphy-next-plugin-mean-filter`](https://github.com/tatsunidas/graphy-next-plugin-mean-filter) | 表示中シリーズに平均化フィルタ、before/after 表示 | UI のみ |
| 3 | [`graphy-next-plugin-gemini-findings`](https://github.com/tatsunidas/graphy-next-plugin-gemini-findings) | 粗い所見＋画像を Gemini に渡して推敲（教育用）。**JAR から外部 API を呼ぶ** | UI ＋ Java |

> デモ 2・3 は、**現状の host API には表示中シリーズの UID も生ピクセルも無い**ため、
> タイルの `data-tile-id` 属性とキャンバスの読み取りで代替している（各 README に明記済み）。
> デモ 3 が JAR を持つのは、レンダラの CSP（`connect-src` が localhost のみ）により
> `ui.js` から外部 API を叩けないため。**ここは将来の host API 拡張の候補**。

最小構成は **`plugin.json` ＋ `ui.js`** の 2 ファイル。

```jsonc
{
  "id": "my-plugin", "name": "My Plugin", "version": "0.1.0",
  "contributes": ["viewer2d.menu"],       // 出す場所
  "ui": "ui.js",                          // 画面側のコード
  "entrypoint": "com.example.MyPlugin",   // 任意: JAR のバックエンド実装
  "permissions": ["read-pixels"],         // 宣言（現状は情報のみ）
  "engines": { "graphy": ">=0.1.0", "os": ["win32", "darwin", "linux"] },
  "description": "...", "author": "...", "license": "MIT"
}
```

- **UI のみ**なら Java は不要。`ui.js` が `activate(ctx)` を公開する。
- **バックエンド面**が要るなら `graphy-plugin-api` jar（Release に添付）に対してコンパイルし、
  `*.jar` を同梱する。
- 配布は **GitHub Release にビルド済み zip 資産**（`<id>-<ver>.zip`）を置く。タグ＝バージョン。
  テンプレの GitHub Action が zip・sha256・（鍵があれば）署名まで作る。

### 署名する場合（推奨）

`minisign -G` で鍵を作り、**公開鍵をリポジトリにコミット**、秘密鍵とパスフレーズを
GitHub secrets に登録するだけ。以後リリースごとの追加作業は無い（CI が署名する）。
利用者から見た違いは「確認画面が出ずに導入できる」こと。

⚠ ただし**鍵を失うと利用者は更新できなくなる**（`.minisig` を出さない更新も拒否される）。
鍵の保管が運用の要。手順は [`plugin-signing-runbook.md`](plugin-signing-runbook.md)。

---

## 7. 守れていないこと（正直に）

過大評価されると危険なので、限界を明記する。

- **未署名プラグインの真正性は保証できない。** 同意画面は判断材料を出すだけで、最終的な防御線は
  「利用者が配布元を信頼するかどうか」。
- **宣言 `permissions` は強制されない。** マニフェストに書かれているだけで、実際のアクセスは
  制限していない（P3）。
- **実行時の隔離が無い。** プラグインはアプリと同じ権限で動く
  （backend は同一 JVM、frontend はレンダラのフルコンテキスト）。iframe/Worker 隔離や
  プロセス分離は将来の課題。
- **初回の作者そのものは検証できない。** TOFU は「2 回目以降、同じ相手か」を保証する仕組みで、
  1 回目に本人かどうかは①の公式鍵でしか担保されない。
- **web でのユーザー導入は実現していない。** 実現するならクライアント WASM か、
  サーバー側サンドボックス（DICOMweb サイドカー）が必要。
- **host API が痩せている。** `viewer2d.*` の host が渡すのは `actions`（表示操作）だけで、
  **表示中シリーズの UID も生ピクセル（HU/SUV）も取れない**。デモ 2・3（§6）は
  タイルの `data-tile-id` 属性とキャンバス読み取りで代替しており、DOM 依存＝壊れやすい。
  画像処理系プラグインを本気で書けるようにするなら、ここの拡張が先。
- **`ui.js` から外部 API を叩けない。** 本番ビルドの CSP が `connect-src` を localhost に
  限っているため（`fw/security.md`）。外部通信は JAR 側に置くしかなく、結果として
  「UI だけで済む機能」まで standalone 限定になる。

---

## 8. どこを読めばよいか（索引）

| 知りたいこと | 見る場所 |
|---|---|
| 動かす仕組み・継ぎ目 | `fw/plugin-architecture.md` |
| 配布・導入・検証の設計 | `fw/plugin-manager-design.md`（§5 ゲート / §5.1 同意 / §5.2 署名 / §5.3 反映） |
| 鍵の生成・保管・ローテーション | `fw/plugin-signing-runbook.md` |
| プラグインの作り方 | `fw/plugin-authoring-guide.md`、`examples/plugin-template/`、[デモ集](https://github.com/tatsunidas/graphy-next-plugin-demos)（§6） |
| REST の仕様 | `PluginManagerController` / `plugin-manager-design.md` §5 |
| 実装の中心 | `backend/.../plugin/manager/PluginManagerService.java` |
| 画面 | `frontend/src/settings/PluginManagerPanel.tsx`、`PluginConsentDialog.tsx` |

### GRAPHY Lab の記事にするときの勘所

- **売りは「入れやすさ」ではなく「入れても大丈夫と言える根拠」**。§4 の 4 段検証と §5 の
  web/desktop の非対称が、そのまま説明の骨子になる。
- 「ImageJ の update site 相当」は掴みとして有効だが、**医用データを扱う分だけ厳しくしてある**
  という差分を必ず添える。
- §7 を省かないこと。できないことを書いていない安全性の説明は信用されない。
