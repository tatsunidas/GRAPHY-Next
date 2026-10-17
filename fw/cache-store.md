# 汎用 CacheStore（P2-7）

ローカルに置く成果物キャッシュの「周りの決まり」を 1 か所にまとめた部品。`com.vis.graphynext.cache.CacheStore`。
Drive の保管庫のキャッシュ（`GdriveSyncService` の追い出し）とは**別物・別枠**で、ローカルのみ。

## 決まり
- 1 インスタンス＝1 フォルダ。`getOrCreate(name, valid, producer)` が唯一の入口。
- **原子的に確定**: 一時ファイル（`.tmp-*`、拡張子は最終名と同じ）に書き、成功したときだけ最終名へ move。例外・kill で不完全なものは最終名に現れない。
- **同じ名前の同時要求は 1 回だけ生成**。別の名前は互いに待たない。
- **上限（バイト、0＝無制限）**: 超えたら最後に使われたのが古い順に消す。今作った項目は消さない。消せない項目（Windows で配信中など）は飛ばす。
- **起動時**: 前回の一時ファイルを消し、残っている項目から索引を作り直す。
- **版数は呼び出し側がファイル名に入れる**。有効判定（元ファイルとの mtime 比較など）も呼び出し側の `valid`。
- 最終アクセス時刻は**メモリ上**。ファイルの mtime は触らない（動画の `isUsable` が mtime 比較に依存するため）。再起動後は mtime が初期値。

## 載せ替え済み
| 対象 | 場所 | 上限 |
|---|---|---|
| 動画 MP4 | `<storageDir>/.cache/video/`（`VideoRenderService`） | `graphy.dicom.video-cache-max-bytes`（既定 0＝無制限＝従来どおり） |

予定: P2-8 Radiomics 途中スライス結果・チェックポイント、P2-9 プラグイン向け `host.cache`、P2-10 TTL 掃除の共通化、P2-11 解析キャッシュの設定（既定値は実測後にユーザーへ確認）。

## 検証記録（2026-10-17）
- 単体 `CacheStoreTest` 17 件、backend 全体 1013 件・失敗 0・skip 9（PATH に ffmpeg が無いと skip する既存の動画テスト）。
- **変異確認**（5 件すべて該当テストが落ちた）: 失敗時の一時ファイル削除を外す／起動時掃除を外す／LRU を逆順／キー別ロックを外す／今作った項目を保護しない。
  - 未確認: 「原子的 move を通常コピーに替える」変異は、確定の瞬間の kill を決定的に再現できないためテストで捉えていない（move の使用は目視のみ）。
- **旧新同時比較**（旧＝載せ替え前の `VideoRenderService`、新＝載せ替え後。同じ DICOM を両方に通した）: MP4（偶数長・奇数長＝埋め草除去）・MPEG-2 基本ストリーム・H.264 基本ストリームを、ffmpeg 代用スクリプトあり／なしで 8 ケース。出力バイト列・例外型・フォルダ内のファイル名が**全件一致**。
  - 限界: この比較は ffmpeg の代用スクリプトでの確認（コマンドの渡し方と出力先の扱いまで）。実 ffmpeg での変換は、PATH に anaconda の実物（`anaconda3/envs/stable/bin/ffmpeg`、libx264・mpeg2video あり）を通して `VideoRenderServiceTest`・`ExportVideoBundleTest` を流し、**skip 0・19 件合格**（MPEG-2 再エンコード、H.264 remux、キャッシュ再利用、元が新しくなったときの作り直しを含む）。実 ffmpeg の出力を旧新でバイト比較したものではない。
- **実アプリ**（パッケージ jar、専用ポート、上限 70000 B、動画 DICOM 3 件）: `/rendered` は 200、Range は 206。上限を超える要求で最古が消え、消えた項目の再要求は 200 で再生成。`.tmp-*` の残骸を置いて再起動すると起動時に消えた。生成途中の kill そのものは再現していない（残骸を置いて代用）。

## 既知の注意
- 配信中の項目が追い出されると、Windows は削除失敗＝飛ばす。Linux/macOS は開いたまま読めるが、Range の 2 回目要求で再生成になりうる（実測の頻度は未取得）。
- 旧実装が残した `raw-*.bin`/`conv-*.mp4` の残骸は自動では消えない（名前が他用途と衝突しうるため、この部品では触らない）。

## P2-8: Radiomics マップの途中スライス結果（2026-10-17）
長い計算（数分〜数時間）がキャンセル・失敗・終了で最初からになるのを、**スライス単位の保存→再投入で続きから**にした。

### 仕組み
- `RadiomicsMapEngine` の「全スライス一括」を、RadiomicsJ の `slice` 指定で **1 枚ずつ**に変更（`computePerSlice`）。1 枚終わるごとに `MapCheckpointStore`（`<storageDir>/.cache/radiomics`、`CacheStore` 上の `Checkpoints`）へ保存し、同じ入力の再投入では保存済みの枚を使う。
- 保存するのは補間（stride>1 の bilinear 拡大）・リサンプリング戻し**より前**の計算結果。派生 DICOM は従来どおり保管庫へ取り込み、取り込み後にそのジョブの途中結果を消す。失敗・キャンセル・落ちたときだけ残る。
- キャンセルは「1 枚終わって保存した後」に効く（従来と同じ粒度。保存済みの枚は失われない）。
- **キーは入力の中身から作る**: 読み込んだ画像・マスクの画素、校正（画素間隔）、特徴・カーネル・stride・2D/3D・margin・label・設定、RadiomicsJ の版（クラスパスの `pom.properties`。取れなければ途中結果を使わない）、エンジンの版定数。ファイルの mtime などの間接的な印は使わない（計画の「SOP UID＋サイズ＋mtime」から変更。画素が同じなら同じ結果、違えば別のキーになるため、より確実）。シリーズ説明・番号はキーに含めない。
- 上限は未設定（無制限）。既定値は P2-11 で実測のうえ決める。1 枚 = 幅×高×4 B（512×512 で約 1 MiB）。

### 検証記録
- **関門 0**（全スライス一括 vs `slice` 指定 1 枚ずつ、全画素のビット一致）: 族 6 種（FIRSTORDER_Mean / GLCM_JointEntropy / GLRLM_RunEntropy / GLSZM_ZoneSizeEntropy / NGTDM_Coarseness / NGLDM_DependenceCountEntropy）× 2D/3D × stride {1,3} × margin {0,3} × マスク {部分, 全面} ＋ GLAM（3D・部分マスクのみ）で **100 組合せ中 100 一致・不一致 0**。検出器の負例（margin 違い・添字違い）はどちらも「不一致」と検出できた。合成ファントム（24×24×6 ほか）での確認で、実画像での確認ではない。
- 単体: `CheckpointsTest` 6 件、`RadiomicsMapEngineCheckpointTest` 7 件（打ち切り→続きから＝通しと全画素一致、画素/margin/2D/特徴が違えば再利用しない、説明だけの違いでは再利用、破損 1 枚だけ再計算、版不明なら保存しない、同梱版の検出）。backend 全体 1057 件・失敗 0・skip 9。
- **旧新同時比較**（旧＝載せ替え前のエンジン。同じ入力、新は「2 枚で打ち切り→続きから」の結果）: 6 族 × 2D/3D × stride {1,3} × margin {0,3} の **48 組合せで 48 一致・不一致 0**（全画素のビット一致、復元 2 枚を確認）。
- **変異確認**（5 件すべて該当テストが落ちた）: キーから margin を外す／保存の添字を 1 ずらす／ヘッダ検査を外す／成功時の消去を外す／キーから画素を外す。
- **実アプリ**（パッケージ jar・専用ポート・合成 CT 風 96×96×24、GLCM_JointEntropy カーネル 5・3D）: 13 枚目でキャンセル（保存 14 件）→ 再投入で「14 of 24 slices restored from checkpoints」、完了後に途中結果 0 件。再開して作った派生シリーズと、途中結果なしで通しに作ったシリーズは、**24 枚すべて画素・RescaleSlope/Intercept が一致**。
- 未検証: 実画像・大きなボリュームでの時間短縮の実測、GLAM を実アプリで中断→再開、アプリ終了（kill）をまたいだ再開（同じディスク上の保存なので成り立つ想定だが、プロセスを kill しての確認はしていない）、Windows/macOS 実機（CI の単体テストのみ）。

## P2-9: プラグイン向け `host.cache`（H69）（2026-10-18）
プラグインにも「消えてもよい派生データ」の置き場とチェックポイントを開いた。設計書 `fw/plugin-architecture.md` H69・作者ガイド §2-3c。

### 仕組み
- `PluginCacheService`（`<storageDir>/.cache/plugins`、`CacheStore` 上の `Checkpoints`）。名前は `p<sha256(プラグイン id) 16桁>-<sha256(種別+鍵) 32桁>`。**鍵の文字列はディスク上の名前にも URL にも出ない**。項目と checkpoint は種別が別（同じ文字列でも別の項目）。
- REST `PluginCacheController`（H67 と同じ `guard`）: `PUT|GET|HEAD|DELETE /api/plugins/{id}/cache/item`、`PUT|GET|DELETE .../cache/checkpoint/{index}`、`DELETE .../cache/checkpoint`。鍵はヘッダ `X-Plugin-Cache-Key`。本体は読む前に Content-Length で上限を弾く。
- 画面 `host.cache`（`pluginCacheApi.ts`、`m.id` に固定）、JAR `spi/PluginCache`（args の `__cache`、`PluginJobService.CACHE_KEY`。画面から同名キーが来ても上書き）。
- `CacheStore.removeByPrefix`、`Checkpoints.loadAny`/`clearAll` を追加。

### 1 件の上限を 64 MiB から 16 MiB に下げた経緯（計画からの変更）
計画では 64 MiB（仮の値）だった。実アプリ（パッケージ版 Electron 31・Linux）で調べると、**画面（renderer）から約 40 MiB 以上のボディを 1 回の fetch で送るとウィンドウごと落ちる**（16・32 MiB は正常、40・44・48・64 MiB は落ちた。宛先が `/actuator/health` でも同じ＝backend は無関係。配列の確保だけなら 64 MiB でも落ちない。60 MiB のダウンロードは正常）。原因は未調査（Chromium 側と思われるが、この機械固有かどうかも不明）。ユーザーに諮り、**既定 16 MiB に下げる**とした。画面側は backend の上限を上げた環境でも 32 MiB 超は送らず `too-large`。大きなデータは checkpoint の添字で分割する。

### 番号
H68 は並行して別セッションが顕微鏡の取り込み（#323）に使ったため、この機能は **H69**。同時期に `Checkpoints.load(jobKey,index)`（長さを問わない読み出し、ROI 特徴量表用）も main に入ったので、こちらの `loadAny` は捨てて main のものを使い、`clearAll` だけ足した。

### 検証記録
- 単体: `PluginCacheServiceTest` 13 件（往復・上書き・削除、別プラグインの同じ鍵は見えず消せない、鍵がファイル名に出ない、不正な鍵、上限超過は何も残さない・上書き失敗は前の値が残る、破損は「無い」扱い、checkpoint が jobKey ごとに独立、JAR 口が値で返す、再起動後も読める）、`PluginCacheHttpTest` 6 件（実 HTTP: 3 MiB のバイナリがバイト一致、日本語・空白・`+` の鍵、別 id で 404、鍵なし・長すぎ・制御文字・不正エンコードで 400、4 MiB+1 は 413 で何も残らず・ちょうどは通る、checkpoint の往復と全消去）、`CheckpointsTest`/`CacheStoreTest` の追加、`PluginJobServiceTest` の `__cache` 注入と上書き。frontend `pluginCacheApi.test.ts` 7 件。backend 全体 1077 件・frontend 全体 2333 件・失敗 0（main の変更を取り込んだ後は backend 1106 件・frontend 2343 件・失敗 0）。
- **変異確認**（backend 5 件・frontend 3 件、すべて該当テストが落ちた）: 名前にプラグイン id を入れない／上限検査を外す／`clearAll` が別の jobKey も消す／`__cache` の上書きを外す／項目と checkpoint の種別を区別しない、画面: URL の id を無エンコード／鍵を URL エンコードせずヘッダに／添字検査を外す。変異が効かない箇所: 本体を読む前の Content-Length 検査（外しても最終的に `TOO_LARGE` を返すので結果が同じ。守っているのはメモリ使用量で、テストでは観測できない）。
- **実アプリ**（パッケージ版・専用ポート・実プラグイン［UI＋JAR を実際に置いた］をメニューから起動）: 1 回目 11/11 合格（3 MiB の SHA-256 一致、has、17 MiB は `too-large` で何も残らない、不正な鍵、別 id は 404・自分の id は 200、checkpoint 保存、**実 JAR のジョブが `__cache` を受け取り、画面が置いた項目を読め、往復・上限超は false・checkpoint・clear が動く**）。アプリを終了して再起動した 2 回目 3/3 合格（3 MiB の項目が SHA-256 まで一致、checkpoint が読め、保存していない添字は null）。H67 で未確認だった「実 JAR 経由」は今回確認した。
  - 検証の落とし穴: 最初の実行は、前の実験のアプリが旧ビルドのままポートを握っていて、**旧版の backend に対して**走り、上限超の確認が誤って不合格になった。孤児プロセスを止めてから新ビルドだけで取り直した。
- 未検証: Windows/macOS 実機（CI の単体・統合テストのみ）、web モードの 501（テストは standalone のみ）、32〜40 MiB の間の正確な閾値（画面側の上限は安全側の 32 MiB で固定）、プラグインのアンインストール時の項目の削除（今は上限の追い出し任せ）。


### ROI 特徴量表の結果（2026-10-18）
- ROI 特徴量表（`RoiFeatureService`、RadiomicsJ の一括抽出）の結果も同じ置き場所（`.cache/radiomics/`）に **1 項目（添字 0）の JSON** で置く。マップの途中結果と違い**消さない**（同じ入力の再要求に返す）。消えても計算し直せる。
- キー（`MapCheckpointStore.featureKey`）: エンジンの版定数 `roi-features-1`、RadiomicsJ の版、RadiomicsJ に渡す設定（上書き後・キー順）、ラベル、寸法、校正、画像とマスクの画素。シリーズ UID・説明は含めない。版が取れなければ使わない。
- 長さの決まらない項目のため、`Checkpoints.load(jobKey, index)`（ヘッダの本体長で読み、ファイルの大きさと食い違えば無いものとして扱う）を足した。
- 検証: 2 回目は抽出 0 回・値の差 0。設定 1 つ・マスクの画素 1 つ・RadiomicsJ の版の違いでは計算し直し、シリーズ UID だけの違いでは使う。壊れた項目は計算し直して置き換わる。取り消したジョブの結果も残る。変異確認（キーから設定・マスクの画素・版を外す）で 3 件とも該当の試験が落ちた。
