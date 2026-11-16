findscu / getscu / movescu の出力の実測（dcm4che 5.34.3、偽の SCP に向けて採取）。DimseOutcomeTest が読む。
先頭行 `exit=<終了コード>`、残りがツールの出力（標準出力＋標準エラー）。

加工した fixture（実機の報告の形に合わせて、実測を加工したもの。生の採取ではない）:
- find-pc-refused-then-eof.txt … find-no-qr.txt の、A-ASSOCIATE-AC で Q/R の PC が拒否された（result: 3）あと、
  A-RELEASE の応答でなく EOFException in State: Sta6（相手が接続を切る）形にしたもの。
  実例: PSP 中継サーバー（2026-11、v0.6.3 の通信テスト）。
- get-pc-ts-refused.txt … get-no-qr.txt の GET の PC を、転送構文の拒否（result: 4）にしたもの。
