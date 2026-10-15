# Google Drive 対応 P0 スパイクの結果（2026-10-12）

計画: `~/.claude/plans/graphy-next-db-googledrive-agile-cupcake.md`。スクリプト: `automator/src/spike/gdriveApiCheck.ts`・`gdrivePickerCheck.ts`。
スコープは `drive.file` のみ。Picker は利用者の既定ブラウザで検証（Electron の窓での表示は P1 で確認する）。

| 項目 | マイドライブ | 共有ドライブ |
|---|---|---|
| PKCE（loopback）ログイン | 合格 | （同じ） |
| Picker でフォルダ選択・メタデータ取得（driveId） | 合格 | 合格 |
| 選んだフォルダ直下にフォルダ作成 | 合格 | 合格 |
| resumable upload・md5 一致 | 合格 | 合格 |
| 中断後の受信位置の問い合わせ→続きから再開 | 合格 | 未実施 |
| appProperties で再送を検出（冪等） | 合格 | 未実施 |
| 選んだ既存フォルダの子ファイルが見える | **0 件**（中身ありを利用者が確認） | **0 件**（中身ありを利用者が確認） |
| drives.list（共有ドライブ一覧） | — | **失敗**（403 insufficient scopes） |

## 設計への結論
- 既存フォルダの中身は `drive.file` では見えない → **Picker で選んだ場所の直下に、アプリが `GRAPHY-DB/` を作る**。
- 共有ドライブの一覧 API は使えない → **Picker で選んだフォルダから `driveId` を得る**。
- Picker はマイドライブ／共有ドライブの 2 つの view を並べる（1 つにすると既定が共有ドライブになる）。

## 未検証
- （確認済み: 両ドライブとも、中身のあるフォルダで子が見えない）
- 共有ドライブ上での中断・再開と appProperties 検索
- Electron の窓での Picker 表示（CSP・ポップアップ）
- 翌日以降（refresh token）に、自作フォルダを再発見できるか
