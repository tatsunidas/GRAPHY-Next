# Google Drive — P2: モード A（Drive 正本・ローカルは容量上限つきキャッシュ）

> P1（モード B: ローカル正本＋Drive バックアップ）は `fw/gdrive-p0.md`・`fw/verify-db-gdrive.md`。
> ここはモード A の設計の記録と、段ごとの進み具合。

## 決定（利用者）
- キャッシュ上限の既定は **15 GB**（コードでは 15 GiB = 15×1024³ バイト。画面では「GB」と表記）。DB フォルダごとに、設定 → データ → Google Drive パネルで変えられる。画面から選べる下限は 1 GB（仮。実測で見直す）。
- モード A の DB フォルダでは、DB 間の「コピー・移動」を P2 では使えなくする（先に全件をローカルに保存してもらう）。

## 仕組み（P2-1 で入れたもの）
- **台帳** `gdrive_sync_item` に `evicted`（手元の実体を追い出した）と `lastAccessAt`（最後に読まれた・同期済みになった時刻）を足した。既存の行は DEFAULT つきの列追加で `evicted=false`・`lastAccessAt=0`（＝モード B からの切替直後は全件が古い扱い）。
- **設定** `GdriveConfig` に `cache`（モード A か）と `cacheLimitBytes`。経路は `db-folders.json` の `gdrive.{mode,cacheLimitBytes}` → `pushGdriveConfig` → `PUT /api/internal/gdrive/config` → `GdriveConfig`。`/api/settings` には載せない（プラグインやレンダラから書き換えられて容量が暴れないように、Drive の秘密と同じ経路に揃えた）。
- **追い出し**（周期の最後、送信が済んだあと）: 手元の使用量（台帳の `size` の合計。追い出し済み・Drive 側削除待ちは除く）が上限を超えていたら、`SYNCED`・手元にある・直近 10 分に読まれていないものを `lastAccessAt` の古い順に消す。**Drive には触れない。** 未送信・失敗中（`PENDING`/`BLOCKED`）は消さない。同期のあとで手元が変わったもの（size/mtime が台帳と合わない）も消さない。1 周期に見る候補は最大 2000 件。
- **読まれた時刻**は `touch(relPath)`（メモリ上のマップ）に貯め、周期ごとに台帳へ書く（読み出しのたびに DB を更新しない）。
- **reconcile の分岐（最重要）**: モード B では「手元に無い＝消された」→ Drive のゴミ箱だが、モード A では手元に無いことは削除を意味しない。`evicted` の行・Drive に正本がある行は「追い出し済み」として扱い、ゴミ箱には送らない。**Drive 側の削除は、利用者の削除操作が `StorageChanged` で明示的に伝えたときだけ**（`DbAdminService.deleteAll`・`relocateInstance`、`AutomatorService.reset` から `StorageLayout.notifyRemoved`）。
- 状態 API `GET /api/gdrive/status` に `mode`・`cacheBytes`・`cacheLimitBytes`・`localCount`・`evictedCount`。

## 読み出し（P2-2 で入れたもの）
- **契約** `dicom/store/StorageBackend`（`cacheMode`・`ensureLocal`・`prefetch`・`touch`）。既定は何もしない `NONE`（モード B・Drive なし）。`GdriveSyncService` が実装し、起動時に `StorageLayout.setBackend` へ自分を登録する。
- **入口** `StorageLayout.resolveForRead`: 手元にあれば `touch` して返す。無く、台帳が追い出し済みなら `ensureLocal`（Drive から取得）。台帳に無い・モード B なら従来どおり null。約 30 箇所の呼び出し元は変更していない。
- **取得**（`GdriveSyncService.ensureLocal`）: 走査に見えない名前（`.<名前>.fetch`）へ落とし、**サイズと md5 を台帳と照合**してから本来の名前へ原子的に移す。**mtime を台帳の値に戻す**（戻さないと reconcile が「変わった」と取り違えて送り直す＝変異確認済み）。同じファイルへの同時要求は 1 回だけ取得。照合できない行（md5 なし）は置かない。
- **失敗は null にしない**: `StorageUnavailableException`（`offline`・`needs-login`・`drive-disabled`・`md5-mismatch`・`no-checksum`・`not-on-drive`・`drive-error`）→ `GlobalExceptionHandler` が **503＋理由コード**。「その画像は無い」（404）と区別する。
- **一括取得**: `DicomStorageService.resolveFiles` が先に `prefetch`（並列 4・取り消し可）。1 件でも失敗すれば例外（黙ってスキップしない）。
- **書き換え**: `DbAdminService` の患者編集・シリーズ統合/分割は、書く前に `resolveForRead` で取り寄せ、書いたあと `StorageLayout.notifyChanged`（旧 `notifyRemoved` から改名）で Drive 同期へ通知する（再アップロード）。取り寄せ失敗は握りつぶさず上へ（索引だけ更新されて Drive の正本と食い違うのを防ぐ）。
- **DB 間転送**: モード A では `DbTransferService.transfer` が `cache-mode-unsupported` で拒否（コピーも移動も。何も作らず、元も消さない）。

### 握りつぶし箇所の確認結果（P2-2 の調査）
| 箇所 | 結果 |
|---|---|
| `DbAdminService` 患者編集（`catch(Exception)`） | **要対応**: 取り寄せを try の外へ出して修正済み（テストあり） |
| `DbAdminService` 統合・分割（`catch(Exception)`） | `failed` として数えて返す。誤った成功にはならない（取り寄せ失敗は failed に入る） |
| `SeriesExtractService:87,113,137` | `errors` に積んで返す。誤った成功にはならない |
| `SpatialRegistrationService.list` | `resolveFiles` は try の外。例外は上へ。`catch` は取得済みファイルの解析失敗のみ |
| `StudyController:143,198,306`・`ReportService:304` | web モード（外部 PACS）専用。保管庫を使わないので対象外 |
| `DicomSendService`・`DoseController`・`RtStructReadService`・`SegReadService`・`MeasurementReportService` | `resolveFiles` の例外がそのまま上がる（握りつぶしなし） |

### 患者編集を「全か無か」にした（P2-2b・旧不具合の修正）
`DbAdminService.rewriteFile` は、実ファイルの書き換えに失敗しても警告だけで索引を更新していた（失敗したファイルだけ古いタグのまま・索引は新しい値）。修正:
- **準備 → 入れ替え → DB → 確定/巻き戻し**（`PatientFileEdit`）。準備で全ファイルの新しい内容を一時ファイル（`.<名前>.edit`）へ書き、1 つでも失敗したら全部消して中止（元のファイルは 1 つも触っていない）。入れ替えは `元 → .<名前>.orig`（退避）、`一時 → 元` のリネーム。入れ替えの途中で失敗したら、入れ替え済みのものを退避から戻す。DB 更新が失敗したら（コミット時の失敗も含む）退避から戻す。確定したら退避を消す。
- 失敗は `409 patient-edit-failed: <phase> sop=<SOP UID>`。患者情報は本文に含めない。画面は P2-4 で読みやすい文言（全部取り消した・データは変更されていない）に変換する。
- **他の処理を止めない**: 取り寄せ・一時ファイルの作成・リトライの待ちは、DB への書き込み前の準備相で済ませる（DB の書き込みロックを握ったまま待たない）。待ちは有界。1 件の失敗はその編集操作だけを失敗にする。元ファイルはリネームで入れ替えるので、同期や表示は古い版か新しい版のどちらかを完全な形で読む。
- **リトライ**（`FileRetry`）: 一時的な失敗（Windows の共有違反・アクセス拒否・実在するのに開けない `FileNotFoundException`）だけを最大 3 回（待ち 250 ms → 750 ms）。ファイルが無い・DICOM として読めない・容量不足・クォータは永続的としてすぐ諦める。**3 回・待ちの値は仮**（実測で見直す）。
- **クラッシュ復旧**: 入れ替えの前に `<保管庫>/.edit-journal/*.journal` を書き、確定・巻き戻しで消す。落ちて残った journal は、起動時（`PatientEditRecovery`）に、ファイルの患者タグ（名前・生年月日・性別・ID）を索引と突き合わせ、合っているほうを残す（新しい値＝確定済みなら退避を消す／古い値＝取り消されていたなら退避へ戻す／元ファイルが無ければ退避から戻す／どちらとも合わなければ何も消さず警告）。
- 実ファイルが無い行（索引にあるが実体が無い）は従来どおり警告だけで、残りの編集は進む（書き換える物が無いので食い違いは生じない）。
- テスト: `FileRetryTest` 5、`PatientFileEditTest` 7、`PatientEditAtomicityTest` 9（旧実装とのバイト一致、壊れたファイルで全体が失敗、DB 失敗で巻き戻し、別の患者の編集は止まらない、復旧 4 通り）。変異確認 5 種（DB 失敗時の巻き戻し・準備相の握りつぶし・リトライ・入れ替え失敗の巻き戻し・復旧の索引突き合わせ）を外すとそれぞれ落ちる。

## 復元・切替・全件保存（P2-3）
- **Drive にだけあるファイルを索引へ**（モード A の reconcile、約 10 分おき・起動時・「今すぐ同期」）: Drive の `dicom/` を一覧し、台帳に無いファイル（別の PC が最後のスナップショットのあとに足した、または索引を失った）を、取得して**通常の取り込み（`DicomStorageService.ingest`）**へ渡す。台帳には「手元にある・Drive と md5 が同じ」として載るので送り直しは起きない。md5 が合わないもの・読めないものは飛ばし、ほかは続ける。モード B ではしない。状態 API に `adopted`（取り込んだ件数）。
- **すべてローカルに保存**（`POST/GET/DELETE /api/gdrive/localize`）: 追い出し済みの全行を並列（4 本・16 件ずつの窓）で取り寄せる。**開始前に空き容量を検査**（必要量＝追い出し済みの `size` の合計＋64 MiB の余裕。足りなければ `not-enough-space` で、1 件も取らない）。**実行中と完了後は追い出しを止める**（取った端から消えないように）。止めたままにするのは、設定が変わる（モード切替・解除の `configure`）か `DELETE /localize`（取り消し＝解放）まで。つながらなければ（オフライン・要ログイン）窓の区切りで止まり `FAILED`、再実行は取得済みをスキップして続きから。
- **切替・解除の条件**（`desktop/gdriveMode.js`・`graphy:gdrive-set-mode`・`graphy:gdrive-disable`）: backup→cache は同期が済んでいるときだけ（`CONNECTED`・未送信 0・止まった項目 0。それ以外は `not-synced`）。cache→backup と解除は追い出し済みが 0 件のときだけ（`not-all-local`）。backend の状態が取れないときも断る（`backend-unavailable`）。モード A の解除の確認文面は「手元が正本になる」に。
- **モード A の復元**（新しい PC）: `graphy:gdrive-restore` に `mode: "cache"` を渡すと、索引スナップショットだけを取り（`GdriveRestoreService` の `indexOnly`。DICOM は取らない・`dicom/` も作らない。スナップショットが無ければ `no-snapshot` で失敗）、復元先を**同じ Drive フォルダへ紐付ける**（`mode: cache`・既定の上限）。台帳はスナップショットに入っていて、最初の reconcile が手元に無いものを追い出し済みにし、スナップショットのあとの分は上の取り込みが拾う。
  - **計画との差（紐付けのタイミング）**: 計画は「復元が完了してから紐付ける」だったが、**開始時に紐付けて、失敗なら外す**に変えた（`watchRestore`）。完了を待つ間にアプリが閉じても、Drive につながっていない DB（取り寄せ先の無い追い出し済みを抱えたまま）を残さないため。つながっていれば、足りない分は最初の同期で Drive から索引へ戻る。
- テスト: `GdriveAdoptLocalizeTest` 9、`GdriveBackupFlowTest` +2（索引のみの復元・スナップショット無し）、`gdriveMode.test.js` 6、`gdrive.test.js` +1、`dbFolders.test.js` +1。変異確認（取り込みの md5 照合・台帳にあるものの再取り込み・全件保存中の追い出し停止・空き容量の検査・索引のみでも DICOM を取る・スナップショット無しでも成功にする・切替/解除の条件・復元失敗で外さない）を外すとそれぞれ落ちる。**偽の取り込み処理が壊れた内容や重複を自分で弾いていて、本体側の検査が効いているか分からなかった**ため、偽物を甘くして確かめ直した。
- **既知の制約**: 別の PC が Drive の側で削除した画像は、スナップショットの索引には残り、取り寄せると `not-on-drive` で失敗する（索引から自動では消さない＝保全を優先。件数の表示と整理は未実装）。`GdriveRestoreService` の索引のみの復元は、スナップショットの時点の索引なので、それ以降の別 PC の変更（患者編集など）は索引に反映されない。

## 画面（P2-4）
設定 → データ → Google Drive（`GdrivePanel.tsx`、表示ロジックは `gdriveView.ts`）。
- **有効化の前**に保存方式を選ぶ（バックアップ＝手元が正本／Drive が正本）。選んだ値を `graphy:gdrive-enable` に渡す。復元の前にも「すべて手元に保存する／必要なときに取り寄せる（索引のみ）」を選ぶ。
- **有効化後**: 保存方式の札、モード切替ボタン（確認ダイアログつき。条件を満たさないときは main が断り、理由を表示）、モード A では「手元のキャッシュ」枠 — 使用量バー（上限超過は橙）、手元の件数／全件、上限の入力（GB・DB フォルダごと。1 GB 未満・数でない値は送らない）、上限超過・空き容量不足の警告、「すべてローカルに保存」（進み具合・取り消し・失敗の理由・続きから再実行）、索引へ取り込んだ件数。
- **backend の状態**に `mode`・`cacheBytes`・`cacheLimitBytes`・`localCount`・`evictedCount`・`adopted`・`usableBytes`（手元の空き。モード A のみ）を追加。空きの警告は「上限まで増えうる分より空きが少ない」ときだけで、空きが不明（0）なら出さない。
- **失敗の文言**: 患者編集の失敗（409 `patient-edit-failed`）は「すべて取り消した・データは変更されていない」、手元に無い画像を取り寄せられなかった（503）は理由コード別の文言（`storageUnavailable.ts`）、DB 間転送の拒否（`cache-mode-unsupported`）は「先にすべてローカルに保存」。
- Drive 正本でオフラインのときの説明は、未送信の件数ではなく「手元に無い画像（N 件）は開けない」。
- テスト: vitest +36（`gdriveView.test.ts`・`dbAdminErrors.test.ts`・`dbTransferView.test.ts`）。変異確認 5 種。**実際の画面を開発サーバー＋スタブで 11 状態スクリーンショットで確認**し、そこで見つかった 2 点（Drive 正本のオフライン表示が「未送信 0 件」と不自然・解除ボタンの文言）を直した。操作（有効化・上限・切替・全件保存・復元・解除）がメインプロセスへ正しく渡ることを、実際にクリックして 17 項目すべて確認（上限の負例 4 種を含む）。
- **未対応**: ビューアで手元に無い画像を開けなかったとき（503）の理由の表示。ビューアの読み込み失敗は従来の汎用表示で、理由コードはネットワークログにだけ残る。

## 既知の制約・仮の値
- 直近 10 分の読み出し保護（`GdriveSyncService.RECENT_ACCESS_MS`）は仮。返した `Path` を後で開く経路（`FileSystemResource` の Range 配信、エクスポートのコピーループ）があるため、参照カウントの代わりに時間で守っている。実測で見直す。
- 追い出しでは空になった親フォルダを消さない（取り込みとの競合を避けるため）。空のフォルダが残る。
- 上限を超えるのは、未送信が多いとき（オフライン中の取り込みなど）と、同期した直後の 10 分間。画面に警告を出す（P2-4）。

## 段階
| 段 | 内容 | 状態 |
|---|---|---|
| P2-1 | 台帳の列・設定の貫通・追い出し・reconcile の分岐・削除の通知 | 実装・単体テスト済み（`GdriveCacheModeTest` 10 件、desktop 2 件）。変異確認: 候補の `SYNCED` 条件・追い出し済みの扱い・直近保護 |
| P2-2 | `resolveForRead` の取得（md5 検証）・`StorageUnavailableException`・503・一括先読み・書き換え前の取得・DB 間転送の拒否 | 実装・テスト済み（`GdriveFetchTest` 16 件、`StorageUnavailableHttpTest` 2 件、`DbAdminTest` +3、`DbTransferTest` +1、ハンドラ +1）。変異確認: md5 照合・mtime 復元・同時要求の排他・失敗の null 化・取り寄せ/通知の欠落・転送拒否 |
| P2-2b | 患者編集を全か無かに（上記） | 実装・テスト済み |
| P2-3 | モード A の復元（索引のみ）・解除条件・「すべてローカルに保存」・B→A 切替・Drive にだけあるファイルの取り込み | backend・desktop 実装・テスト済み（画面は P2-4、実 Drive は P2-5） |
| P2-4 | GdrivePanel（モード・上限・使用量・全件保存・復元のモード選択）・i18n・vitest・スクリーンショット | 実装・テスト済み（ビューアの 503 表示は未対応） |
| P2-5 | 実 Drive 検証（小さな上限で追い出し→取得）・文書 | 実機で通し 28/1/0・復元 9/0/0。見つかった終了処理の不具合（ロック残り・スナップショット欠落）を修正し、実アプリで修正前後を確認（`fw/verify-db-gdrive.md` §5） |
