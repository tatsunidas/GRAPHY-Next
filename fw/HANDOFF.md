# GRAPHY-Next 引き継ぎドキュメント

> 更新日: 2026-08-11（最終更新: **NIfTI インポートを追加**。下記エントリ参照）

> 🟢 **2026-08-11 NIfTI インポートを追加（PR #111）＋ 実機確認で分かったこと**
> - **NIfTI（.nii/.nii.gz）を DICOM 化して取り込めるようになった**（`fw/nifti-import.md` が正本）。
>   Swing 版 `NIfTIToDicomConverter` の移植。4D は Z/T/C に展開し、時相は
>   `TemporalPositionIndex`＋`TriggerTime`（`SeriesLayoutBuilder` の T 判定に合わせる）。
>   **qform=sform=0 のファイルは向きを合成**し、その事実を `ImageComments` /
>   `DerivationDescription` / UI 警告に残す。実データ（ACDC cine 216×256×10×30）で
>   取り込み 300 枚 → 2D Viewer に Z=10 / T=30 を確認。
> - 🔴 **TODO: JPEG-LS（1.2.840.10008.1.2.4.80/.81）の表示が未確認**。配布ビルドの CSP
>   （`script-src 'self' 'wasm-unsafe-eval'`）が、dicom-image-loader 同梱の **charls / libjpeg-turbo の
>   embind グルーが使う `new Function` をブロック**する（DevTools に警告が出る）。
>   **JPEG Baseline / JPEG Lossless P14 / JPEG2000 (lossless・lossy) / RLE は実機で表示を確認済み**
>   （エラー 0 件）で実害は無かったが、**手元に JPEG-LS のサンプルが無く charls だけ未検証**。
>   サンプルが手に入ったら確認する。**CSP を緩める対応は取らない**（プラグインが同じレンダラで
>   動く設計のため、文字列評価を開けると任意コード実行を許すことになる）。
> - 実機確認中に気づいた本体の挙動 2 点（未修正・要判断）:
>   1. **MainScreen で別シリーズを選んでも、既に開いている 2D Viewer は切り替わらない**（開き直しが要る）
>   2. スタディ検索の初期条件が「本日」のため、**過去日付のデータは初期表示に出ない**
>      （Clear だけでは再検索されず、日付を明示的に広げる必要がある）

> 🟢 **2026-07-31 モバイル UI 実機検証（M9）＋修正をデモへ反映**（すべて main 直コミット・push・demo 再デプロイ済み）
> スマホ実機で 2D/3D/MPR を確認し、以下を修正した（デモ機＝dev 機で `demo-deploy` 実行）。
> - **2D シリーズビューで画像が出ない**（`fix c97f8c3`）: `mobile/MobileViewer.tsx` の画像領域 `stage` に
>   `display:flex/flexDirection:column` が無く `SeriesViewer(fillHeight)→Viewer2D(fill)` の高さ連鎖が潰れていた。
> - **デプロイしても古い UI のまま（キャッシュ）**（`fix ff0219b`）: SPA の `index.html` が no-cache 無しで配信され
>   古い index.html→古いハッシュ JS が居座っていた。`spring.web.resources...no-cache=true`＋`/assets/**` を
>   immutable に（`WebConfig`）。**以後のデプロイは利用者のキャッシュ削除不要で自動更新**。
> - **3D の Zoom/Pan がタッチで効かない**（`feat f393507`）: `vtkVolumeView.ts` はマウス manipulator のみだった。
>   `vtkGestureCameraManipulator` を 1 回登録し、ピンチ=Zoom / 2 本指=Pan / 2 本指ひねり=回転を有効化。
> - **MPR がタッチで全く動かない**（`feat 1378407` ＋ `fix 6704ae3`）: `mpr.ts` にタッチバインドが無く、
>   Crosshairs はタッチ非対応。ヘッダに **1 本指ツール切替[スライス送り/W-L/移動]** を追加、2 本指ピンチ=Zoom は常時。
>   モバイルは Crosshairs を Passive にして 1 本指スロットを解放。**注意**: Cornerstone の `setToolActive` は
>   バインドを**マージ（削除不可）**するので、切替時は `setToolPassive(name,{removeAllBindings:true})` で
>   一旦全消去してから貼り直す（さもないと numTouchPoints:1 が残り常に同じツールに解決される）。
> - **3D の機能はモバイルでも意図的にフル**（端末クラスで機能ゲートしない方針・`fw/mobile-ui-design.md` §L89）。
>   narrow で隠すのは Cinematic/パストレーサのみ、右パネルはドロワー化。開閉可否はメモリガードが判断。

> 更新日: 2026-07-31（**ボリュームメモリガード V1〜V4 とモバイル UI M1〜M8 を実装**（PR #104）。
> 動画は P1〜P5a 完了で残るは P5b（web/BFF）。下記の各ログ参照）

> 📍 **動画（DICOM video）の現在地と次の一手（2026-07-31 時点）**
> 正本: [`fw/video-viewer-design.md`](video-viewer-design.md)。**standalone では一通り使える状態**になった。
>
> | フェーズ | 内容 | 状態 |
> |---|---|---|
> | P1 | `/rendered`（Range 配信）＋最小再生 | ✅ 実機検証済 |
> | P2/P3a | VideoViewport（方式 A）＋自作 cine コントロール | ✅ 実機検証済 |
> | P3b | ツール（W/L・Pan/Zoom・計測・ROI） | ✅ 実機検証済 |
> | P3c | ROI 解析（時系列 TIC・単一フレーム統計・帰属モード・選択解析） | ✅ 実機検証済（PR #96） |
> | P4 | 非 H.264（MPEG2 等）の配信時変換 | ✅ 実機検証済（PR #98） |
> | P5a | Export 媒体へ MP4 同梱 → Portable 2D Viewer で再生 | ✅ 実機検証済（PR #99） |
> | **P5b** | **web(BFF) モードの動画** | 🔴 **未着手（残りはこれだけ）** |
>
> **P5b の出発点**（設計は `fw/video-viewer-design.md` §8）:
> - 現状 web モードは `/rendered` が使えず（索引がローカル前提）、UI は `video.webUnsupported` の案内を出すだけ
>   （`StudyList.tsx`）。PACS から WADO-RS で Part-10 を取り、**P4 の `VideoRenderService` にそのまま流す**
>   （MP4 化・キャッシュ・Range 配信は既にあるので、足すのは「取得」だけ）という筋が素直。
> - 検証環境は揃っている: このマシンで **dcm4chee が動いている**（8080/11112）。動画の DICOM は
>   `automator/scripts/make-mpeg2-video-dicom.py` で作れるので、STOW-RS で入れて BFF 経由の取得を確かめられる。
>   web モードの実機検証の型は `automator/src/spike/h4bWebStowCheck.ts` が参考になる。
>
> **動画の実機検証スパイク（standalone）**— 変更したらこれらを回す:
> - `automator/src/spike/videoRoiFrameModeCheck.ts`（34 項目）… ROI の帰属モード・選択解析・計測テキスト追従
> - `automator/src/spike/videoFrameAccuracyCheck.ts`（11 項目）… フレーム精度（合成動画を線形当てはめで判定）
> - `automator/src/spike/videoMpeg2TranscodeCheck.ts`（18 項目）… MPEG2 の配信時変換
> - `automator/src/spike/portableVideoCheck.ts`（20 項目）… Export 媒体 → Portable Viewer 再生
> - ⚠ **同じマシンで別 worktree の automator と並走すると既定ポートで衝突する**。片方で
>   `GRAPHY_AUTOMATOR_HTTP_PORT` / `..._SCP_PORT` / `..._VITE_PORT` を指定すること。
> - ⚠ **`portableVideoCheck` は `target/classes/portable-viewer` が無いと VIEWER/ 同梱に失敗する**。
>   `-Dfrontend.skip=true` でパッケージしていると生成されないので、`cd frontend && npm run build:portable` の
>   成果物（`portable-dist/`）を同ディレクトリへ置いてから jar を作り直す。

> 🟢 **2026-07-31 ボリュームメモリガード（V1〜V4）とモバイル UI（M1〜M8）を実装**（PR #104）
> 正本: [`fw/volume-memory-guard.md`](volume-memory-guard.md) ／ [`fw/mobile-ui-design.md`](mobile-ui-design.md)。
> 両ドキュメントのフェーズ表とフェーズごとの実装メモ（設計から外した理由込み）が最新。
>
> - **メモリガード**: ボリューム構築は今まで**上限設定・事前予測・エラー識別のどれも無かった**。
>   V1=`setMaxCacheSize` を明示（従来 cornerstone 既定 3GB 放置）＋超過エラーの識別、
>   V2=構築前に必要量を予測して確認、V3=Electron IPC で実搭載量からバジェット決定、
>   V4=`MAX_3D_TEXTURE_SIZE` 超過をエラーで停止（従来は無言で真っ黒）。
>   backend の `SeriesLayout` に `PixelFormat`（bytes/voxel 予測用）を追加している。
> - **モバイル UI**: `frontend/src/mobile/` に web モード専用の単画面シェルを新設（`#mobile`）。
>   既存 UI はレスポンシブ化せず、描画コア（`SeriesViewer`/`Viewer2D`）は**無改変で再利用**。
>   MPR/3D だけは既存画面を狭幅で作り分けた（元々 `fixed inset:0` の全画面で単画面シェル向きのため）。
> - **併せて web モードのレポートの既存不具合 2 件を修正**（独立した別々の原因）:
>   キー画像ありの確定が **409 で必ず失敗**していた（SOPClassUID をローカル H2 索引から引いていた）／
>   SR/KO が PACS に届かない**「見えない SR」**（web でも `storage.ingest()` 固定だった）。
> - タッチ対応で `viewer/Viewer2D.tsx`・`viewer/SeriesViewer.tsx`・`mpr/`・`viewer3d/` にも手が入っている
>   （2 本指=ZoomTool のピンチ+Pan、3 本指=スライス送り、`touch-action: none`）。**デスクトップの既定挙動は不変**。
>
> 🔴 **残りは実機検証（M9）だけ。手順は `fw/mobile-ui-design.md` §10 に 19 項目の表。**
> ⚠️ **実機確認前に自動振り分けを有効化してある**（`mobile/mobileRoute.ts` の `MOBILE_SHELL_READY = true`）。
> web モードのスマホ利用者＝**公開デモの利用者も対象**。
> 🔧 **不具合が出たらこの 1 行を `false` に戻す**（自動振り分けだけ止まり、System メニューの手動切替は残る）。
> ⚠️ V3 の Electron IPC と M7 の STOW-RS は自動テスト対象外で未検証。
> 📌 ローカルの `mvn test` で `AnnouncementServiceTest`（Mockito）と `VideoRenderServiceTest`（バイト数）が
> 落ちるのは**ローカル環境（Java 25）固有**。GitHub Actions では 3 プラットフォームとも通っている。

> 🟢 **2026-07-31 動画 P5a 完了: Export した媒体だけで動画が見られるようにした**
> （正本: [`fw/video-viewer-design.md`](video-viewer-design.md) §7、[`fw/export-portable-viewer.md`](export-portable-viewer.md)）。
> - Export が **`VIDEO/{SOPInstanceUID}.mp4`** を同梱し（portable viewer 同梱 ON の時のみ）、Portable 2D Viewer が
>   DICOMDIR の ReferencedSOPClassUIDInFile で動画シリーズを判定して `<video>` で再生する。
>   変換は配信と同じ `VideoRenderService`（P4）を通すので **MPEG2 等モダリティ由来の動画も同梱できる**。
>   作れない時は警告のみで Export は続行（DICOM 本体は入っている）。
> - 🚨 **検証で見つけて直した 2 件**: (1) portable viewer の CSP に `media-src` が無く、blob: の動画が
>   **必ずブロックされていた**（`default-src 'self'` へフォールバックするため）。(2) `#grid` の
>   `display: grid` が `hidden` 属性を上書きし、**動画表示中も画像タイルが見えたまま**だった。
>   後者は `el.hidden` を見る自己検証では素通りし、**スクリーンショット目視で気づいた**
>   → 表示の検証は `getBoundingClientRect()` で行うこと（自己検証もそう直した）。
> - ついでに既存の穴も 1 件: `copyPortableViewer` が classpath の重複エントリで
>   `ZipException("duplicate entry")` を投げ **Export 全体を落としていた**（実ビルド成果物とテスト用
>   フィクスチャが同時に classpath にある時）。先勝ちで重複を捨てるようにし、
>   `ExportPortableViewerTest` の「ちょうど 2 件」固定（実成果物があると必ず落ちる）も止めた。
> - 検証: `automator/src/spike/portableVideoCheck.ts` **20/20**（Export → ZIP 展開 → ローカル HTTP で配って
>   **実 Google Chrome** で `?selfTest=`。Playwright 同梱 Chromium は H.264 を持たないので使わない）。
>   backend **290 tests** / frontend typecheck・vitest 253・build・portable typecheck/build すべて green。
> - 動画で残るのは **P5b（web/BFF モード）** のみ。
>

> 🟢 **2026-07-30 動画 P4 完了: MPEG2 等も `/rendered` で配信できるようにした**
> （正本: [`fw/video-viewer-design.md`](video-viewer-design.md) §4.3 / §6 P4）。新規 `VideoRenderService`。
> - **判定は転送構文ではなくペイロードの中身**。取込済み動画は MP4 だが、**モダリティ由来の正規 DICOM video は
>   コンテナ無しの基本ストリーム**（MPEG2=MPEG-2 video ES、MPEG-4 AVC=H.264 Annex-B）を入れてくるため、
>   転送構文だけで「H.264 だから無変換で出せる」と判断すると後者が**再生できない**（P1 から残っていた穴）。
>   → MP4 はそのまま／H.264・HEVC の ES は **remux（`-c:v copy`）＝再圧縮なし**／MPEG2 等は libx264 で再エンコード。
> - 🚨 **基本ストリームには時間情報が無いので `-r <fps>` を入力側に必ず渡す**。省くと raw demuxer が 25fps を
>   仮定し、さらに**先頭フレームの PTS が 1 フレーム分ずれて「フレーム f の統計が f−1 の値」になる**
>   （実機検証で検出。実測 duration 2.067s / 先頭 PTS 0.066）。`-fps_mode` は ffmpeg 5.0 以降にしか無いので
>   使わない（同梱 4.x で失敗）。⚠ 生 MPEG-2 は **muxer 名 `mpeg2video` / demuxer 名 `mpegvideo`** で異なる。
> - キャッシュは `{sop}.{版}.mp4`。**版をファイル名に入れる**ので変換コマンドを変えたら上げるだけで古い成果物を
>   捨てられる。加えて**元 DICOM より新しいことを要求**する（同じ SOP を削除→再取込した時に古い変換結果を
>   配信し続けないため。automator の reset も実ファイルは消すがこのキャッシュは消さない）。
> - `/video-metadata` に `transcodeAvailable` を追加し、UI の案内は **変換もできない時だけ**出す。
> - 検証: backend `VideoRenderServiceTest` 16 件（ffmpeg 不在環境では実変換系を skip）＋ backend 全 **287 tests green**、
>   実機 `automator/src/spike/videoMpeg2TranscodeCheck.ts` **18/18**。MPEG2 のままの DICOM は
>   `automator/scripts/make-mpeg2-video-dicom.py`（ffmpeg ＋ pydicom）で組み立てる
>   （取込経路は非 H.264 を取込時に H.264 化するので、取込では作れない）。
> - 残: **P5（Portable / web）のみ**。小さな穴として、インスタンス削除時に `.cache/video/*.mp4` が消えない
>   （孤児ファイル。配信の正しさは版＋mtime 判定で担保）。HEVC の remux 経路は実データ未検証。
>
> 目的: 別の作業者（Claude 含む）がこのリポジトリの状況を把握し、続きを実装できるようにする。
> このファイル＋ `fw/` 配下の各設計ドキュメントが「ソース・オブ・トゥルース」。
>
> 🟢 **2026-07-30 動画 ROI のフレーム指定モードを実機検証 → 表示の不具合を修正**
> （正本: [`fw/video-viewer-design.md`](video-viewer-design.md) §12）。
> PR #69 で入れた「フレーム指定 ROI モード＋単一フレーム統計」は typecheck / vitest のみ green で
> **UI 未検証**のまま残っていた項目。standalone（backend jar ＋ Vite ＋ 実 Electron）で通し、
> 新規スパイク `automator/src/spike/videoRoiFrameModeCheck.ts` が **30/30 green**。
> - 🚨 **見つかった本命の不具合: グローバル ROI が描いたフレーム以外で表示されない**。
>   原因は cornerstone の前提の読み違い。`AnnotationTool` は生成時に `viewport.getViewReference()`
>   （＝描いた瞬間のフレーム）を metadata に入れ、`VideoViewport.isReferenceViewable()` が
>   **`metadata.sliceIndex === 現在フレーム` を要求する**ため、video viewport の annotation は素の状態で
>   **描いた 1 フレームにしか出ない**。PR #69 は逆（「素では全フレームに出る」）と想定して
>   `annotation.visibility` だけで隠していたので、グローバル化しても他フレームで描画されなかった。
>   → 帰属の反映を **metadata の参照フレーム書き換え**に変更（`videoRoiScope.ts` の純粋関数
>   `applyScopeToReference()`: グローバル=`sliceIndex` を消す／フレーム指定=`sliceIndex = frame-1`）。
>   `visibility` は補助として残す。**同種の思い込みは他の viewport でも起きうる**ので、
>   フレーム/スライス帰属を扱うときは `isReferenceViewable` の条件を先に読むこと。
> - 併せて修正: ROI チップの枠線がショートハンド `border` と `borderStyle` 混在で React 警告
>   （再描画時に枠が消えうる）→ `borderWidth/Style/Color` に分解。
> - 検証の作り: フィクスチャ動画は **ffmpeg で合成**（無ければスパイクが自動生成）。
>   `lum = 20 + (X/W)*100 + T*60` の全 I フレーム H.264 なので、**輝度が時間で単調増加**し
>   「フレーム f の統計が本当に f のものか」を数値で判定できる（実測 F3 平均 85.7 → F28 平均 202.1）。
>   表示/非表示は cornerstone の内部 API ではなく **SVG レイヤの DOM**で判定する（利用者に見えるもので判定）。
> - 続けて **P3c の残タスクも実機検証で完了させた（同日）**。`videoRoiFrameModeCheck.ts` は 34/34、
>   新規 `automator/src/spike/videoFrameAccuracyCheck.ts` は 11/11 green。
>   - 🚨 **ループ有効だと最終フレームへシークできない不具合を発見・修正**。`loop` が真のとき最終フレームを
>     要求すると **frame 1 へ巻き戻っていた**（VideoViewport はフレーム範囲を超えたと判断すると loop 時に先頭へ戻す）。
>     利用者には「シークバーを端まで動かすと先頭に飛ぶ／最後のフレームが見られない」と見える。
>     → `seekToFrame()` はシーク中だけループを外し、再生開始時に戻す。**ループ再生の挙動は変えていない**。
>   - ✅ **計測テキストのフレーム追従**: cornerstone の `cachedStats` が作成フレームの値のままだったので、
>     フレーム変更時に `invalidateAnnotation()` で無効化。パネル値と一致することを実測（F3 85.6 / F28 202）。
>   - ✅ **複数 ROI の選択解析**: 一覧チップのラベルで解析対象を選べる。**選択した ROI が解析できない帰属なら
>     黙って別の ROI を解析せず理由を出す**（選択が無視されたように見えるのを防ぐ）。
>   - ✅ **フレーム精度シークは「対処不要」と決着**。キーフレームが先頭だけ・フレームごとに輝度が飛び飛びの動画で
>     測ると `measured ≈ 1.165 * level − 18.69`（限定→フルレンジ変換そのもの）・**最大残差 0.44**・同定フレーム全件一致。
>     `(frame-1+0.5)/fps` へシークする現実装で十分で、`requestVideoFrameCallback` 経路は要らない。
>   - **automator のポートを環境変数で差し替え可能にした**（`GRAPHY_AUTOMATOR_HTTP_PORT` / `..._SCP_PORT` /
>     `..._VITE_PORT`）。同じマシンの別 worktree から automator を並走させると既定ポートで衝突して
>     `assertPortFree` で落ちる（実際に発生した）。並走時はどちらかで指定する。
>   - → **P3c 完了**。動画で残るのは P4（MPEG2 等の ffmpeg 変換）と P5（Portable / web）。
>
> 📝 **2026-07-30 設計 2 本を新規追加（実装は未着手）**
> → [`fw/volume-memory-guard.md`](volume-memory-guard.md) / [`fw/mobile-ui-design.md`](mobile-ui-design.md)
>
> **経緯**: 「Web 版にスマホ/タブレットでアクセスしたとき自動でモバイル UI に切り替えられるか」という
> 問いから出発し、調査の結果**独立した 2 つの課題**に分かれた。片方はモバイルと無関係にワークステーション
> 全体の問題なので、ドキュメントを分けている。
>
> 1. 🔴 **[`volume-memory-guard.md`](volume-memory-guard.md) — 先に入れるべき既存の欠陥**。
>    **`cache.setMaxCacheSize()` の呼び出しが frontend 全体で 0 件**＝cornerstone 既定の **3GB** のまま。
>    超過すると黙って evict し、最終的に `new Error("cacheSizeExceeded")`（`cache.js:379`）を投げるが、
>    frontend はこれを識別せず **`MPR の構築に失敗しました: Error: cacheSizeExceeded` という生文字列**を
>    出している（`mpr/MprScreen.tsx:174`）。事前予測も `MAX_3D_TEXTURE_SIZE` チェックも無い。
>    - 実消費は volume 1 本分ではない: **CT ガントリチルト補正で ×2**（`viewer/mpr.ts:129` の自前
>      `Int16Array` ＋ `volumeLoader.createLocalVolume` でもう 1 本）、**3D はさらに +1**
>      （`viewer/vtkVolumeView.ts:170-183` が vtk 用にフルコピー）。しかも**自前確保と vtk コピーは
>      cornerstone の会計に載らない**（volume cache は `sizeInBytes: 0` 固定＝`cache.js:543`）。
>    - 🚨 **bytes/voxel は BitsAllocated だけでは決まらない**。RescaleSlope が非整数だと cornerstone が
>      `Float32Array`（4B）に切り替えるため **PET で 2 倍見誤る**
>      （`generateVolumePropsFromImageIds.js:43-80`）。`/layout` DTO にこの材料が無いので
>      `SeriesLayout` record に 5 フィールド追加が必要（書き込み箇所は既存ループ 2 箇所だけ）。
>    - **RAM と VRAM は代替関係ではない**（VRAM は RAM の退避先ではない）。両方を別々に消費し、
>      CPU RAM 超過＝スワップ/タブ kill、VRAM 超過＝WebGL コンテキストロスと**別々に落ちる**。
>      ブラウザから VRAM 容量を知る API は存在しないため、**必要量を計算して突き合わせる**設計にした。
>    - `System＞メモリモニタ` は**何も測っていない**（`system/memoryMonitor.ts:13-28` は OS ツールを
>      spawn するだけ）。流用できる計測資産はゼロで、物理メモリ取得には Electron IPC 追加が必要。
> 2. 🟡 **[`mobile-ui-design.md`](mobile-ui-design.md) — モバイル専用シェルの追加**（既存 UI の
>    レスポンシブ化ではない）。`frontend/src` に `.css` が 1 つも無く inline style **726 箇所**・
>    `@media` **0 件**なので、共有スタイルの上書きで対応する余地が無い。
>    - 対応範囲（合意済み）: 2D / 3D / MPR は**参照のみ**、ROI 計測は **2D と 3D のみ**（MPR は
>      計測ツールが 1 つも登録されていないため対象外＝`viewer/mpr.ts:299-313`）、Fusion は **2D のみ**、
>      レポートあり。**Slicer / 新規シリーズ作成 / マスク作成 / Analysis / プラグインは非対応**。
>    - 除外はすべて依存が絡んでおらず容易（`viewer/slicer.ts` の import 元は 2 ファイルのみ、
>      プラグインは注入点 2 箇所かつ遅延ロード）。⚠️ ただし `viewer/histogram.ts` は W/L 調整
>      ダイアログも使うので**モジュール自体は残す**。
>    - 追い風: **W/L・Pan・Zoom は既にラジオ式ボタンとして実装済み**
>      （`viewer2d/Viewer2DToolbar.tsx:153-155`）、スライス送りもスライダーがある。
>      ⚠️ 一方 **`numTouchPoints` の使用は 0 件**でタッチバインドは全面的に未実装。
>    - 🚨 **web モードのレポート確定は現状 2 つの理由で破綻している**（`report-design.md:256` に既知）。
>      **キー画像ありは 409**（`ReportService.java:189-194` がローカル H2 索引を引く）＋
>      **SR/KO が PACS に届かない**（STOW-RS 未使用）。**STOW-RS を足すだけでは 409 は直らない**＝
>      独立した 2 変更が必要。→ 両方実装する方針で合意。
>    - `frontend/portable/` は土台にしない（ビルド時 CSP に `connect-src` が無くサーバへ繋がない
>      設計＝`vite.portable.config.ts:26-47`）。
>
> **副産物: doc がコードに追随していない箇所を是正した**。MPR / 3D は**既に web モード対応済み**なのに
> `mpr-viewer-design.md:166` / `3d-viewer-design.md:55,537` / 本ファイル §4 項目 4 が「standalone のみ」の
> ままだった（`mpr/MprScreen.tsx:109-110` と `viewer3d/Viewer3DScreen.tsx:179-180` にコード側の
> 「web も対応」コメントがある）。各所に日付付きの更新注記を入れた。**未使用の `Phase` 型
> `"unsupported"` 4 箇所と i18n `*.webUnsupported` 4 キーはデッドコード**として整理対象に挙げてある。
>
> 🟢 **2026-07-30 非画像 SOP クラスを画像として開かせないようにした**（既存の欠陥の修正）。
> RTSTRUCT / SR / 表示状態 / Encapsulated PDF 等は**ピクセルを持たない**ため、シリーズ一覧から開くと
> Cornerstone の `createImage` が `The pixel data is missing` で reject し、**コンソールに未処理例外が
> 出るだけでユーザーには何も起きていないように見えていた**（実機の RTSTRUCT で発生）。
> - 判定は新規の純関数 `frontend/src/viewer/seriesRenderable.ts`（＋テスト）。
>   **SOP クラス優先・無ければ Modality** で判定する（web の QIDO はシリーズ階層に SOP クラスが無い）。
>   Modality だけでは足りない例がある: **Surface Segmentation(66.5) は Modality=SEG だがピクセル無し**、
>   一方 DICOM SEG(66.4) は labelmap を持つので開ける。未知は**開ける扱い**（fail-open）。
> - backend: `SeriesDto` に `sopClassUid` を追加（`findSeriesSummaries` で代表インスタンスの SOP クラス）。
> - 適用箇所は 2 つ: MainScreen のインライン プレビュー（説明を出してビューアを出さない）と
>   2D Viewer の左ツリー ＋（タイルにせずトーストで理由を出す）。i18n は ja/en。
> - 実機検証 `automator/src/spike/nonImageSeriesCheck.ts`（8 項目合格）。**`pixel data is missing` が
>   コンソールに出ないこと**まで確認。RTSTRUCT の DICOM はリポジトリに置けないため、
>   `GRAPHY_NONIMAGE_FILE` か `fixtures/rtstruct-seg-existing/` が無ければ該当項目を skip する。
> - 副産物: **`DicomStorageService.java` に生の NUL バイトが 1 個入っていて grep/rg がこのファイルを
>   バイナリ扱いし、検索から丸ごと漏れていた**（`listSeries` が見つからず調査が空振りした）。
>   `"\0"` エスケープへ直した（値は同一）。
>
> 🟢 **2026-07-29〜30 プラグイン host API 拡張: H1〜H4b すべて実装（§7 完了）**
> → 設計・実装表・素案から変えた点は
> [`fw/plugin-architecture.md` §7](plugin-architecture.md#7-host-api-の拡張h1h4b-実装済み)
>
> これまで 2D ビューアのプラグインには「いま何を見ているか」を答える手段が**一つも無かった**
> （host は `{ surface, pluginId, t, notify, runBackend, actions }` のみ＝全部 `void` を返す命令で、
> 問い合わせがゼロ）。**H1〜H4a** を追加し、画像処理プラグインが「読む→計算する→見せる」まで
> 公式契約だけで書ける状態にした。
>
> - `getTargets()` … 対象タイル（選択→無ければ全＝`actions` と同じ対象）の
>   `{ tileId, studyUid, seriesUid, seriesLabel, imageId, sliceIndex, sliceCount, c, t, modality }`。
> - `getViewState(tileId?)` … `{ windowCenter, windowWidth, unit, colormap, invert, flipH, flipV, rotation, zoom, pan }`。
>   **W/L はモダリティ値空間（CT なら HU）**、`unit` は `imageInfo.calibratedUnit()` に一本化。
> - **どちらも「呼ぶたびに現在値を読む関数」**。起票時の素案は `targets` を配列プロパティにしていたが、
>   host はクリック時に 1 度組まれるのに対しプラグインのダイアログは残るため、
>   スナップショットを配ると**スライスを送った後に黙って古い値を指す**。同じ理由で素案の `camera` も
>   本体の `ViewTransform`（Fit=1.0 の zoom/pan/rotation/flip）に置き換えた。
> - **H3 `getPixelData(tileId?, {sliceIndex?})`**（2026-07-30）… `{ imageId, sliceIndex, rows, cols,
>   data: Float32Array, unit, spacing }`。**読み出しは `pixelCalibration.readModalitySlice()` に委譲**
>   （校正の単一入口。直接 slope/intercept は preScale と二重適用で CT が約 −1024 ずれる）。
>   **1 回 1 スライス**（範囲指定は入れない＝512×512×500 で 500MB 超を安易に書けてしまう）、
>   **範囲外 index は null**（末尾へ丸めない。`viewportRead.resolveSliceIndex()` に切り出してテスト）。
>   `read-pixels` の**実強制はしない**（プラグインは既に本体と同じ権限で動き信頼境界が変わらないため。
>   宣言だけの偽の強制は P3 サンドボックスがあるかのような誤解を生む）。`permissions` に宣言する運用。
> - **H4a `showOverlay(tileId?, overlay)` / `clearOverlay(tileId?)`**（2026-07-30）… 処理結果を
>   表示中スライスに重ねて見せる（**保存はしない**）。**プラグインは値マップを渡すだけで、色付け
>   （window / LUT / 不透明度）は本体がする**（RGBA を組ませると W/L・LUT・透明度の扱いがばらつき、
>   本体の LUT 資産 106 種も使えない）。`NaN` は透明＝マスクをそのまま渡せる。**格子が現在スライスと
>   不一致なら拒否**（勝手に伸縮すると座標の意味が壊れる）。**出したスライスに `imageId` で紐付き**、
>   他スライスでは隠れ、シリーズ / C・T 切替で破棄（送った先に他スライスの結果が重なるのを構造で防ぐ）。
>   **出所ラベル（`プラグイン: <表示名>`）を本体が必ず出す**（文字列はプラグインに触らせない）。
>   純ロジックは `viewer/overlayRaster.ts`＋テスト。Fusion の `renderOverlay` 経路とは独立。
> - **H4b `saveDerivedSeries(tileId?, req)`**（2026-07-30）… 処理結果を派生シリーズとして保存
>   （standalone は保管庫、web は PACS へ STOW-RS）。方針は相談のうえ確定し、そのまま実装:
>   ①**本体が必ず確認ダイアログ**（抑止不可・`PluginSaveConfirmDialog`。`window.confirm` は
>   Electron でフォーカスを奪い自動検証からも操作できないため使わない）
>   ②出所は**機械可読＋`SeriesDescription` の `[Plugin] ` 接頭辞**（`DerivationDescription` と
>   `ContributingEquipmentSequence` に id・版。規則は `DerivedSeriesDescriptionTest` で固定）
>   ③**web も許可**（既存の STOW-RS 分岐に乗る。**ただし実 PACS での検証は未**）
>   ④画素は Float32→Int16 ＋ **自動 slope/intercept**（`viewer/derivedSeriesEncode.ts`＋テスト。
>   **HU のような整数は恒等**で量子化誤差を足さず、確率マップ 0〜1 は値域を Int16 全域へ写像）。
>   **`NaN`（データ無し）は `background` の明示が必須**（未指定は同意を求める前に拒否。指定値は
>   `PixelPaddingValue` にも書く）＝**2026-07-30 の人手テストで直した箇所**。当初「有効値の最小値」を
>   既定にしていたため、≧300 HU の閾値マスクで**背景が 300 HU**（何も無い場所が骨と同程度）になっていた。
>   併せて、プラグイン出力の `ImageType` から `RESLICE` を外した（マスクにリスライスと書かない）。
>   **幾何はプラグインに書かせない**（`frames` は `sliceIndex` だけ申告し、IPP/IOP/PixelSpacing/厚みは
>   本体が元シリーズから引き継ぐ。座標を組ませると実空間の意味が壊れた派生シリーズを作れてしまう）。
>   **検証は同意より先**（`validateDerivedSeries` を分離＝通らない要求で確認を見せない）。
>   土台は既存の `POST /api/series/derived`＝backend は任意フィールド（`rescale*` / `producer`）追加のみで、
>   Slicer / Curved MPR の既存呼び出しは無変更。
> - 新規 `frontend/src/viewer/viewportRead.ts` に読み取り専用ヘルパを切り出し、
>   automator 用 `debugApi.ts`（DEV ガード）と共用。純ロジックは `viewportRead.test.ts`。
> - フロント面のみで完結＝**web モードでも同じ**（`/api/plugins` の契約は不変）。backend 変更なし。
>
> ✅ **H4b の web モード（外部 PACS への STOW-RS 書き戻し）も検証済み（2026-07-30・18 項目合格）**:
> 実 dcm4chee を立てて確認した。**判定は UI ではなく PACS へ直接 QIDO / WADO-RS を投げて**行っている
> （`automator/src/spike/h4bWebStowCheck.ts`。手順と実施環境は `deploy/dcm4chee/VERIFY-web.md` §③-2）。
> 保存先の表示が「接続中の PACS（STOW-RS で書き戻し）」に切り替わること、拒否時に PACS へ増えないこと、
> 承諾すると `[Plugin] Bone mask` が PACS に出現し `ImageType=DERIVED\SECONDARY`・
> `DerivationDescription` のプラグイン id・`PixelPaddingValue=-1000`・Rescale 恒等が残ること、
> **元シリーズが無変更**であることを確認。**これで §7 の H1〜H4b は実装・検証とも完了**。
> ✅ **外部デモ 4 リポジトリの追従は PR 済み（2026-07-30）**: 各リポジトリの `feat/host-api-0.1.9`
> ブランチで PR #1 を作成（[demos](https://github.com/tatsunidas/graphy-next-plugin-demos/pull/1) /
> [hello](https://github.com/tatsunidas/graphy-next-plugin-hello/pull/1) /
> [mean-filter](https://github.com/tatsunidas/graphy-next-plugin-mean-filter/pull/1) /
> [gemini-findings](https://github.com/tatsunidas/graphy-next-plugin-gemini-findings/pull/1)）。
> 4 本すべてで `graphy-plugin.d.ts` を本体の `examples/plugin-template/` に同期し、
> **mean-filter は DOM＋キャンバス 8bit をやめて HU に対する定量フィルタへ**（＋重ね・保存ボタン）、
> **gemini-findings は DOM 走査をやめ、送信画像を「画素＋W/L で自前レンダ」へ**
> （視覚モデル相手なので W/L は意図的に掛ける。注釈は含まれない旨を明記）。
> どちらも `engines.graphy` を `">=0.1.9"`・版 0.2.0。**「8bit しか読めない / DOM 依存」の断り書きは撤回済み**。
> 🔴 **残: これらデモの実機確認**（構文チェックのみ。0.1.9 リリース後に手置きして動作を見る）。
> ✅ **実機検証済み（2026-07-30・standalone/Linux・H1〜H4b の 73 項目すべて合格）**: 本物の Electron ＋
> backend ＋ `plugins/` に置いた第三者プラグイン（`/api/plugins` 配信）で、**DOM を覗かずに**
> シリーズ/スライス/W/L/**画素**が取れること、画面表示と値が一致すること、スライス送り・W/L プリセット・
> 階調反転・LUT に**追従する**こと、**W/L を変えても画素値は不変**（＝表示 8bit ではない）ことを確認。
> 画素は 512×512・HU・`spacing=[0.644531, 0.644531, 5]`、腹部中央が **−21 HU（軟部組織）＝
> Rescale の二重適用なし**。ドライバ `automator/src/spike/hostApiCheck.ts`
> （検証用プラグインの原本は `automator/plugins/hostapi-check/`）。詳細は設計 §7 の「実機検証」。
> この検証で見つけて直した 3 点: ①`colormap` が内部登録名 `graphy-lut-10_Percent` を漏らしていた
> → ユーザーが選んだ LUT 名（`10_Percent`）を返す。②automator の `DesktopDriver` が
> **DevTools ウィンドウをメイン画面と誤認**していた（url が about:blank の間に predicate を外し、
> timeout → `firstWindow()` が `devtools://…` を返す）→ 現存ウィンドウを url でポーリングする方式へ。
> ③検証側の誤り: `min` が空気（−1000）でなく **GE の画素パディング（−3024＝raw −2000 ＋ intercept
> −1024）**になるため、二重適用の判定は**軟部組織の値**で行うようにした。
> ④保存（H4b）は **UI 越しでなく backend の一覧・タグダンプで確認**: 拒否→シリーズは作られない、
> 承諾→保管庫に 1 本増え `[Plugin] Bone mask` / `ImageType=DERIVED` / `DerivationDescription` に
> `hostapi-save` / `ContributingEquipmentSequence` あり / 整数マスクなので Rescale 恒等 /
> `RescaleType=HU` / Modality は CT のまま / **元シリーズは無変更**。
> ⑤**H4b の背景が閾値の値に化けていたバグ**（人手テストで発見・自動検証では気付けなかった）:
> 保存したマスクの画素が `[300\300\300…]`。**自動検証は「保存できたか・出所が残るか」を見ていたが、
> 「背景が意味のある値か」を見ていなかった**。回帰テストを追加済み。
> ⑥**H4a のオーバーレイが空だったバグ**: キャンバスは `imageRect` 確定後のレンダで初めてマウントされる
> ため、`useRef` だと描画 effect が先に走って ref が null・deps も変わらず、**空のキャンバスが乗ったまま**
> になっていた（`300×150`・α>0 が 0 個）。callback ref（state）へ変更。**「要素が見えている」検証では
> 気付けず、キャンバスの中身（α>0 の画素数がマスク該当数と一致するか）を読んで初めて分かった**。
>
> ✅ **実在する重いプラグインでの通し確認も済（2026-07-30・23 項目すべて合格）**: 上の `hostapi-check` は
> host API の**契約**を極小プラグインで網羅する検証だった。それとは別に、**外部の重いプラグイン 1 本を
> 最初から最後まで動かして契約が実用に耐えるか**を見るスパイクを足した
> （ドライバ `automator/src/spike/aneurysmPluginCheck.ts`。検体は社内の CADe プラグイン
> "Aneurysm Detector"＝**本体リポジトリ外の private リポジトリ**
> `tatsunidas/graphy-next-plugin-aneurysm-detector`。公開データ AneuriskWeb C0005 /
> 3D-RA 256³ を使用）。契約の網羅では出てこない次の 3 点が確かめられた。
> ①**`getPixelData()` の「1 回 1 スライス」設計がシリーズ全体の読み出しに耐える**
> — 256 枚を 1 枚ずつ読んで積み直したボリュームが取り込んだ枚数・spacing と一致
> （**H3 で範囲指定を入れなかった判断が実用上も妥当**だったことの裏付け）。
> ②レンダラの Worker で **100 秒の計算**を回しても本体の UI が壊れない。
> ③`showOverlay()` が読影に使える（候補のスライスへ送ってから重ね、**画が実際に変わる**ことまで確認）。
> **この回で見つかった不具合はプラグイン側の 1 件のみで、本体側は出ていない**
> ＝ H1〜H4a の契約は実用に耐える、というのが結論。
> スパイクは引数必須（`--plugin` / `--dicom` / `--truth=x,y,z`）なので、**検体を差し替えれば
> そのまま「重いプラグインの通し確認」として使い回せる**。
>
> 🟢 **2026-07-29 プラグイン デモ リポジトリ 4 本を新設**（`fw/plugin-explainer.md` §6）。
> 第三者がプラグインを書き始められるようにするため、**GRAPHY-Next の外に**独立リポジトリとして作成
> （本体には DICOM ワークステーションのみを置く方針のため）。
> ハブ [`graphy-next-plugin-demos`](https://github.com/tatsunidas/graphy-next-plugin-demos)（実質の開発ガイド）
> ＋作例 3 本: [hello](https://github.com/tatsunidas/graphy-next-plugin-hello)（最小形・UI のみ）／
> [mean-filter](https://github.com/tatsunidas/graphy-next-plugin-mean-filter)（表示中シリーズへの画素処理・UI のみ）／
> [gemini-findings](https://github.com/tatsunidas/graphy-next-plugin-gemini-findings)（**JAR から外部 API**・
> 所見推敲の教育用サンプル）。各 README は**単体で完結**（重複は意図的）。
> GRAPHY Lab（`vis-ionary-web`）の「プラグインを作る」節から辿れる。
> **この作業で判明した本体側の課題**（`plugin-explainer.md` §7 に追記済み）:
> ①`viewer2d.*` の host が痩せていて**表示中シリーズの UID も生ピクセルも取れない**
> （デモは `data-tile-id` 属性とキャンバス読み取りで代替＝DOM 依存で壊れやすい）。
> ②本番 CSP の `connect-src` が localhost 限定のため **`ui.js` から外部 API を叩けず**、
> UI だけで済むはずの機能まで JAR 同梱＝standalone 限定になる。
> 画像処理系プラグインを本気で書けるようにするなら、①の host API 拡張が先。
>
> 🟢 **2026-07-29 ユーザーマニュアル（mkdocs / GitHub Pages）を追加**（`fw/user-manual-site.md`）。
> 公開先 <https://tatsunidas.github.io/GRAPHY-Next/>。classic（`tatsunidas/GRAPHY`）と同じ構成
> （リポジトリ内 `docs/` ＋ Pages）。**製品サイト本体（`graphy.vis-ionary.com`）は別リポジトリ
> `tatsunidas/vis-ionary-web` の `graphy-site/` にあり、このリポジトリには置かない**。マニュアルだけが
> 例外で、本文が実装と同じ PR で更新できることを優先した。現状は `index.md`（概要・2 モード・機能・
> 動作環境）と `install.md`（デスクトップ / Web の導入手順）が書けていて、残り 8 章は見出しのみの
> 「作成中」。**マージ後に一度だけ 設定 ＞ Pages ＞ Source を「GitHub Actions」にする必要がある**
> （でないと deploy ジョブが失敗する）。`mkdocs build --strict` が CI（`.github/workflows/docs.yml`）で
> 走り、PR ではビルド検証のみ・`main` push で公開。
>
> ✅ **2026-07-10（実 dcm4chee 結合検証 完了）**: `deploy/dcm4chee/VERIFY-web.md` の手順で実機検証済み。
> ①2D表示 ②prefetch一括取得 ③STOW-RS書き戻し（派生シリーズ・SEG/RTSTRUCTのエクスポート表示）④IHE IID起動。
> **web モードは実 PACS 相手に一通り動作することを確認**。**唯一未確認のまま残っている項目**: SEG/RTSTRUCT
> の per-frame 参照・幾何整合の目視確認（エクスポートされたシリーズが PACS に現れることは確認済みだが、
> フレームごとの参照・幾何整合そのものは未確認）。詳細は `deploy/dcm4chee/VERIFY-web.md` を参照。
>
> ✅ **2026-07-28 更新通知メールをデモ機で有効化・実機適用 完了**（`fw/update-notification-design.md`）。
> `.env` に `GRAPHY_AUTH_ANNOUNCE_API_KEY` を追加＋dev側 `~/.config/graphy/announce-api-key` に同値配置、
> `graphy-backend`/`mailer` を新イメージで再ビルド・起動、登録者を別ボリューム `graphy_subscriber_data`
> （`jdbc:h2:./subscribers/graphy-subscribers`）へ分離、移行スクリプト実行済み（旧DB 0件）。疎通確認は
> 公開URL `POST /admin/announce` で 誤鍵→401 / 正鍵→202。次リリースから `auto-deploy.sh`（cron）が自動配信。
> 併せて修正した重大不具合: 夜間リセット（`deploy/demo/reset-demo.sh`）がお知らせメール登録者テーブルごと
> 巻き戻し、**日中の登録が毎晩0:00に全消去されていた**問題を、登録者DBの別ボリューム分離で解消（止血）。
> **SMTP送信上限は確定済み（2026-07-28）**: 送信は Gmail（Google Workspace・`smtp.gmail.com`）。日次
> 約2,000通/日が実質上限で、`GRAPHY_AUTH_ANNOUNCE_RATE_PER_MINUTE` は既定30/分のまま（明示設定なし）。
> **残（ブロッカーでない）**: プライバシーポリシー（`graphy-site/.../privacy.astro`）への利用目的記載確認。
>
> 🟢 **2026-07-23〜24 プラグインマネージャ（ImageJ の update site 相当）**（`fw/plugin-manager-design.md`）:
> P1 backend コア（PR#58・`plugin/manager/` 台帳/GitHub Release 取得/sha256/zip slip 対策/`engines` 互換/
> `/api/plugin-manager/*`）、P2 フロント UI（PR#59・環境設定＞プラグイン）、開発キット（PR#60・
> `graphy-plugin-api` jar＋`examples/plugin-template/`）まで main 済み。jar は Release に自動添付される
> （v0.1.8 に `graphy-plugin-api-0.1.8.jar` を確認）。
> **2026-07-28 追記**: v0.1.8 まで `graphy.plugins.manager-enabled` が既定 false のまま**どこでも true に
> されておらず**（standalone プロファイルでも desktop の spawn でも）、配布物ではプラグイン画面が
> 事実上「閲覧専用」で機能が死蔵していた。導入ゲートを 2 段に再設計して解消:
> ①`manager-enabled`＝**管理者ゲート（既定 true）**、②環境設定＞プラグインの
> **「プラグインの導入を許可する」トグル（設定キー `plugins.installEnabled`・既定 false）**＝ユーザーの
> 明示的オプトイン。署名検証は未実装（P2）のため②に警告文を添える。詳細は同設計 §5。
> **2026-07-28 追記2（盲目的な取り込みの是正）**: 入口ゲートを開けた後は任意のリリース zip を
> そのまま展開していたため、取得と展開の間に**検査＋同意**を挟む 2 段構成にした（設計 §5.1）。
> `POST /inspect/{github,file}` が展開せずに中身を返し（同梱 JAR・`ui.js`・宣言権限・
> **対応 OS の突き合わせ**・sha256）、同意画面で承諾したときだけ install する。要点:
> ①**`engines.os`（win32/darwin/linux）を新設**— 本体が OS 別リリースであり、プラグインも
> ネイティブを含めば OS 専用になるため、**展開前に実行中 OS と突き合わせて非対応なら拒否**（fail-closed）。
> ②同意画面で見せた zip の sha256 を `confirmedSha256` として install に渡し不一致なら拒否（TOCTOU）。
> ③`<zip>.sha256` 資産が無ければ既定で拒否（明示承諾時のみ許可）＋資産名照合を完全一致に厳格化
> （従来は無関係な `.sha256` を期待値にし得た）。
> **2026-07-28 追記3（minisign 署名・P2 完了）**: Ed25519 署名の検証を実装（設計 §5.2）。外部依存は
> 増やさず JDK 21 の `Signature("Ed25519")`＋自前 `Blake2b`（prehashed 署名用）。鍵の選択は
> ①本体の信頼鍵 `graphy.plugins.trusted-keys` → ②台帳に固定した前回の鍵（**TOFU**）→
> ③リリース同梱の `minisign.pub`（初回のみ）。**検証失敗・鍵 ID 不一致は無条件で拒否**。
> **操作性は変えていない**: ①②で通れば同意画面を出さずそのまま導入（`autoInstallable`）＝
> 公式配布と 2 回目以降の更新は「押すだけ」。同意画面が出るのは未署名・初回の第三者のみ。
> 暗号の正しさは**別実装の固定ベクタ**で担保（`Blake2bTest`＝openssl/RFC 7693、
> `MinisignTest`＝openssl 製 Ed25519 署名）。テンプレの release.yml に署名ステップを追加。
> ✅ 運用: **公式署名鍵を登録済み（2026-07-28・鍵 ID `98EA7C6BA2D50118`）**。`application.yml` の
> `graphy.plugins.trusted-keys` に公開鍵を置いた。この鍵で署名したプラグインは `verified` 扱いになり、
> 確認画面なしで導入される。**この鍵は「当社が自分で配布する公式プラグイン」専用**で、
> 第三者作者（＝配布者の大半）は自分の鍵を使う（当社の鍵は渡さない）。したがって
> secrets 登録（`MINISIGN_SECRET_KEY` / `MINISIGN_PASSWORD`）は**当社が公式プラグインを
> 配り始めるときに、当社所有のリポジトリで行う作業**であり、それまでは発生しない。
> 手順・保管・ローテーション・誰の鍵かの整理は `fw/plugin-signing-runbook.md`。
> 鍵は無期限に使えるが、**失うと既存利用者は更新できなくなる**（バックアップが本体）。
> **2026-07-28 追加修正**: 署名の剥がしを塞いだ。固定鍵があるのに `.minisig` が無い更新は
> `invalid` として拒否する（従来は `unsigned` 扱いで、同意さえすれば通ってしまい TOFU を
> 素通りできた）。
> **依然として守れないもの**: 未署名配布物の真正性、権限強制、実行時隔離（P3）。
> プラグインはアプリと同じ権限で動く。
> **残（P2）**: 公式索引 discovery／OAuth Device Flow／更新通知＋changelog／
> `examples/plugin-template/` の独立リポジトリ昇格。
>
> 🚨 **3D/MPR/リスライス/計測/座標変換を触るなら着手前に必ず `fw/cornerstone-3d-geometry-caveat.md` を読む**
> （Cornerstone3D の 3D ジオメトリはバグがあり、そのまま使うと実空間座標がずれる。確定計算は患者 LPS mm の自前・単一幾何で完結）。
>
> 🔵 **進行中（2026-07-01）の作業状況・次の一手は `fw/roi-mask-progress.md` を参照**
> （シリーズ Sync / リファレンスライン / 2D Viewer メニュー・ツールバー / ROI 計測・ブラシ / ROI マネージャ）。
> 関連設計: `viewer-2d-menu-toolbar.md` `roi-mask-model.md` `roi-manager-design.md` `series-sync-design.md`。
>
> 🟢 **2026-07 追加（GRAPHY 機能移植）**: Analysis>Histogram / Image>コントラスト調整(W/L) / View>Layout(任意 Row×Col) を実装。
> 併せて **HU 校正の二重適用バグ**を是正し `viewer/pixelCalibration.ts` に読取を一元化（再発防止）。
> 詳細: `viewer-2d-menu-toolbar.md` §9 ／ 校正は `viewer-2d-architecture.md`「校正(HU 等)の二重適用に注意」。
>
> 🟢 **2026-07-04 追加（DICOM 自局 AE 設定の UI 編集・standalone のみ）**: 環境設定「DICOM通信」＞「自局」の
> AET/SCP待受ポート/バインドアドレス欄を、backend の `DicomLocalAeService`（Settings(H2) 優先・無ければ
> application.yml 既定）に接続。AET は発信（C-ECHO/C-STORE/C-FIND/C-MOVE）に即時反映、SCP リスナー本体は
> 起動時バインドのためアプリ**再起動が必要**。変更検知で全ウィンドウに再起動促進バナー（`RestartRequiredNotice`,
> `restartRequiredEvents.ts`）を表示し、「今すぐ再起動」ボタンから Electron `graphy:relaunch` IPC で実際に
> 再起動できる（`desktop/main.js`/`preload.js`）。web モードは対象外（元々 backend 単一プロセスの
> application.yml 管理のまま）。
>
> 🟢 **2026-07-05 追加（GRAPHY 機能移植: ThickSlab＝デジタルスライス厚・2D Slice のみ）**: 本家
> `Praparat.computeThickSlabProcessor` を移植。現在スライス中心に法線 ±(厚み/2) を近傍ネイティブスライスから
> **Trilinear（面内格子共通のため Z 方向 1D 線形に縮退）でサブサンプル→平均合成（Average のみ・本家準拠。
> MIP/MinIP なし）**。On/Off＋厚み選択（0.1/0.3/0.5/1.0〜5.0mm）、実スライス間隔一致で Original。
> **Z モデルはデジタル再サンプル**（ON 時スライダー母数を `ceil(nZ/(厚み/間隔))` に）。合成は
> **`graphy-thickslab:` カスタム画像ローダ**で `StackViewport` にオンデマンド注入し、メタデータは中心
> ネイティブスライスへ委譲（ただし `modalityLutModule` を恒等化し **HU 二重適用を回避**＝`pixelCalibration`
> 単一入口）。W/L・カーソル HU・affine・ROI・スライス同期・参照線の既存 2D 経路を流用。**動画(MPEG)/単一
> スライス/カラーは無効**。**Zoom/Pan/Rotate は無効化せず、ROI・計測・ブラシ・Wand の作成/編集のみブロック**
> （合成は単一 SOP 非対応）。**ON 時の非デフォルト表示状態は維持**（`Viewer2D` が `setStack` 前に
> presentation+VOI を退避→同一シリーズ幾何 rows/cols/modality 一致時のみ再適用。C/T 切替の状態維持も副次改善）。
> **他モード波及ゼロ**（Slicer/CurvedMPR は既存 slab に委譲、MPR は対象外）。実装: `viewer/thickSlab.ts`(新規)/
> `cornerstoneSetup.ts`/`SeriesViewer.tsx`/`Viewer2D.tsx`/`i18n`。tsc・vite build 共に green、**standalone 実機
> 確認は未**（Float32 合成 StackViewport 描画・HU/W-L 一致・デジタル送り/同期/参照線の追従）。設計: `fw/thickslab-design.md`。
>
> 🟢 **2026-07-05 追加（web モードの 2D 画像表示を実装＝Phase 1）**: これまで「次フェーズ」で止まっていた
> web の 2D ビューアを、**ピクセル経路も BFF 一本**（fw/dicom-data-layer.md §5）で開通。backend
> `WebDicomDataService.retrieveInstance(study,series,sop)` が PACS の **WADO-RS**
> `GET .../instances/{sop}`（`multipart/related`）を叩き、**multipart を自前で剥がして Part-10** を返す
> （`firstMultipartPart`。dcm4che に mime パーサ依存が無いため自前実装）。エンドポイント
> `GET /api/studies/{study}/series/{series}/instances/{sop}/file`（`StudyController.instanceFile`、
> standalone はローカルファイル配信にフォールバック）。フロントは `imageIdForInstance(web,sop,study,series)`
> → `wadouri:` で同一オリジン取得（CORS 不要・標準圧縮 TS は WASM 復号）。`StudyList`/`Viewer2DScreen` が
> `SeriesViewer(mode="web")` を表示（standalone と同一 StackViewport 経路。ThickSlab も web で有効）。
> web QIDO instances は **InstanceNumber 昇順**にソート。**frontend tsc green。backend は JDK21 未導入の環境
> のためコンパイル未検証**（コードは記述済み・要 `mvn compile`）。**未対応（次段）**: web の ZCT レイアウト
> （現状 layout 空＝単一次元 Z）、MPR/3D/Slicer/Curved MPR の web、IID 起動（`?studyUID=`）、独自圧縮の
> サーバ側復号、web の ROI/Fusion。実 dcm4chee での動作確認は Docker 環境が要（本サンドボックスは非対応）。
>
> 🟢 **2026-07-05 追加（web Phase 2: ZCT レイアウト ＋ Phase 3: IHE IID 起動）**:
> **Phase 2**: `SeriesLayoutAssembler.fromAttributes(List<Attributes>)`（新規・純関数、standalone の classic
> 経路と同一ロジック＝Z 投影/C-T 判定を一致）を追加し、`StudyController.layout` の web 分岐が
> `WebDicomDataService.seriesMetadata`（WADO-RS `/metadata`）から 5D を導出。frontend の
> `imageIdForCell`/`imageIdForFrame`/`buildLayoutFromDto` は study/series を受けて web の wadouri を組む
> （モザイク/SEG の per-frame 展開は web 非対応＝classic 単一フレームのみ）。
> **Phase 3**: `iid.ts`（`?studyUID=...&seriesUID=...` 解釈）＋ `App` の IID 起動導線（web メインウィンドウで
> `graphy-viewer-ctx` に書いて `#2dviewer` へ遷移）＋ `/api/studies?studyInstanceUid=`（QIDO 直引き）。
> **frontend tsc・vite build green。backend は JDK21 未導入のため未コンパイル**（`SeriesLayoutAssembler`/
> `StudyController`/`WebDicomDataService` 記述済み、要 `mvn compile`）。**残り**: MPR/3D/Slicer/CurvedMPR の
> web、独自圧縮のサーバ側復号、web の ROI/Fusion。実 dcm4chee 動作確認は Docker 環境要。
>
> 🟢 **2026-07-06 追加（MPR/3D の web 対応 ＋ JRE 下限 21 ガード）**:
> **MPR/3D web**: `MprScreen`/`Viewer3DScreen` の web ゲート（`webUnsupported`）を撤去し、
> `imageIdForInstance(mode,sop,study,series)` で BFF wadouri を組むよう修正。`buildMprVolume` が
> cornerstone 経由で全スライスを BFF(WADO-RS) から読み込んで volume 化（standalone と同一経路。
> MPR=VolumeViewport、3D=pure vtk.js）。起動導線（MainScreen/Viewer2DScreen の `#mpr`/`#viewer3d`）は
> web の `window.open` フォールバックが既存で、ボタンも非 gating。backend 追加なし（Phase1 の instance-file＋
> Phase2 の layout で足りる）。⚠ 大シリーズは全スライス個別 WADO-RS 取得で遅い（将来: シリーズ一括取得）。
> **JRE 下限**: `Makefile` の `build-desktop` で jlink 直前に `$(JAVA_HOME)` の Java major を検査し、
> **21未満ならビルドを失敗**させる（Release 同梱JRE の下限を 21 に強制。backend jar は release=21 で 21未満の
> JRE では起動しないため先に検出）。Java バージョンは 21 のまま（下げない）。**frontend tsc green。backend は
> JDK21 未導入環境のため未コンパイル**。Slicer/CurvedMPR の web は次段。
>
> 🟢 **2026-07-06 追加（Slicer / Curved MPR の web 対応）**: `SlicerScreen`/`CurvedMprScreen` の web ゲートを
> 撤去し、`imageIdsForCT(...)` と fallback の `imageIdForInstance(...)` に study/series を通すよう修正
> （C/T 切替の `applyCT` 含む）。reslice 用 volume は cornerstone が全スライスを BFF から読み構築
> （standalone と同一。3面/参照/展開は自前 canvas）。backend 追加なし。これで **5 ビューモード全て（2D/MPR/
> 3D/Slicer/CurvedMPR）が web で表示可能**に。⚠ 派生シリーズ保存（STOW-RS）・独自圧縮のサーバ側復号・
> web の ROI/Fusion は次段。**frontend tsc・vite build green。実 dcm4chee 動作確認は Docker 環境要**。
>
> 🟢 **2026-07-06 追加（web 高速化=prefetch ＋ STOW-RS 書き戻し。書き戻しは★必須機能）**:
> **#2 一括取得**: `WebDicomDataService.prefetchSeries`（WADO-RS シリーズ `GET /studies/{s}/series/{se}` を 1
> リクエスト→multipart 全パートを sop→bytes キャッシュ、512MB 上限 LRU）＋ `POST .../prefetch`（StudyController）。
> frontend の MPR/3D/Slicer/CurvedMPR が volume 構築前に `prefetchSeries` を呼び、以降のスライス取得を
> キャッシュ即返しに（個別 WADO-RS 往復を回避）。`retrieveInstance` もキャッシュ優先。
> **#3 STOW-RS 書き戻し**（standalone=ローカル FS/H2、web=STOW の対称化）: `storeDatasets(List<Attributes>)`/
> `storeInstances(List<byte[]>)`（`POST {base}/studies`、multipart/related を `buildMultipartRelated` で自前組立）。
> **派生シリーズ**（`DerivedSeriesService`）・**DICOM SEG**（`SegExportService`）・**RTSTRUCT**
> （`RtStructExportService`）の 3 サービスを web 分岐（テンプレート＝WADO-RS `/metadata` 先頭、保存＝STOW。
> `ObjectProvider<WebDicomDataService>` 注入）。frontend の保存 POST はモード非依存で無変更。
> **frontend tsc・vite build green。backend も JDK21 で `mvn compile`／`mvn test` 成功（全 87 テスト green）。**
> multipart 組立↔解析の往復・prefetch→キャッシュ→retrieve→STOW をインプロセス・スタブ PACS で検証する
> `WebDicomTransferTest`（2 件）を追加。**実 dcm4chee 結合検証の手順は `deploy/dcm4chee/VERIFY-web.md`**
> （dcm4chee 起動→データ投入→web 起動→2D/prefetch/STOW/IID を確認。Docker 要）。
> ⚠ SEG/RTSTRUCT の web 書き戻しは per-frame 参照/幾何の実機目視が未。独自圧縮のサーバ側復号・web Fusion は次段。
>
> 🟢 **2026-07-12 追加（レポート依存修復 ＋ DbAdmin 画像削除 ＋ ビューア/検索UI の不具合修正）**: 実機（standalone/Linux）で確認。
> **① レポート依存**: `MarkdownEditor.tsx` の `react-markdown`/`remark-gfm` は `package.json`/lockfile 登録済みだが
> node_modules 未展開だった → `frontend && npm install`。配布は Maven `frontend-maven-plugin` が `npm install`→build
> するため漏れなし。
> **② ネイティブダイアログ後のキーボードフォーカス喪失（Electron/特に Linux GTK）**: `window.confirm/alert` の後、
> レンダラが OS キーボードフォーカスを失い入力欄に打てなくなる（DbAdmin 削除確認の後に検索欄へ入力不可で発覚。
> `document.hasFocus()=false`/activeElement は正常/オーバーレイ無し で確定）。対処: `desktop/main.js` に
> `graphy:refocus` IPC を追加し **blur→focus サイクル＋クローズ後の遅延リトライ**（`webContents.focus()` 単体では
> Linux で不足）。`preload.js` で `refocus()` 公開、`frontend/src/desktopNativeDialogFix.ts`（新規）が起動時に
> `window.confirm/alert/prompt` を一括ラップして呼ぶ（`main.tsx` で `installNativeDialogFocusFix()`。web は no-op）。
> 呼び出し側（数十箇所）は無改修で全ダイアログに適用。
> **③ DbAdmin 画像（インスタンス）削除**: `DELETE /api/instances/{study}/{series}/{sop}`（`DbAdminController`＋
> `DbAdminService.deleteInstance`＝既存 `deleteAll` 再利用で実ファイルも設定連動削除）。UI は Series 行に展開トグルを
> 追加し画像単位の削除（`dbAdminApi.deleteInstance`／i18n `dbadmin.delete.instanceConfirm`）。ツリーは
> Patient▸Study▸Series▸**Image** の4階層。※ Series 行のチェックボックスは削除ではなく**統合(merge)用**。
> **④ MOSAIC(fMRI) のフィット不良（極小・隅寄り）**: マルチフレーム（`/instances/{sop}/frames/N/file`）で `setStack`
> 内部のカメラが現フレーム実幾何と別幾何でフィットし `parallelScale` 過大・`focalPoint` ズレ。しかも誤差が
> ResizeObserver の暴走ガード(50倍)未満だと `setViewPresentation` 再適用で保持されリサイズでも直らない。対処:
> `Viewer2D.tsx` の `setStack` 直後に **`viewport.resetCamera()`**（現フレーム imageData で再フィット。保存ビュー
> 再適用時も resetCamera を土台にする＝ResizeObserver と同順序）。診断は dev 専用 `window.__graphyDebug.getViewportGeometry()`
> （`viewer/debugApi.ts` に追加。`import.meta.env.DEV` ガード）。
> **⑤ MOSAIC の生グリッド一瞬表示**: フォールバック `imageIdForInstance` は生インスタンス（＝モザイク全体）を描くため、
> レイアウト解決前に生グリッドが一瞬見えていた。対処: `SeriesViewer.tsx` で **`layoutReady`（`fetchSeriesLayout`
> 解決＝finally で true）まで Viewer2D をマウントしない**ゲート＋1秒安全タイムアウト。レイアウトはメタデータのみで
> 高速（rsfMRI 197inst/nZ48×nT197 で実測 ~45ms）なので通常シリーズも体感差ほぼ無し・退行なし。`instances` は
> useState 安定＋シリーズ変更で再マウントのため stuck しない。
> **⑥ 検索パネル Study Date 見切れ**: `SearchPanel.tsx` の日付入力2つ＋「〜」を、幅250pxパネルで横並びだと右が
> はみ出るため**縦積み（各フル幅）**に変更。
> **状態**: すべて `frontend tsc --noEmit` green、backend(②③) `mvn compile` green、実機動作確認済み。
> ②③はコミット未・ワーキングツリーのみ。②の main.js/preload.js と ③の backend は `make build` 同梱対象。

---

## 0. これは何か
**GRAPHY**（Java Swing の DICOM ワークステーション。別リポジトリ `../GRAPHY`）の **Web 化版**。
- **2 モード**: **standalone**（Electron + ローカル H2/FS）と **web**（ブラウザ + 外部 PACS via DICOMweb/BFF）。
- スタック: **Spring Boot 3.3.5 / Java 21 / Maven** + **React 18 / TypeScript / Vite 5** + **Electron 31**。
- 画像表示は **Cornerstone3D 3.33.x**（`@cornerstonejs/core` `/tools` `/dicom-image-loader` + `dicom-parser`）。
- ほとんどの新機能は **standalone(Electron) 前提**で実装。web 対応は機能ごとに後追い。

## 1. リポジトリ構成
```
GRAPHY-Next/
  backend/    Spring Boot（DICOM 保管庫=H2+FS、DIMSE、DICOMweb、REST）
  frontend/   React/TS/Vite（UI 全部）
  desktop/    Electron（main.js / preload.js / config.json）
  fw/         設計ドキュメント（重要。下記参照）
  scripts/    dev-desktop.sh など
```

### fw/ の各ドキュメント（必読）
- `development-phases.md` … 全体フェーズ計画
- `dicom-data-layer.md` … standalone=H2索引、web=DICOMweb/BFF の方針、保管庫4原則
- `ui-architecture.md` / `error-handling-logging.md` / `security.md` / `plugin-architecture.md` / `keyboard-shortcuts.md`
- `viewer-2d-architecture.md` … **2D ビューア（Cornerstone3D）の中核設計。最重要。**
- `viewer-2d-screen.md` … 2D Viewer **画面**（マルチスタディ・タイル）の要件・**スライス同期改善案**・段階プラン
- `mainscreen-tools.md` … MainScreen ツールバー/メニューの各機能の計画（Export/Anonymizer 等）
- `report-design.md` … レポート機能（Markdown執筆→DICOM-SR/KO、GRAPHY移植）。**R1〜R5実装済み**（2026-07-11時点、下記4節参照）。

## 2. ビルド / 実行 / テスト
- **frontend ビルド/型チェック**: `cd frontend && npm run build`（`tsc -b && vite build`）。
- **backend コンパイル**: `cd backend && mvn -q -o compile -Dfrontend.skip=true`
  （`-Dfrontend.skip=true` を付けないと frontend-maven-plugin が走る）。
- **backend テスト**: `cd backend && mvn -o test -Dfrontend.skip=true -Dtest='...'`。
  - 主要: `SeriesLayoutBuilderTest`（ZCT 8件）、`DicomStoreIntegrationTest`、`DicomStorageRollbackTest`、
    `DicomTagControllerTest`。全 green。
- **standalone 起動**: `bash scripts/dev-desktop.sh`（Vite を別プロセスグループで起動し、Electron が
  backend jar を spawn）。**必ず 1 つだけ起動**（複数 vite は `.vite` 競合の原因）。
- `mvn` は導入済み（3.6.3 / JDK 21）。
- **⚠️ `main.tsx` を変更したら Vite を完全再起動**（HMR では反映されない。例: StrictMode の有無）。
  `kill $(lsof -t -i :5173)` で停止 → 再起動。
- **React StrictMode は無効（`main.tsx`）**。理由: StrictMode の dev 二重マウント（mount→cleanup→remount）が
  Cornerstone3D（命令的 WebGL / 単一共有 RenderingEngine）と非互換で、同一 element への enableElement→setStack
  競合により**ビューポートのカメラ fit が暴走（parallelScale が ~200倍）→ 真っ黒/点表示・スケールバー異常**になる。
  本番は単一マウントなので影響なし。StrictMode を外し dev を本番挙動に揃えてある。**再導入しないこと**。

### ⚠️ Vite × Cornerstone3D の既知ハマり（`frontend/vite.config.ts` に対処済み・触る時は注意）
1. `worker.format = "es"`（デコードワーカが ES module + 動的 import）。
2. **codec の default export 問題**: `cornerstoneCodecEsm()` プラグインが `@cornerstonejs/codec-*` の
   UMD に `export default` を付与（dev のみ）。
3. **dicom-parser の zlib クラッシュ**: `optimizeDeps.include:["dicom-parser"]` 必須（UMD の `this`
   undefined → `e.zlib` で落ちるのを CJS interop で回避）。
4. dicom-image-loader 本体は `optimizeDeps.exclude`（worker のため）。`build.target:"esnext"`。
   → 症状別の対処は `viewer-2d-architecture.md` の「Vite 連携」節に表で記載。

## 3. 現在の到達点（実装済み）

### backend
- ローカル保管庫（H2 索引 + FS）、C-STORE 受信、C-ECHO/GET/MOVE/FIND（dcm4che CLI 連携）。
- **DICOM Send（C-STORE SCU）**: `DicomStoreScu.storeAll`（単一アソシエーションでスタディ一括送信）＋
  `DicomSendService` ＋ `POST /api/dicom/send` / `GET /api/dicom/remote-aes`。詳細は `fw/mainscreen-tools.md`。
- **Query/Retrieve ウィンドウ**: 常駐別ウィンドウ（`#qr`）。Destination タブ・共有検索(Today既定)・AutoRefresh・
  保存済み判定・**Retrieve は C-MOVE**（standalone=自局SCP取込 / web=dcm4chee宛・QIDO判定）。`qr/DimseQrService`
  拡張＋`qr/QrRetrieveService`＋`/api/dicom/qr/*`、frontend `src/qr/`。設計・検証は **`fw/qr-window.md`**。
- **自局 AE 設定（DicomLocalAeService）**: 自局 AET / SCP待受ポート / バインドアドレスの実効値を解決
  （`DicomTlsService` と同パターン: Settings(H2) 保存があれば application.yml 既定より優先）。
  `DicomController`/`DicomScpLifecycle`/`DimseQrService`/`QrRetrieveService` が参照。環境設定 UI（standalone
  のみ）から編集可能。AET は発信に即時反映、SCP リスナーは再起動後反映（再起動促進バナーあり、下記 frontend 参照）。
- **TagExtractor（GRAPHY 移植）**: タグ/シーケンス(パス編集)/Private を指定し検索リスト全体をシリーズ単位で
  抽出→テーブル→CSV。`extract/TagExtractService.extractTable`＋`/api/extract/table|csv`、
  `/api/dicom/tags`（辞書）、`web/WebDicomDataService.seriesMetadata`（WADO-RS）。frontend
  `mainscreen/TagExtractorDialog`＋`NestedTagBuilder`＋`tagPathUtil`。詳細 `fw/mainscreen-tools.md`。
- **SeriesExtractor（GRAPHY 移植）**: タグ条件(Include/Exclude・=,含む,≥,≤,範囲・SQ/Private)＋平面(AX/SAG/COR)で
  一致シリーズを検証→standalone はフォルダコピー(連番+mapping.csv)、web は ZIP(WADO 取得は未対応)。
  `seriesextract/SeriesConditionEvaluator`/`SeriesExtractService`＋`/api/series-extract/verify|copy|zip`、
  desktop `pickDirectory` IPC。frontend `mainscreen/SeriesExtractorDialog`。詳細 `fw/mainscreen-tools.md`。
- **Anonymizer（GRAPHY 移植・PS3.15）**: Basic Confidentiality Profile（X/Z/D/K/C/U・各オプション・UID一貫・
  safe-private・SR clean・method tagging・新PatientID）＋Pixel 焼き込み(矩形)。検索リスト全体→ZIP/フォルダ(standalone)。
  `anonymize/*`＋`/api/anonymizer/*`、CSV辞書は `resources/dicom_dict/`。frontend `mainscreen/AnonymizerDialog`。
  **焼き込みの viewer『焼き込みに使用』ボタンは保留**（マスクAPI完成・viewer競合回避）。詳細 `fw/mainscreen-tools.md`。
- REST: `/api/studies`（検索: patientId/Name 部分一致, 日付範囲, modality複数, accession）、`/series`、
  `/instances`、`/instances/{sop}/file`（standalone の画像配信=wadouri 用）、
  `/studies/{study}/series/{series}/layout`（**5D ZCT 導出**）、`/dicom/tag`（タグ→keyword/VR）、
  `/import/paths`、`/settings`。
- 5D ZCT 導出 = `SeriesLayoutBuilder`（純アルゴリズム・単体テスト済10件）+ `DicomStorageService.seriesLayout`（ヘッダのみ読取）。
  - **次元の意味づけ**: **Z**=空間スライス（IPP·法線）。**T(時間)**=繰り返し/経時 = `TemporalPositionIdentifier/Index`・
    `TriggerTime`・**`AcquisitionNumber`**（＝一定時間の連続データ収集＝本質的に時間軸。造影フェーズ/fMRI 繰り返し等）。
    **C(チャンネル)**=同一位置・同一時相で「見ているものが違う」= `EchoNumbers`・`DiffusionBValue`・`EchoTime`・
    `ComplexImageComponent`(MAGNITUDE/PHASE/REAL/IMAGINARY→"Complex" 数値コード)。`T_TAGS`/`C_TAGS` 参照。
  - **Siemens MOSAIC 対応（GRAPHY Praparat 準拠 / Cornerstone は非対応なので自前デモザイク）**:
    `DicomStorageService.mosaicLayoutIfApplicable` が `ImageType` に MOSAIC を含むシリーズを検出。
    **判定は ImageType に MOSAIC があることが必須**（`NumberOfImagesInMosaic(0019,100a)` 私的タグの
    有無だけでは発火しない）。localizer 等が当該私的タグを持つ／creator ブロック走査が誤検出する場合の
    誤デモザイク（例: 位置決め 5 枚が Z=53×T=5 と誤認）を防ぐ。frame 配信(`frameDicom`)の分岐も同条件。
    N=`NumberOfImagesInMosaic(0019,100a)`、grid=ceil(√N)、tile=Cols/grid×Rows/grid。
    **各モザイク=1時相、N タイル=Z スライス → Z×T 4D**（nC=1, tDim=Temporal）。
    per-tile IPP = mosaicIPP + index·spacing·normal。タイル配信は `mosaicTileDicom`＋
    エンドポイント `GET /instances/{sop}/frames/{frame}/file`（タイルを切り出して単一フレーム DICOM で返す。
    **非圧縮 TS のみ**）。frontend は `Cell.frame>=0` のとき `imageIdForFrame`→`/frames/{k}/file` を wadouri で読む。
    既存の Cornerstone 描画経路は不変。※タイル毎に親モザイクを再パースするため巨大シリーズは将来キャッシュ検討。
  - **グローバルキー判別**（`globalDimKey`）: 上記タグ分割（全位置で同一値集合が必要）に加え、
    **値→index のグローバル写像**で割当（GRAPHY の SeriesInstanceUID 多次元写像と同発想）。**非均一**
    （端スライスが片方の収集のみ等の CT 多収集）にも対応。T 候補(`T_TAGS`)を先に試して T へ、次に C 候補(`C_TAGS`)を C へ。
    条件=全フレームに値あり・distinct≥2・各 Z 位置内で値重複なし。判別キーが無い非均一は純スタック
    （テスト `pureStack_whenGroupsUneven`）。例: 物理範囲の違う CT 2収集 → `Acq` で **T=2**（断面は Z で揃い、
    範囲外は frontend がブランク埋め）。magnitude/phase → `Complex` で **C=2**。

### frontend MainScreen
- スタディ検索（日付範囲・Today/Yesterday/1週間・モダリティ チェックグリッド・件数表示・50件ページング）。
- **メニュー**: File(Import/Export/**Send**/NonDicomImporter) / Function(Anonymizer/TagExtractor/SeriesExtractor) /
  Image(2D/3D/MPR/Slicer) / System(Settings/DB) / Help。
- **ツールバー**: 同上のツール群＋ビューア群。**2D Viewer のみ実装**、他は「近日対応予定」バナー。
- 環境設定（スキーマ駆動＋カスタムパネル: セキュリティ／**画像オーバーレイ**）。DB管理。i18n(ja/en)。
- **再起動促進バナー（`App.tsx` の `RestartRequiredNotice`）**: SCP リスナー起動時にしか反映されない設定
  （自局 AE の AET/ポート/バインドアドレス）を変更すると `restartRequiredEvents.ts` が全ウィンドウへ通知し、
  バナー表示。「今すぐ再起動」は `desktopBridge.ts` 経由で Electron `graphy:relaunch` を呼ぶ（standalone のみ、
  web は手動再起動を促す文言）。`DbChangeNotice` と同じ見た目パターン。

### frontend 2D ビューア（`frontend/src/viewer/`）— ほぼここが主戦場
- `Viewer2D.tsx`: Cornerstone StackViewport。`imageIds[]`+`imageIndex`。**単一 RenderingEngine 共有**。
  - 表示変換は **affine（ViewPresentation）**。Fit=1.0/中央、zoom/pan/flip/rotation/再Fit。
    flip は setViewPresentation がOFFにできないバグがあるため **setCamera で双方向**（`transform.ts`）。
  - 左ドラッグ=**W/L**(WindowLevelTool)、中=Pan、右=Zoom（ホイールはスライス送りに解放）。
  - **初期 Window 明示適用**: `setStack` 後に DICOM の WindowCenter/Width を `setProperties({voiRange})` で適用
    （CT は自動 VOI が生16bit パディング(-2048 等)に引っ張られ真っ黒になりやすいため）。
  - **カメラ暴走の自己修復**: `onCameraModified` で parallelScale が画像フィット規模の 50倍超を検知したら
    `resetCamera`+再描画で復帰（再入ガード＋最大3回）。スライス切替例外時も `resetCamera`+render フォールバック。
  - **リサイズ追従**: 共有エンジンの自動再フィット(`engine.resize(true,false)`)は誤フィットするため、
    `engine.resize(true,true)`(canvas のみ)＋viewport 単位 `resetCamera`＋妥当性ガードで処理。実サイズ変化時のみ。
  - 輝度キャリブレーション（Modality LUT/VOI は Cornerstone が GPU 自動適用）。カーソル値は
    **OffScreen 座標で逆変換**して取得（`canvasToWorld`→`transformWorldToIndexContinuous`）。
    signed/unsigned・8/16bit・カラーRGB 対応。値は RescaleType(0028,1054) の単位を併記。
  - 右パネル(`ImageInfoPanel`)＝ボクセルサイズ/FOV/Rescale/Window 等。**Info ボタンで On/Off**（Off で画像拡張）。
  - 画像上: **DICOM テキスト4隅**（設定可能, `overlayConfig`/`overlayText`/`OverlayConfigPanel`）、
    **患者の向き A/P/R/L/H/F**（`orientation.ts`）、**スケールバー(Caliper)**（`scaleBar.ts`, 校正有=黄/mm, 無=灰/px）。
  - 画像外の上部ラベル: Zoom% / W/L / カーソル値 / OffScreen XY（必須情報・常時）。
  - **表示状態 Undo/Redo**（クライアント履歴。DICOM 不要）: Mod+Z / Mod+Shift+Z、ツールバーにボタン。
  - `compact`/`height`/`syncGroupId` props（グリッドセル用）。
- `SeriesViewer.tsx`: **シリーズ管理コントローラ**。Viewer2D を内包。
  - **5D(ZCT)**: backend layout を取得し C/T スライダー（次元>1で表示, DICOM由来併記）。
  - スライス送り: スライダー＋↑↓/Home/End キー＋ホイール。シネ(▶, **fps は環境設定 viewer.cineFps**)。
  - オーバーレイ On/Off（テキスト/キャリパー/向き/ROI[将来]）。
  - **GridView(FilmGrid)**: 列数指定で格子表示。Slider/Grid トグル＋列数セレクト(先頭=Slider)。
    Grid 中はスライダー非表示、スクロール可。各セルは compact Viewer2D。100枚超は確認ポップアップ。
    **マルチチャンネル(nC>1)/動画(Video SOP)/1枚 は無効化**。
  - **GridView リンク**: 共有ツールグループ＋camera/VOI Synchronizer（`sync.ts`）で W/L/Pan/Zoom/Rotate/Flip
    をシリーズ全体連動。
- 各種ショートカットは `shortcuts/registry.ts`。**実装済み機能のみ配線**（nav/disp(I/O)/undo/redo）。

### LUT（カラーマップ）機能（`frontend/src/viewer/LutDialog.tsx` / `Viewer2D.tsx`）
- `backend/src/main/resources/luts/` に GRAPHY の .lut ファイル 106 枚をコピー。
- **バックエンド**: `LutController.java`（`GET /api/luts`、`GET /api/luts/{name}`）+ `LutService.java`。
  - フォーマット自動判別: **ICOL**（32 バイトヘッダ + R/G/B 各 256 バイト）、**Raw バイナリ**（768 バイト）、
    **テキスト**（`index\tR\tG\tB` 4列 または `R\tG\tB` 3列、256 行）。
- **フロントエンド `api.ts`**: `LutData { name, r[], g[], b[] }` 型、`fetchLutNames()` / `fetchLutData(name)`。
- **`LutDialog.tsx`**: LUT 名＋カラーバー（256×1 canvas）並列リスト、IntersectionObserver で遅延ロード。
  グレースケールリセット行を先頭に常時表示。ダブルクリック即適用、Esc/バックドロップで閉じる。
  `ColorBar` コンポーネントは `export` 済み（FusionControlBar でも使用）。
- **`Viewer2D.tsx`**: ツールバーに「LUT」ボタン（適用中は青ハイライト）。右クリックコンテキストメニューは削除済み。
  `applyLut(lut | null)`: Cornerstone3D の `utilities.colormap.registerColormap` → `setProperties({colormap})` で適用。
- **ツールバー横スクロール化**: `overflow-x: auto`, `flex-wrap: nowrap`, ボタン `flex-shrink: 0`。

### Fusion（画像重畳合成）機能
#### DnD によるトリガー（`Viewer2DScreen.tsx`）
- `getDropZone`: タイル幅を左25%/右25%/中50% で分割。中央ドロップ → Fusion。
- シリーズ行（左ツリー）は既ロード済みでも draggable（以前は未ロードのみ）。
- タイルヘッダのドラッグも中央ドロップで Fusion トリガー（別タイル→Fusion）。
- ドロップ時の視覚フィードバック: 「Fusion オーバーレイ」ラベル付き青枠ハイライト。

#### FusionControlBar（`Viewer2DScreen.tsx`）
- Fusion 設定時にタイル下部に表示: `🔀 [シリーズ名] / 透過度スライダー / LUTボタン / ×`。
- **LUTボタン**: `LutDialog` を開き選択した LUT を Fusion オーバーレイに適用。選択中はカラーバーをプレビュー。
- 透過度スライダー（0–100%）、C/T スライダー（マルチチャンネル/時系列時）、× で Fusion 解除。

#### FusionImageViewer / FusionEngine（`FusionOverlayViewer.tsx` / `fusionEngine.ts`）
- **base 画像と同じ表示矩形に重畳（GRAPHY FusionDisplay 踏襲）**: オーバーレイは独立配置ではなく、
  **base の Viewer2D 内（`wrap`, overflow:hidden）に単一 `<canvas>` を描画**し、base 画像の表示矩形
  `rect` にぴったり重ねる。→ 原点一致・画像領域にクリップ・**zoom/pan/fit に追従**。
  - `rect` は `Viewer2D` が `getImageData().imageData.indexToWorld(画像四隅) → worldToCanvas` で算出し、
    `CAMERA_MODIFIED` ごとに更新（`renderOverlay` prop 経由で `{rect, imageId, index, count}` を供給）。
  - 配線: `Viewer2DScreen`(useMemo `renderFusionOverlay`) → `SeriesViewer.renderFusionOverlay`
    → `Viewer2D.renderOverlay` → `FusionImageViewer`。
- **空間 Fusion**: 前景・背景に IOP/IPP がある場合、`computeFusionSlice`（trilinear）で前景を
  **背景グリッド(bgCols×bgRows)に再構成**。canvas は CSS で `rect` に伸縮 → ピクセル単位で base に整合。
- **非空間フォールバック**: IOP/IPP が無い場合（CR/DX 等）は比例 Z（`baseIndex/baseCount`）で前景スライスを
  選び、`rect` にストレッチ。フォールバック Viewer2D は廃止 → **LUT が常に canvas 経由で効く**。
- **値0は透明（`toImageData`）**: 8bit 化で 0（窓下限以下＝背景）になった画素は alpha=0。
  GRAPHY の `ImageRoi.setZeroTransparent(true)` 相当。base が黒く暗転せず信号部のみ重畳。
- **LUT**: `toImageData(values, cols, rows, wc, ww, lut?)` の第 6 引数。`fusionLut` 変更で再描画（即反映）。
- **不透明度**: canvas の CSS `opacity`（再描画不要）。
- **注意**: `rect` は軸並行 BBox 算出のため base を**回転**させると厳密でない（fit/zoom/pan/flip は追従）。
  カラー(RGB)前景の非空間フォールバックは未対応。

#### Fusion 設定（`settings/registry.ts`）
- viewer カテゴリに「フュージョン」セクション追加:
  - `viewer.fusionOpacity` (number 0–100, 既定 50): DnD 起動時のデフォルト透明度（参照値として保存、現状は自動適用なし）。
  - `viewer.fusionLut` (text, 既定 ""): デフォルト LUT 名（同上）。
- i18n: `settings.sec.fusion` / `settings.field.fusionOpacity(.help)` / `settings.field.fusionLut(.help)` / `viewer2d.fusion.lut`。

#### Fusion FW（レジストレーション）
- ✅ **R1 手動位置合わせ（2026-08-08）**: Fusion コントロールバーに「⊹ 位置調整」を追加。
  実座標（mm・度）での平行移動・回転が即時プレビューされる。土台は
  `computeFusionSlice(fg, bg, xf?)` の第 3 引数（省略時は従来と同一挙動）。
  変換モデルは `frontend/src/viewer/regTransform.ts`（純関数・vitest 17 件）。
  🔴 **実機目視は未了**（特に平行移動の符号の向き）。手順は設計書 §10「R1 の実装」。
- 2D/3D **剛体（Rigid）位置合わせの自動最適化**（R3）: 未実装。
- 2D/3D **非剛体（Deformable）位置合わせ**（R4）: 未実装。
- 📐 **設計は [`fw/registration-design.md`](registration-design.md) が正本**（2026-08-08 起票）。
  対象は PET-CT / PET-MR の骨盤・心臓。**GPU 前提にせず CPU で完結**、心臓 PET-MR は
  シミュレーション（GNBP-3S）のみ。土台は `computeFusionSlice` に world→world 変換を
  1 つ挟むこと（同 §2）。フェーズは R1〜R8（同 §10）。
- ⚠️ 旧参照の `~/.claude/.../memory/project_fusion_fw.md` は**現在存在しない**
  （メモリディレクトリごと無い）。上記設計書が後継。

### frontend 2D Viewer 画面（`frontend/src/viewer2d/Viewer2DScreen.tsx`）— Phase 1 のみ
- **別 Electron ウィンドウ**で開く（`main.js` の `createViewerWindow` + ipc `graphy:open-viewer`、
  `preload` の `openViewer`、App は `location.hash==="#2dviewer"` で分岐）。
- 左=スタディ/シリーズツリー（検索→展開→＋でタイル追加）、右=**タイル格子**（各タイル＝SeriesViewer）。
- タイル: ヘッダ（DnD ハンドル / **エクスポート(⤓)** / Sync トグル / ×）＋コンテンツ（SeriesViewer + Fusion オーバーレイ）＋ FusionControlBar。
- **画像の外部ドラッグ保存**: タイルヘッダの **⤓ ボタン**で、画像を PNG として外部（デスクトップ/他アプリ）へ
  **Electron ネイティブドラッグ**保存。クリックでダウンロードも可（web フォールバック兼用）。
  - 仕組み: `desktop()?.startDrag(dataUrl, filename)` → preload `graphy:start-drag` → main で一時 PNG 書出 +
    `webContents.startDrag({file, icon})`。OS が本物のファイルドラッグとして扱うため **禁止カーソルが出ない**。
  - 旧実装の「ウィンドウ外ドラッグ→dragover 途絶検出→auto-capture」タイマー群は撤去（禁止カーソル/不安定の原因）。
    ヘッダ/シリーズ行の DnD はウィンドウ内（並び替え/Fusion）専用に簡素化。

## 4. 次にやること（優先度つき・未実装）
0. 🔴 **レジストレーション R1 の実機目視**（`registration-design.md` §10「R1 の実装」に 5 項目）。
   コードは main にマージ済みだが**画面での確認だけが残っている**。特に
   **平行移動の符号の向き**は、pull-back（fixed→moving）の取り違えが
   自動テストでは向きの定義そのものを固定しているだけなので、**実画面でしか発覚しない**。
   `npm run dev-desktop` → PET/CT を Fusion → 「⊹ 位置調整」の X を動かす、が最短。
   併せて R2（検証ファントム GNBP-2R）を作れば、以後この種の確認は真値付きで機械化できる。
0. **レポート機能 R6**（フェーズ2, `report-design.md` §8）: `StaffMember`ディレクトリ＋管理UI、
   `ReportTemplate`（定型文）＋管理UI。R1〜R5（データモデル・CRUD・SR/KO確定書き出し・編集ダイアログ一式・
   MainScreen ●/○表示・ReportManagerDialog）は実装・実機検証済み。
1. **2D Viewer 画面 Phase 2: 同期**（`viewer-2d-screen.md`）
   - 表示状態 Sync（camera/VOI Synchronizer 流用）→ **空間スライス同期(FoR/IPP, mm 位置)** →
     **Relative モード**（任意スライスから揃えて送る・Off 不要）。→ Phase 3 リファレンスライン(ReferenceLinesTool)。
2. **C/T 切替（別スタック）をまたぐ transform/VOI 維持**（保存 presentation/voiRange の再適用）。
3. MainScreen ツール群の残課題（`mainscreen-tools.md`）: **Burn CD/DVD**（Export 本体・NonDicomImporter・
   Anonymizer・TagExtractor・SeriesExtractor は実装・実機検証済み、`mainscreen-progress.md` 参照）。
4. ~~**web(wadors) 対応**: 画像 imageId・layout 導出（現状 standalone のみ。`imageId.ts` は web で throw）。~~
   → 📌 **2026-07-30: この項目は古い。完了扱い。** `viewer/imageId.ts:23-33` は web 分岐（BFF 経由
   wadouri）を実装済みで、throw するのは `studyUid`/`seriesUid` が欠けた場合のみ。MPR / 3D も
   web 対応済み（`fw/mpr-viewer-design.md` P1 の注記、`fw/3d-viewer-design.md` §13）。
5. Enhanced 多フレーム（DimensionIndexValues/StackID/InStackPositionNumber、wadouri `frame=`）。
6. **Fusion 改善**:
   - `viewer.fusionOpacity` / `viewer.fusionLut` を DnD 起動時に自動適用（現状は Settings に保存するのみ）。
   - base 回転時の `rect` 厳密化（現状は軸並行 BBox。回転対応は CSS transform 行列が必要）。
   - カラー(RGB)前景の非空間フォールバック対応。
   - 2D/3D 剛体・非剛体位置合わせ（設計: [`fw/registration-design.md`](registration-design.md)。
     最初の一歩は R1 = `computeFusionSlice(fg, bg, xf?)` ＋ 手動オフセット）。

## 5. 重要な注意・既知の制限
- **ブラウザ/Electron 実機での目視確認は未了の機能あり**（このセッションは build/tsc/backend test まで）。
  特に: 回転/反転の見え方、GridView リンクの同期、5D の C/T、Undo/Redo、別ウィンドウ起動。
- **Fusion の実機確認状況**:
  - DnD → FusionControlBar 表示 / 透過度スライダー / × 解除: 動作確認済み（タイル→タイル, シリーズ→タイル）。
  - オーバーレイ描画は base 画像の表示矩形に重畳（原点一致・画像領域クリップ・zoom/pan 追従）。**要実機目視**。
  - LUT は canvas 経由で常時適用（フォールバック含む）。透過度・LUT とも即反映。
  - 既知の限界: base 回転時の矩形は軸並行 BBox（厳密でない）。RGB 前景の非空間フォールバックは未対応。
- **LUT ファイル**: `backend/src/main/resources/luts/*.lut`（106 枚）。
  フォーマット判別順: ICOL マジック確認 → 768 バイト Raw → テキスト（tab 区切り）。
- **GridView/タイルは viewport を多数生成**するため巨大シリーズで負荷大。将来 仮想化/`loadImageToCanvas`
  軽量描画/ContextPool エンジンを検討（`viewer-2d-architecture.md` 参照）。
- **Viewer2D ツールバー**: 横スクロール式（`overflow-x: auto`）。ボタン追加で自動スクロール対応。
- `desktop/data/` はランタイムデータ（**.gitignore 済み**。誤コミット注意）。
- 既存メモリ（`~/.claude/.../memory/`）にも GRAPHY/GRAPHY-Next の重要事項あり（UI操作・ビルド・テスト等）。
  Fusion FW は `project_fusion_fw.md`、プロジェクト概要は `project_graphy_next.md` 参照。

## 6. 作業の進め方（このセッションの慣習）
- 変更ごとに **frontend `npm run build`（tsc込）/ backend `mvn compile`・該当テスト**を通してからコミット。
- 機能追加は **fw に設計/状態を追記**。i18n は ja/en 両方必ず。
- コミットはユーザ依頼時。`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` を付与。
- ブランチは `main`（このプロジェクトの慣習で直接コミット）。
