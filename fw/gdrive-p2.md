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

## 既知の制約・仮の値
- 直近 10 分の読み出し保護（`GdriveSyncService.RECENT_ACCESS_MS`）は仮。返した `Path` を後で開く経路（`FileSystemResource` の Range 配信、エクスポートのコピーループ）があるため、参照カウントの代わりに時間で守っている。実測で見直す。
- 追い出しでは空になった親フォルダを消さない（取り込みとの競合を避けるため）。空のフォルダが残る。
- 上限を超えるのは、未送信が多いとき（オフライン中の取り込みなど）と、同期した直後の 10 分間。画面に警告を出す（P2-4）。

## 段階
| 段 | 内容 | 状態 |
|---|---|---|
| P2-1 | 台帳の列・設定の貫通・追い出し・reconcile の分岐・削除の通知 | 実装・単体テスト済み（`GdriveCacheModeTest` 10 件、desktop 2 件）。変異確認: 候補の `SYNCED` 条件・追い出し済みの扱い・直近保護 |
| P2-2 | `resolveForRead` の取得（md5 検証）・`StorageUnavailableException`・503・一括先読み・書き換え前の取得・DB 間転送の拒否 | 未着手 |
| P2-3 | モード A の復元（索引のみ）・解除条件・「すべてローカルに保存」・B→A 切替 | 未着手 |
| P2-4 | GdrivePanel（モード・上限・使用量・全件保存）・i18n・vitest | 未着手 |
| P2-5 | 実 Drive 検証（小さな上限で追い出し→取得）・文書 | 未着手 |
