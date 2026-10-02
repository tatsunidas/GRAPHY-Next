# リモート GPU カーネル（Remote Compute）設計

> 記録開始 2026-10-02。**段 1（Jupyter クライアント）まで完了**（§10）。段 2 以降は未着手。
> セキュリティ上の判断の正本は `fw/security.md`。外部 AI の送信経路は `fw/ai-routing-design.md`。
> ここには**外部の Jupyter カーネルで任意のコードを動かす**という、AI egress より一段強い経路を書く。
>
> 🔑 **規則: 外へ出るデータは本体が匿名化して作る。プラグインは生のバイト列を外へ渡す口を持たない。**
> 🔑 **規則: Colab の非公開 API（`/tun/m/*`）は使わない。** 公式の Colab API の許可が下りてから足す。
> 🚨 **未確認**: Colab API の電文は公開リファレンスと VS Code 拡張のソースを読んだだけで、叩いていない（§9）。

## 1. なぜ要るのか

利用者の要望（2026-10-02）:

> 「VSCode で Colab のエクステンションを入れると、VSCode 上で Colab カーネルで GPU が利用できるようになります。
> この仕組みを GRAPHY-Next にも取り入れ、Next でも Colab の GPU カーネルを利用できるようにして、
> かつ、プラグインからも使えるように API 化したいです。」

いまのプラグインは JAR（Java）か ui.js の中で計算するしかない。セグメンテーションなど
**PyTorch と GPU が前提の研究コード**を載せるには、計算を外に出す口が要る。

🔑 **これは本体の機能。** プラグインごとに Jupyter クライアントを持たせると、鍵の持ち方・
同意・匿名化がばらばらになり、**患者データが外に出る経路を本体が把握できなくなる**。
AI egress と同じ理由で、入口を本体に 1 つ持つ。

---

## 2. 🔴 いちばん重要な判断 — Colab は「接続先の 1 つ」にする

### 2.1 VS Code 拡張の仕組み（2026-10-01 時点のソースを読んだ）

| 段 | 中身 | 出典 |
|---|---|---|
| 認証 | OAuth（loopback）。scopes `profile` `email` `https://www.googleapis.com/auth/colaboratory`。**client ID はリポジトリに無い**（ビルド時に注入） | `googlecolab/colab-vscode` `src/auth/` |
| 割り当て | **公式 Colab API** `colaboratory.googleapis.com/v1beta`: `ListRuntimeSpecs` → `CreateRuntime`（LRO）→ `GetRuntime` → `DeleteRuntime` | `src/colab/client/v2/`, `src/jupyter/assignments.ts` |
| 接続 | `Runtime.connectionInfo` の URL に、短命トークンを `X-Colab-Runtime-Proxy-Token` ヘッダで付ける。期限の 5 分前に `GetRuntime` で取り直す | `src/colab/connection-refresher.ts` |
| その先 | **普通の Jupyter Server**（REST＋カーネル WebSocket） | 同上 |

### 2.2 なぜ Colab 専用にしないか

- **Colab API はベータ・allowlist 制**（"available on an allowlist basis"）。申請が通るまで正規には使えない。
- 非公開の `colab.research.google.com/tun/m/assign` 等を叩くことは**しない**。
  ToS: *"you may not … access Colab other than as authorized by Google; or sell, rent, or otherwise
  provide direct or indirect access to Colab to any third party."*
  製品として配る Next から叩けば両方に当たりうる。
- **無料版・Pro の Colab は HIPAA の対象外**（対象は Colab Enterprise だけ）。
- Colab の中身は Jupyter Server なので、**Jupyter クライアントを作れば院内の GPU 機・契約クラウド・
  将来の Colab が同じ口で使える**。

→ **段 1〜8 は汎用 Jupyter（URL＋トークン）だけで作る。Colab は段 9（許可後）に provider として足す。**

---

## 3. 🔴 患者データ — 必ず匿名化してから出す

利用者の判断: 「必ず匿名化してから送る」。

### 3.1 誰が作るか

- 外へ送るファイルは **backend が既存の匿名化エンジン**（`AnonymizeService` /
  `DicomAnonymizerEngine.deidentify`）を通して作る。
- プラグインに返すのは**データセットハンドル `dsh_<uuid>`** だけで、中身は返さない。
- アップロード API は**ハンドルしか受け取らない**。生のバイト列を受ける引数は作らない。

### 3.2 焼き込み（画素に写った患者情報）

ヘッダを消しても画素に名前が写っていれば意味がない。既存の `burnPreflight` は
「マスクのあるシリーズが本当に塗れるか」を見るが、**マスクの無いシリーズは `unmasked` として数えるだけ**で通す。
ローカルへの書き出しならそれで良いが、外へ出す経路では足りない。

**外部送信の規則（ここで決める）:**

| シリーズ | 扱い |
|---|---|
| マスクがあり、塗れる（`burnable`） | 塗ってから送る |
| マスクがあるのに塗れない（`blocked`） | **拒否**（既存と同じ） |
| マスクが無く、`BurnedInAnnotation=YES` | **拒否** |
| マスクが無く、モダリティが US / XA / RF / ES / SC / OT / DX / CR / MG、または SOP が Secondary Capture・動画系 | **拒否**（焼き込みが普通にある種類。`BurnedInAnnotation` は当てにならない） |
| マスクが無く、上以外（CT / MR / PT / NM など）で `BurnedInAnnotation` が `NO` か無い | 送る |

拒否は利用者もプラグインも解除できない。解除したければ**マスクを登録する**（既存の導線）。
🚨 既知の不具合（`CLAUDE.md`）: 匿名化の出力は焼き込みをしていなくても `BurnedInAnnotation=NO` と書く。
外部送信では**元ファイルの値**で判定し、出力の値は見ない。

### 3.3 単位

既存の `AnonymizeService` は**検査（study）単位**。外部送信はシリーズ単位で選びたいので、
シリーズで絞る入口を足す（段 3）。患者・日付の置き換えは同じ `PatientMapping` / `DateShifter` を使い、
**同じ患者を何度送っても同じ仮名になる**ようにする（結果を突き合わせるため）。

### 3.4 形式

| `format` | 中身 | 用途 |
|---|---|---|
| `npz` | `volume`（int16 / float32、リスケール済み）＋ `meta.json`（spacing・direction・origin・匿名化後の UID・モダリティ） | 研究コードがそのまま読める |
| `dicom-zip` | 匿名化済み DICOM の zip | pydicom / MONAI 等で読みたい場合 |

---

## 4. 置き場所 — backend と main の 2 か所で縛る

| 層 | 担当 | 理由 |
|---|---|---|
| **Java backend**（`com.vis.graphynext.compute`、`@Profile("standalone")`） | Jupyter クライアント・データの梱包（匿名化）・ジョブ実行・監査ログ・宛先の制限 | 匿名化エンジンとジョブの仕組み（`PluginJobService`）が backend にある。JAR プラグインからも呼べる |
| **Electron main** | 接続先の登録・トークンの保管（`safeStorage`）・**同意ダイアログを main が描く**・将来の Colab OAuth | プラグインはレンダラと同じ realm に入る（`fw/security.md`）。レンダラ内の同意は迂回できる |
| **レンダラ** | Host API の窓口と表示だけ | 判断させない |

### 4.1 main ↔ backend の信頼経路（新規）

いまは main と backend の間に「main だけが使える口」が無い。

- main は backend を起動するとき（`desktop/main.js` の `spawn`）、起動ごとの乱数 32 バイトを
  環境変数 `GRAPHY_MAIN_SECRET` で渡す。
- backend の `MainChannelFilter` が `/api/internal/compute/**` を守る。
  `Authorization: Bearer <secret>` と送信元が loopback であることを確かめる。レンダラは secret を知らない。
- 接続先のトークンは main が `secretStore` から取り出し、`POST /api/internal/compute/endpoints/{id}/credential`
  で backend に渡す。backend は**メモリにだけ**持つ（ディスク・ログ・`/api/settings` に書かない）。
  backend が再起動したら main が入れ直す。
- `secretStore.js` の allowlist に `/^compute\.endpoint\.[a-z0-9-]{1,32}\.token$/` を足す。復号値を返す IPC は作らない（既存の規則）。

### 4.2 同意の札

AI egress の同意（`AiEgressConsentDialog`）はレンダラが描く。こちらは**任意のコードが外で動く**ので一段強くする。

1. backend が送る内容を確定して `EgressRequest` を作る: 宛先・ファイル一覧と各 SHA-256・合計バイト数・
   **実行するコードの全文**・匿名化プロファイル・焼き込みの判定結果。
2. レンダラは IPC `compute:confirm(requestId)` を呼ぶだけ。
3. main が secret 付きで backend から内容を**自分で取り直し**、main 自身のウィンドウに出す。
4. 承認されたら main → backend に approve を送る。
5. backend は承認済みの要求しか送らない。**札は 1 回きり・5 分で失効・内容のハッシュに縛る**
   （承認後にファイルやコードを差し替えたら無効）。

### 4.3 宛先の制限

- `ComputeEgressGuard`: backend からの外向き通信は**main が登録した接続先の host にだけ**許す。
- 接続先は `https` 必須。平文 `http` は院内のプライベートアドレスだけ（`aiProviders.allowsPlainHttp` と同じ規則）。
- 接続先を追加・変更する保存は main が確認ダイアログを出す（`fw/ai-routing-design.md` §14 と同じ）。
- **CSP は変えない。** 外部 host は 1 つも足さない。

---

## 5. Host API（`fw/plugin-architecture.md` §7.2 に足す）

🚨 番号の衝突: `graphy-plugin.d.ts` は `ai.generate` を "H40"、`saveAs` を "H41" と書いているが、
§7.2 の表では H40 = XA cine、H41 = centerline。**新規は表の最大（H58）の次から明示的に振る。**

| H | API | permission | 中身 |
|---|---|---|---|
| **H59** | `compute.runJob({script, inputs:[{seriesUid, format}], requirements?:{gpu}, timeoutSec?}, {onProgress, signal})` → `{jobId, stdout, files:[{name,size}]}` | `remote-compute` | 本体が匿名化 → 同意 → アップロード → 実行 → `outputs/` を回収。`script` は 64KB まで。入力は `inputs/`、出力は `outputs/` に書く約束。進み具合はカーネル側の `print("__progress__", 0.4, "msg")` を拾う。結果は H53 の成果物になり、H4b / H9 / オーバーレイへつなげる |
| **H60** | `compute.openSession()` → `session.execute(code)` / `uploadDataset(seriesUid, format)` / `download(path)` / `interrupt()` / `close()` | `remote-compute-session`（強い） | 上級者向け。`execute` は 1 回 16KB まで。出力はポーリング（SSE は本体に無い。`pollPluginJob` と同じ形）。`uploadDataset` は中で本体がハンドルを作る |
| **H61** | `compute.status()` | （無し） | 接続先・GPU 名・残り時間。読み取りのみ |

- permission は **backend の `ComputeController` で確かめる**（`ai-egress` のようにフロントだけで見ない）。
- 型は `frontend/src/plugins/pluginTypes.ts` と `examples/plugin-template/graphy-plugin.d.ts` の両方
  （`pluginTemplateTypes.test.ts` がずれを検出する）。`engines.graphy >= 0.4.0`。
- web モードでは 501（JAR と同じ）。

### 5.1 🔴 残るリスク — セッション型ではプラグインがデータを持ち出せてしまう

プラグインの JS は H3（`getPixelData`）で**生の画素**を読める。それを `execute` のコード文字列に
埋め込めば、匿名化を通らずに外へ出せる。**完全には塞げない**（プラグインに本体と同じ realm を許している以上）。

抑え方:
- コード長の上限（ジョブ 64KB / セッション 16KB）。
- **長い base64 らしい・高エントロピーの文字列リテラル**（合計 4KB 超）を含むコードは拒否。
- 同意画面にコードの全文を出す。セッション型は「このセッションでコードを実行する」同意を
  セッションごとに 1 回、**データのアップロードは毎回**同意を取る。
- 監査ログにコードの SHA-256 と先頭部分を残す。
- permission の説明文は「任意のコードを外部の計算機で実行する」と書く。
- 運用: **セッション型は信頼したプラグインにだけ許す**（プラグイン管理の説明に書く）。

ジョブ型も同じ穴（`script` に埋め込む）があるので、同じ検査を通す。

---

## 6. backend の構成（予定）

| クラス | 役目 |
|---|---|
| `ComputeProvider`（SPI） | `connect` / `startKernel` / `shutdown` / `upload` / `download` / `capabilities` |
| `JupyterServerProvider` | `java.net.http` で `/api/kernels` `/api/sessions` `/api/contents` とカーネルチャネルの WebSocket。メッセージ形式 v5.3（`execute_request` / `stream` / `display_data` / `execute_result` / `error` / `status`）。`Authorization: token …` |
| `KernelSessionManager` | セッションの登録簿。idle 20 分で shutdown。プラグインあたり同時 1 セッション。アプリ終了時は main が `shutdownAll` を呼ぶ |
| `ComputeDatasetService` | §3。ハンドルを作る・焼き込みで拒否する |
| `ComputeJobRunner` | `PluginJobService.submitTask()` に乗せる。取消は interrupt → shutdown |
| `ComputeAuditLog` | `<dataDir>/compute-audit.jsonl`。時刻・プラグイン id・宛先・ファイルのハッシュとバイト数・コードの SHA-256・結果。**画素は残さない** |
| `ComputeEgressGuard` | §4.3 |
| `ComputeController` | `/api/compute/**` と `/api/plugins/{id}/compute/**`。permission を確かめる |

アップロードは Jupyter の Contents API（base64 の JSON）。大きいものは分割してカーネル側で結合する
（Colab CLI も同じ方針）。**結果のファイルは信頼しない**: 拡張子と大きさの上限、DICOM として取り込むなら H4b の検証を通す。

---

## 7. やらないこと（意図的に）

- Colab の非公開 API（`/tun/m/*`）を使うこと。
- プラグインに生のバイト列を外へ送らせる口。
- CSP に外部 host を足すこと。
- web モード対応（backend から外へ出る経路と同意を web でどう出すかは別途）。
- ローカルで Python を動かすこと（今回は外部カーネルだけ）。

---

## 8. 段取り

| 段 | 中身 | テスト |
|---|---|---|
| **0** | この設計書。**Colab API の allowlist を申請**（利用者。用途・「PHI は送らない設計」・scopes を書く） | — |
| **1** | `JupyterServerProvider`＋WebSocket | 偽サーバの単体テスト。`@Tag("jupyter")` の結合テスト（`anaconda3\python.exe -m jupyter_server` を起動） |
| **2** | main ↔ backend の信頼経路・`desktop/computeEndpoints.js`・secretStore 拡張・設定画面 | `secretStore.test.js` 拡張、`MainChannelFilter` の単体 |
| **3** | `ComputeDatasetService`（シリーズ単位・npz / dicom-zip・§3.2 の拒否） | 匿名化後に PHI タグが残らない（既存の匿名化テストと同じ表）、npz の geometry、拒否の表 |
| **4** | `EgressRequest`・main の同意ダイアログ・監査ログ | 札の 1 回使用・失効・ハッシュ違い |
| **5** | H59 ジョブ型・`pluginComputeApi.ts` | 型 2 か所の一致・permission 拒否 |
| **6** | サンプル `examples/remote-compute-demo`（numpy で閾値 → mask の npz → H4b で派生保存。torch があれば GPU 名を出す） | automator の `src/spike/remoteComputeCheck.mts` でローカル jupyter_server 相手に通す |
| **7** | H60 セッション型 | コード検査（長さ・base64 らしさ） |
| **8** | GPU 情報（`nvidia-smi`）・idle 表示・ステータスバー | — |
| **9** | **（許可後）** `ColabProvider`: main で loopback OAuth＋PKCE、refresh token は safeStorage、`CreateRuntime`（LRO）→ `GetRuntime`、トークンは期限 5 分前に更新、`FAILED_PRECONDITION` →「GPU が空いていない」、無料 12h / Pro+ 24h・idle 約 30 分の注意 | 実アカウントで |

### 合格条件（機能全体）

1. サンプルプラグインで「シリーズを選ぶ → 同意（main が描く）→ 外部カーネルで実行 → 派生シリーズが DB に入る」が通る。
2. **送ったファイルに患者情報が無い**（タグ・焼き込み）ことを、送った実物を取り出して確かめる。
3. 焼き込みが疑われるシリーズ（US 等でマスク無し）は、プラグインが何をしても送れない。
4. 監査ログに 1 送信 1 行が残り、画素は入っていない。
5. インストーラ版で通す（CSP と外向き通信はパッケージ版でしか効かない）。

---

## 9. 未確認・持ち越し

- Colab API の電文（リファレンスと拡張のソースを読んだだけ）。許可が下りたら実際に叩いて確かめる。
- Colab の idle 約 30 分は**拡張のコード内コメント**の数字で、公式の値ではない。
- Jupyter Contents API の 1 回あたりの上限・スループットは実測していない（段 1 で測る）。
- Colab Enterprise（GCP。HIPAA 対象）で対話カーネルに外から繋げるかは未確認。院内で生データを扱いたい要望が出たら調べる。

## 出典

- Colab API リファレンス: https://developers.google.com/colab/api/reference/rest
- VS Code 拡張: https://github.com/googlecolab/colab-vscode
- 公開範囲についての保守者の回答: https://github.com/googlecolab/colab-mcp/discussions/41
- Colab ToS: https://research.google.com/colaboratory/tos_v5.html ・ FAQ: https://research.google.com/colaboratory/faq.html
- Google Cloud HIPAA 対象サービス: https://docs.cloud.google.com/docs/security/compliance/hipaa

---

## 10. 段 1 でやったこと（2026-10-02）

### 入れたもの（`backend/src/main/java/com/vis/graphynext/compute/`）

| ファイル | 中身 |
|---|---|
| `JupyterEndpoint` | 接続先（URL＋トークン）。https 必須・平文 http は loopback／プライベート IP だけ（名前解決しない）。URL にトークン・クエリ・認証情報を入れさせない。`toString` に鍵を出さない |
| `JupyterServerClient` | REST: `status` / `kernelSpecs` / `startKernel` / `kernel` / `interruptKernel` / `shutdownKernel` / `mkdirs` / `upload`（8MB ごとに `chunk` で分割）/ `download`（上限 512MB）/ `list` / `delete`（中身ごと）。**リダイレクトは追わない** |
| `KernelChannel` | カーネルの WebSocket（サブプロトコル無しの JSON）。`awaitReady`（`kernel_info_request` を返事が来るまで送り直す）・`execute`。1 メッセージ 64M 文字で打ち切る |
| `ExecutionCollector` / `ExecutionResult` | 1 回の実行の stdout / stderr / 出力 / エラーを集める。stdout・stderr は各 100 万文字まで |
| `KernelMessages` | メッセージ v5.3 の組み立て。`allow_stdin=false`・`store_history=false` |

Spring の bean にはまだしていない（段 2 で接続先の登録・トークンの受け渡しと一緒に公開する）。
`ComputeProvider`（SPI）も段 9（Colab）で 2 つ目の実装が来るときに切り出す——実装が 1 つのうちに
抽象を決めると、Colab の都合（ランタイムの確保・トークンの更新）を外す。

### テスト（25/0）

- 単体: `JupyterEndpointTest`（6）・`ExecutionCollectorTest`（6）・`JupyterServerClientTest`（7、`com.sun.net.httpserver` の偽サーバ）
- 結合: `JupyterServerIntegrationTest`（6）。本物の jupyter_server を起動して、実行・エラー・`input()` の拒否・
  **16MB 超のアップロード（分割）→ カーネルで SHA-256 → 結果のダウンロード**・中断・カーネル情報を確かめる。
  環境変数 `GRAPHY_JUPYTER_PYTHON` があるときだけ動く（開発機は anaconda の python、jupyter_server 2.10）。

```bash
cd backend && GRAPHY_JUPYTER_PYTHON='C:\Users\t_kob\anaconda3\python.exe' \
  mvn -q -Dfrontend.skip=true -Dtest='com.vis.graphynext.compute.*Test' -Dsurefire.failIfNoSpecifiedTests=false test
```

### 🔴 実測で分かったこと

1. **カーネルは `path` を渡さないとサーバのプロセスの作業フォルダで起動する。** アップロードしたファイルが
   相対パスで見えない（`FileNotFoundError`）。`startKernel` は必ず `"path": ""`（Contents の根）を渡す。
2. **Windows のカーネルは長い 1 回の待ち（`time.sleep(120)`）を中断できない。** 中断は `interrupt_main()` で
   伝わるので、待ちが明けてから `KeyboardInterrupt` になる。Linux（Colab・GPU 機）は SIGINT で即座に抜ける。
   → 段 5 の取消は「interrupt → 一定時間で応答が無ければ shutdown」にする。
3. **`stop_on_error=true` だと、エラーになった実行の後ろに並んでいた実行は `aborted` で返る。**
   ジョブ型では 1 ジョブ 1 実行なので問題ないが、セッション型（H60）では利用者に見える形で返す。
4. **Contents API は中身のあるフォルダを消せない（400）。** `delete` は中から順に消す。

### 段 2 へ持ち越すもの

- bean 化・接続先の登録（main）・トークンの受け渡し（`GRAPHY_MAIN_SECRET`）・接続テストの口
- Contents API の 1 回あたりの上限とスループットの実測（今は 8MB 分割で 16MB 超が通ることだけ確かめた）

### ⚠ 既存の失敗（今回の変更とは無関係）

この機の `mvn test` 全体では 4 クラスが落ちる: Mockito を使う 3 クラス（`AnonymizePreflightTest` /
`AnonymizeBurnScopeTest` / `AnnouncementServiceTest`。**JDK 25 で Mockito が動かない**——この機には JDK 21 が無い）と、
`VideoRenderServiceTest.ensureRendered_servesMp4PayloadAsIsWithoutFfmpeg`（7877 / 7878 バイトの 1 バイト差）。
