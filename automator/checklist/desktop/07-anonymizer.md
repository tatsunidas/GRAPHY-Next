# 07. Anonymizer

**ソース**: fw/mainscreen-tools.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | PS3.15プロファイルでタグ匿名化（X/Z/D/K/C/U）・UID一貫置換ができる | 自動PASS | 2026-08-20 |
| 2 | 新PatientID/Name設定、RetainSafePrivate等のオプションが機能する | 自動PASS | 2026-08-20 |
| 3 | 矩形マスクによる画素焼き込み（BurnedInAnnotation=NO）ができる | 未着手 | |
| 4 | 出力（ZIP/フォルダ）が正しく生成される（standalone専用、webは非対応バナー） | 自動PASS | 2026-08-20 |

## 小項目詳細

### 1. PS3.15プロファイルでタグ匿名化（X/Z/D/K/C/U）・UID一貫置換ができる

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 07-anonymizer.item-01 -->
#### 2026-08-20 (run 20260820-192133-qrz6cx)
1. MainScreen の初期マウントを確認
2. 無条件検索でスタディ一覧を取得
3. 先頭のスタディ行をクリック
4. 匿名化前の先頭スタディの PatientID を記録 `{"originalPatientId":"GNBP-D-1"}`
5. Anonymizerダイアログを開く
6. 新PatientIDを設定: ANON_ITEM01
7. モックしたフォルダを出力先として選択 `{"destDir":"/home/tatsunidas/graphy-workspace/GRAPHY-Next/automator/.results/anon-out-1787221295491"}`
8. 匿名化コピー完了メッセージを確認 `{"infoText":"Done: 97 instance(s) (burned 0)"}`
9. 出力先フォルダにファイルが実在することを確認 `{"filesAppeared":true}`
10. 匿名化出力を再取込み `{"imported":{"imported":97,"skipped":0,"failed":0,"errors":[]}}`
11. 元のPatientID GNBP-D-1 が引き続き検索できることを確認（上書きされていないか） `{"originalStillThere":true}`
12. 新PatientID ANON_ITEM01 で検索し、匿名化後の別スタディを確認 `{"found":true}`
Result: PASS — 匿名化+再取込みで元スタディ(GNBP-D-1)と別スタディ(ANON_ITEM01)が共存することを確認
<!-- AUTOMATOR:END 07-anonymizer.item-01 -->

### 2. 新PatientID/Name設定、RetainSafePrivate等のオプションが機能する

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 07-anonymizer.item-02 -->
#### 2026-08-20 (run 20260820-192137-xtrfku)
1. MainScreen の初期マウントを確認
2. 無条件検索でスタディ一覧を取得
3. 先頭のスタディ行をクリック
4. Anonymizerダイアログを開く
5. RetainSafePrivateオプションを有効化、新PatientNameを設定: ANON^ITEM02
6. 新PatientIDを設定: ANON_ITEM02
7. モックしたフォルダを出力先として選択 `{"destDir":"/home/tatsunidas/graphy-workspace/GRAPHY-Next/automator/.results/anon-out-1787221298050"}`
8. 匿名化コピー完了メッセージを確認 `{"infoText":"Done: 97 instance(s) (burned 0)"}`
9. 出力先フォルダにファイルが実在することを確認 `{"filesAppeared":true}`
10. 匿名化出力を再取込み `{"imported":{"imported":97,"skipped":0,"failed":0,"errors":[]}}`
11. 新PatientID ANON_ITEM02 で検索し、オプション付き匿名化後のスタディを確認 `{"found":true}`
Result: PASS — RetainSafePrivate有効・新PatientID=ANON_ITEM02で匿名化コピーが成功
<!-- AUTOMATOR:END 07-anonymizer.item-02 -->

### 3. 矩形マスクによる画素焼き込み（BurnedInAnnotation=NO）ができる

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)
- **保留（2026-07-17）**: `registerAnonMask()`（`frontend/src/api.ts`）は定義されているが、
  「2D viewerで矩形ROIを描き『焼き込みに使用』で登録する」という説明文（`ja.ts` の
  `anon.burnIn.note`）に対応する呼び出し元がフロントエンドのどこにも存在しない
  （呼び出し箇所0件、`AnonymizerDialog.tsx`の焼き込みチェックボックスは既登録マスクの有無を
  トグルするだけで、マスク自体を作る手段がUIにない）。automatorの制約ではなく機能自体が
  未実装のため、UI実装が追加されるまで着手不可。

<!-- AUTOMATOR:BEGIN 07-anonymizer.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 07-anonymizer.item-03 -->

### 4. 出力（ZIP/フォルダ）が正しく生成される（standalone専用、webは非対応バナー）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 07-anonymizer.item-04 -->
#### 2026-08-20 (run 20260820-192139-7zkeu4)
1. MainScreen の初期マウントを確認
2. 無条件検索でスタディ一覧を取得
3. 先頭のスタディ行をクリック
4. ZIP出力完了メッセージを確認 `{"infoText":"ZIP created: 97 instance(s), 168649 bytes"}`
Result: PASS — ZIP出力完了: ZIP created: 97 instance(s), 168649 bytes
<!-- AUTOMATOR:END 07-anonymizer.item-04 -->

