# automator 作業記録（WORKLOG）

automator（GRAPHY-Next 自律検証ツール）の開発記録。設計の要点は各ソースの doc コメントと
リポジトリの記憶（memory/automator.md）にも集約している。ここは**日付ごとの意思決定と作業の記録**。

## automator の 2 つの目的

1. **検証テストの自動化** — fw/*.md 由来の全機能を 31 大項目チェックリスト化し、実機
   （backend jar + Vite + Electron を自前 spawn）を Playwright で操作して 自動PASS/FAIL/要人間確認 を判定。
   結果を `checklist/<mode>/*.md` と HTML レポートに集計。**将来 CI で自動実行**し、新機能ごとに
   checklist を自動追記していく構想。
2. **本番環境でのユーザー指示による操作の自動化（RPA）** — 未実装。現状の automator フック
   （backend `AutomatorController` は `@ConditionalOnProperty(GRAPHY_AUTOMATOR=1)`、`debugApi.ts` の
   `window.__graphyDebug` は `import.meta.env.DEV` ガード）は**すべてテスト専用で本番ビルドに載らない**設計。
   #2 は本番に載る「アプリ内アクション・レジストリ＋記録/再生＋指示マッピング＋監査ガード」の新規構築が必要。
   #1 で操作を外部駆動できるアクション層を育てれば #2 に流用できる、という関係。

---

## 2026-07-30（3）— H4b の web モード検証（`h4bWebStowCheck.ts`）実 dcm4chee で完了

最後まで残っていた「H4b（プラグインの派生シリーズ保存）の web モード＝外部 PACS への STOW-RS
書き戻し」を実 dcm4chee で通した（**18 項目すべて合格**）。desktop 用の `DesktopDriver` は使わず、
**Playwright の chromium で UI 同梱 jar（:8090）を直接叩く**単独スパイクにしてある。

**判定を UI に置かないのが要点**: 「保存しました」の表示ではなく、**dcm4chee へ直接 QIDO / WADO-RS を
投げて**シリーズの実在と属性（`[Plugin] ` 接頭辞・`ImageType`・`DerivationDescription`・
`ContributingEquipmentSequence`・Rescale・**`PixelPaddingValue`**）を確認する。拒否時に増えないこと、
元シリーズが無変更であることも PACS 側で見る。

環境の再現手順と、この機に必要だった初回セットアップは `deploy/dcm4chee/VERIFY-web.md` の
「実施環境の記録」に残した（compose がこの機に無く、apt にも `docker-compose-plugin` が無いので
バイナリ v5.3.1 を直置き／`sudo docker` 必須／`:8080` は standalone backend と衝突）。

ここでも自分のスクリプト側のミスを 2 つ踏んだ（アプリは正しかった）:

- ヘッダのコメントに `~/dcm4che-*/bin` と書き、**`*/` がブロックコメントを閉じていた**（esbuild が
  構文エラー）。コメント内にパスのワイルドカードを書くときは `*/` を作らないこと。
- **QIDO の IS 型は文字列で返る**（`NumberOfSeriesRelatedInstances` が `"1"`）。`=== 1`（number）で
  比較すると必ず外れる。QIDO の値は必ず `Number()` を通す。

---

## 2026-07-30（2）— 非画像 SOP クラスの検証スパイク（`nonImageSeriesCheck.ts`）

RTSTRUCT のような**ピクセルを持たない SOP クラス**をシリーズ一覧から開くと、Cornerstone が
`The pixel data is missing` で reject し**未処理例外がコンソールに出るだけ**だった問題の検証。
本体側の修正は `frontend/src/viewer/seriesRenderable.ts`（SOP クラス優先・Modality フォールバック）。

検証項目（8 件・全合格）: MainScreen が説明を出してビューアを開かない／2D の左ツリー ＋ で
タイルにならずトーストが出る／**`pixel data is missing` がコンソールに出ない**／
画像シリーズ（CT）はこれまでどおり開ける（弾きすぎていない）。

**RTSTRUCT の DICOM はリポジトリに置けない**ので、`GRAPHY_NONIMAGE_FILE`（ファイル/フォルダ）か
`fixtures/rtstruct-seg-existing/*.dcm` があれば実行し、無ければ該当項目を skip する作りにした。

ここでも**テスト側の照合ミス**を 2 つ踏んだ（アプリは正しかった）:

- シリーズ行のテキストは連結されて `"2CT—50"` になるため `\bCT\b` に**一致しない**。
  逆に `/CT/` は **RTSTRUCT**（…U-C-T）に一致してしまう。→ **Modality セル（表の 2 列目）を直接読む**。
- スタディ行は**クリックでトグル**する（選択済みを押すと閉じてシリーズ行が消える）。
  → 行が出なければ押し直す。かつ「見つけた時点で開く」（ループを抜けてから状態を頼らない）。
- 2D ウィンドウは**タイルが 0 件だとメニューバーが出ない**（空状態）。準備完了の判定に
  `viewer2d-menu-*` を使うと詰むので、左ツリーの検索ボタンで判定する。

---

## 2026-07-30 — DesktopDriver が DevTools を掴むバグ修正・host API H1〜H4b の実機検証スパイク

### 修正: `DesktopDriver` が DevTools ウィンドウをメイン画面と誤認していた

`start()` は `waitForEvent("window", predicate: url.startsWith(viteOrigin))` でメイン画面を待ち、
外れたら `.catch(() => firstWindow())` にフォールバックしていた。ところが **`window` イベント発火時点の
`url()` は `about:blank` のことがある**ため predicate に外れ、timeout 後の `firstWindow()` が
`GRAPHY_DEV=1` で開く **DevTools ウィンドウ**（`devtools://…`）を返す。その Page で
`search-patientid-input` を待つので「MainScreen が出ない」と誤検知する（実際に 2 回踏んだ）。

→ 現存ウィンドウ（`electronApp.windows()`）を **url でポーリングして選ぶ** `findWindow()` に変更。
`waitForNewPage()` も同じ理由でイベント待ちに加えてポーリングでも探すようにした。
**既存 item の実行安定性にも効く**（同じ race を踏んでいた可能性が高い）。

### 追加: `src/spike/hostApiCheck.ts` — プラグイン host API の実機検証（H1/H2 で開始、H4a まで拡張）

`fw/plugin-architecture.md` §7 の H1（`getTargets()`）/ H2（`getViewState()`）を、**本物の
プラグイン配信経路**で検証するスパイク（後に H3/H4a まで拡張。下記の追記参照）。
backend の plugins root に `plugin.json` ＋ `ui.js` を置き、`/api/plugins` 経由で読み込ませる。
プラグインは結果を `window.__hostApiCheck` と画面パネルの両方へ出し、前者を `page.evaluate` で検証、
後者をスクリーンショット（`.results/hostapi-check/*.png`）で人が読める形に残す。26 項目すべて合格。

DOM 依存ゼロで表示内容が取れること・**呼ぶたびに現在値を読むこと**（スライス送り／W/L プリセット／
階調反転／LUT に追従）を確認し、本体側のバグ 1 件（`colormap` が内部登録名
`graphy-lut-<名>` を漏らしていた）を検出して修正させた。

**将来**: checklist item（`12-viewer2d-menu-toolbar` あたり）へ昇格させるとレポートに載る。
現状はスパイクのままで、fixture は ct-basic に依存。

**追記（同日・H3 対応で 42 項目に拡張）**: 画素読み出し（`getPixelData()`）の検証を追加。
`Float32Array` を `page.evaluate` 越しに運ばず、**プラグイン側で min/max/mean/中央画素に要約**して
から検証する形にした。ここで検証側の誤りを 1 つ踏んでいる: 「min は空気の約 −1000 HU」と書いたが、
ct-basic fixture は **GE の画素パディング（raw −2000 ＋ intercept −1024 = −3024）**を持つため min が
パディング値になる。**Rescale の二重適用の判定は軟部組織の値**（腹部中央が −200〜300 HU）で行うのが正しい。
併せて「W/L・階調反転・LUT を変えても同一スライスの画素値は不変」を検証項目にした
（＝表示 8bit ではないことの直接確認）。

検証用プラグインの原本は `.results/`（gitignore 対象）ではなく **`automator/plugins/hostapi-check/`**
に置き、実行時に backend の plugins フォルダへコピーする。パスは `DesktopDriver` が
`DESKTOP_RUN_DATA_DIR` として export する。

**追記 2（同日・H4a 対応で 54 項目に拡張）**: オーバーレイ表示（`showOverlay()`）の検証を追加。
ここで**「要素が見えている」検証の限界**を踏んだ: `plugin-overlay-canvas` は visible だが
**中身が空**（`300×150`・α>0 が 0 個）というバグを、可視判定では検出できなかった。
`page.evaluate` で**キャンバスの `getImageData()` を読み、α>0 の画素数が閾値マスクの該当数と
一致するか**を検証項目にして初めて捕まえた（本体側の原因は callback ref にすべきところを
`useRef` にしていたこと）。**描画結果の検証は「要素の有無」ではなく「画素」で行う**。
併せて、白い骨の上に白いオーバーレイを重ねても人が見て分からないため、検証プラグインでは
本体の LUT（`Hot_Iron`）を指定して色を付けている（スクリーンショットが証跡として機能する）。

**追記 3（同日・H4b 対応で 73 項目に拡張）**: 派生シリーズ保存（`saveDerivedSeries()`）の検証を追加。
保存は**確認ダイアログを本体が出す**ので、`plugins/hostapi-save/` を別プラグインとして分けた
（`hostapi-check` はメニュークリックで毎回走るため、保存を混ぜるとダイアログが常に出てしまう）。

検証の要点は **UI の見た目で終わらせないこと**: 「保存できたと表示された」ではなく
**backend の `/api/studies/{study}/series` と `/instances/{sop}/tags` を直接読み**、
シリーズが実在し `[Plugin] ` 接頭辞・`ImageType=DERIVED`・`DerivationDescription` のプラグイン id・
`ContributingEquipmentSequence`・Rescale 恒等・`RescaleType=HU` が揃っていること、
**拒否したときはシリーズが増えないこと**、**元シリーズが無変更であること**を確認している。

ここでも自分の assertion 側の誤りを 2 つ踏んだ（コードは正しかった）: ①`SeriesDto` の枚数は
`instances` ではなく `numberOfInstances` ②タグダンプの `name` は**DICOM キーワード**
（`ImageType` / `RescaleSlope`。「Image Type」のような空白付きラベルではない）。
**DTO とダンプのフィールド名は実物を確認してから assert する。**

---

### 追加: `src/spike/aneurysmPluginCheck.ts` — 実在する重いプラグインを通しで動かす

`hostApiCheck.ts` が host API の**契約**を極小プラグインで網羅するのに対し、こちらは
**外部の重いプラグイン 1 本を最初から最後まで動かして、契約が実用に耐えるか**を見る。
検体は社内の CADe プラグイン "Aneurysm Detector"（本体リポジトリ外）＋公開データ
AneuriskWeb C0005（3D-RA・256³・0.349mm 等方）。**23 項目すべて合格**。

契約の網羅では出てこない、次の 3 点が確かめられた。

- **`getPixelData()` の「1 回 1 スライス」設計がシリーズ全体の読み出しに耐える**。
  256 枚を 1 枚ずつ読んで積み直したボリュームが、取り込んだ枚数・spacing と一致した。
- レンダラの Worker で **100 秒の計算**を回しても本体の UI が壊れない。
- `showOverlay()` が読影に使える。**重ねる前後のスクリーンショットが実際に変わる**ところまで見る。

検証の書き方で気をつけた点:

- **「要素が出た」で合格にしない**。オーバーレイは前後のスクリーンショットを `Buffer.compare` で、
  CPR は `getImageData()` で濃淡（min/max の開き）を見る。H4a の実機検証で
  空のキャンバスが乗ったまま合格しかけた前例があるため。
- 最初のスライス（Z=1）は空気しか無く重ねても何も変わらないので、
  **候補のスライスへ送ってから**重ねる。
- プラグインのパスと DICOM ディレクトリは**引数必須**（既定値を埋め込まない）。
  既知病変の座標は `--truth=x,y,z` で渡し、省略時は当たり判定だけ飛ばす。
  → 検体を差し替えても、そのまま「重いプラグインの通し確認」として使い回せる。

この回で見つかった不具合はプラグイン側の 1 件のみで、**本体側は出ていない**。


## 2026-07-14 — web/desktop 分離・HTML レポート・desktop 縦串の実機 PASS・teardown 修正

### 決定
- **web/desktop を分けて開発する**（両モードで機能セット・データ投入経路が異なるため）。
  構造は **Option A = 共有コア＋モード別 item/checklist**を採用。
  - driver/runner/recorder/fixtures は共有。`ChecklistItem.modes: Mode[]` で
    desktop専用/web専用/両対応(shared) を宣言。
  - `src/checklist/items/` を `shared/` `desktop/` `web/` に再編。
    registry に `getItemsForMode(mode)` / `getItemsByCategory(cat, mode)`。
  - `checklist/` を `checklist/desktop/`（全31機能）`checklist/web/`（後追い・現状空）に分割。
    recorder は `checklist/<mode>/<category>.md` へ書き戻す。
  - import は `/api/import/paths`（standalone専用）依存で **desktop のみ**。
    web は PACS/DICOMweb 経由の別 item（未実装）。

### 実装
- `ChecklistItem.modes` 追加、CLI（`list`/`run`/`confirm`）を `--mode` 対応。
  `run [itemIds...]` を可変引数化し、複数 item を**記載順に1セッション**で実行可能に。
- **`automator report`**（`src/report/`）: `checklist/<mode>/*.md` の状態サマリ表を解析し、
  機能ごとの検証結果を**自己完結 HTML**（依存なし）に出力。**Desktop/Web はタブ切替**、
  進捗バー＋小項目テーブル（状態バッジ・最終実行日・由来 fw ドキュメント）、light/dark 対応。
  出力先 `.results/report.html`（gitignore）。

### 検証（実機）
- ct-basic fixture = `graphy_sample_images/FFT_CT_ABD`（CT 50枚・軸位・5mm 等間隔・単一シリーズ、
  dcm4che dcmdump で確認）を `fixtures/ct-basic/` に配置（gitignore）。
- desktop 縦串（reset→import→検索→2D非ブランク描画）を1セッションで実行 → **4項目すべて自動PASS**。
  checklist md・HTML を 2026-07-14 付で更新。着手率 4/129 = 3%。

### バグ修正: teardown ハング（CI で致命的だった）
- 症状: 全項目 PASS 後、親 node が `stop()` 後に終了できず 25 分ハング。Vite が残留（PPID=1）。
- 原因: `killProcessTree` の posix 分岐が `proc.kill()` で**直接の子（npm）しか殺さず**、
  その子の `vite`(node) が init へ里子化して残存。残った Vite の stdout/stderr パイプが
  親 node のイベントループを生かし続け、プロセスが終了できなかった。
- 修正: posix では**プロセスグループごと** `process.kill(-pid, SIGTERM)` で終了。これが効くよう、
  driver 側の Vite spawn に `detached: true`（グループリーダー化）を付与。単体kill フォールバックあり。
- 検証: Electron を使わず Vite spawn→起動→killProcessTree だけを切り出した使い捨てスクリプトで、
  グループ全滅＋親 node の自然終了（timeout せず exit 0）を確認。

### 次の候補
- A. desktop 検証項目の拡充（12 メニュー/ツールバー, 17 MPR, 19 Slicer 等）。
- B. web モードの土台（PACS/DICOMweb データ投入 → web 縦串 → `checklist/web/` 立ち上げ）。
- C. #2 のアクション・レジストリ試作（検証と本番 RPA の共通土台）。
