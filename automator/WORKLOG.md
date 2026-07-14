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
