# エラーハンドリング & ロギング方針

> 作成日: 2026-06-28
> ステータス: 確定（以降の開発で従う）

## 方針（重要）
- **エラーが起こりそうな箇所・未検証の箇所には必ず DEBUG ログを残す**（トラブル追跡用）。
- **検証済みで出力が過剰になるログは DEBUG へ降格 or 削除**していく。
- 失敗は握り潰さない。少なくとも WARN/ERROR で残す。

## backend（Spring Boot / Logback + SLF4J）
- **共通例外ハンドラ** `GlobalExceptionHandler`(@RestControllerAdvice):
  - クライアント起因(IllegalArgumentException)→ 400・WARN。
  - I/O・状態異常(IOException/IllegalStateException)→ 500・ERROR(スタック付き)。
  - 想定外(Exception)→ 500・ERROR(スタック付き)。
  - レスポンスは一貫した JSON `{status, error, message, path}`。
- **ログレベル**: 既定 `com.vis.graphynext=INFO`。トラブル時に DEBUG にすると
  外部ツール起動(`exec: ...`)・DICOMweb 通信(QIDO req/res)・索引(`indexed ...`) 等の詳細が出る。
- 降格済みの例: `indexed`(大量取込で冗長)、`exec:`(外部ツール)、`WebDicomDataService initialized`。
- 残してある DEBUG（リスク/未検証）例: QIDO リクエスト/レスポンス、外部ツールコマンド、ファイル書換失敗の WARN。

## frontend（React）
- **共通 fetch** `http.ts`(`httpGet`/`httpSend`): backend の `{message}` を解析して例外化し、
  失敗は必ず `log.warn`/`log.error`。ネットワーク到達不可も区別してログ。
- **ロガー** `log.ts`: `debug` は dev または `localStorage("graphy.debug")="true"` のときのみ。
  過剰ログを避けつつ、リスク箇所の追跡用に `log.debug` を仕込める。
- **ErrorBoundary**: 描画時の予期せぬエラーを捕捉してクラッシュを防ぐ（フォールバックは日英併記）。
- API モジュール(`api.ts`/`settingsApi.ts`/`dbAdminApi.ts`)は全て `http.ts` 経由。
