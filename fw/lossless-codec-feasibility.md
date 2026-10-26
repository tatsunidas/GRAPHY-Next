# 可逆圧縮への符号化の実現性（実測）

受信したファイルを保管庫で可逆圧縮する案のための、符号化の実測。調べたのは「同梱の OpenCV ネイティブ（dcm4che-imageio-opencv）で、各 OS から可逆圧縮へ符号化でき、復号した画素が元と 1 バイトも違わないか」。

- 実行: `LosslessCodecFeasibilityTest`（`backend/src/test/java/com/vis/graphynext/dicom/store/`）。workflow `codec-feasibility.yml` を手動実行（2026-10-26、run 40250825483）。
- データ: 合成画素のみ（体幹風の楕円＋小さなノイズ。128×96、複数フレームは 3 枚）。実データ・患者データは使っていない。
- 復号は本番と同じ経路（`IncludeBulkData.URI` で読み、`PixelCodec.decompress`）。元の PixelData のバイト列と全比較。
- 負例（検出器の確認）: 符号化済みの画素を壊すと、復号が失敗するか画素が変わることを JPEG-LS・JPEG 2000・RLE について確かめた（符号化できない RLE は対象外）。通っている。

## 結果（合格 / 失敗 / 未達）

| OS | JPEG-LS Lossless | JPEG 2000 Lossless | RLE Lossless |
|---|---|---|---|
| Linux x86-64（ubuntu-latest） | 4/4 一致 | 4/4 一致 | 符号化できない |
| Windows x86-64（windows-latest） | 4/4 一致 | 4/4 一致 | 符号化できない |
| macOS arm64（macos-latest） | 4/4 一致 | 4/4 一致 | 符号化できない |

各セルの 4 件は、16 bit 符号付き（CT）／16 bit 符号なし（12 bit 格納）／8 bit／16 bit 符号付き 3 フレーム。**合格 24、失敗 0**。RLE は 12 件とも「符号化できない」（dcm4che-imageio-rle 5.34.3 に読み手だけあって書き手が無く、`Unsupported Transfer Syntax`）。これは未達ではなく、この版では**使えない**という結果。Windows・macOS で追加の符号化手段を確かめてはいない。

圧縮後の画素サイズ／元（合成画素。実データの圧縮率は画像による）:

| 型 | JPEG-LS | JPEG 2000 |
|---|---|---|
| 16 bit 符号付き | 0.31 | 0.33 |
| 16 bit 符号なし（12 bit 格納） | 0.28 | 0.31 |
| 8 bit | 0.41 | 0.48 |

## 分かったこと・注意（実装時の落とし穴）
- **符号化は遅延して走る。** `Compressor.compress()` は設定だけで、実際の符号化は `DicomOutputStream` での書き出し中に走る。`Compressor` は書き終えるまで閉じない（先に閉じると書き出しで NullPointerException）。
- **入力の PixelData は `BulkData`（ファイルへの参照）であること。** byte[] のままだと ClassCastException。受信経路では一時ファイルを `IncludeBulkData.URI` で読む形にする（復号側と同じ規約）。
- ネイティブの読み込みは `PixelCodec.available()` が前提（`--add-opens` 2 つ、同梱ネイティブ）。使えない環境では機能を無効にする。
- 手元（Linux）はネイティブ 5.33.1、Actions は 5.34.3。どちらも同じ結果。

## 判断
- 転送構文は **JPEG-LS Lossless（`1.2.840.10008.1.2.4.80`）を第一候補**、JPEG 2000 Lossless（`…4.90`）を代替とする。3 OS とも通り、JPEG-LS のほうが小さい。RLE は採らない。
- 未確認（段 1 以降で確かめる）: 実データ（実際の CT・MR・CR）の圧縮率と速度、受信の所要時間、マルチフレーム・カラー・12 bit 以外の格納ビット、他の画素を読む機能（エクスポート・NIfTI・ラジオミクス等）での読み込み。

## 段 1（受信時の可逆圧縮）の実装の要点
- `ReceiveCompressor`（`dicom/store/`）。設定 `dicom.receiveCompress`（`off` が既定／`jpegls`）が `jpegls` のときだけ、C-STORE と C-GET の受信ファイルを、匿名化の後・保管の直前に 1 回だけ圧縮する。
- **多重圧縮をしない**: 入力が非圧縮でなければ（JPEG・JPEG-LS・JPEG 2000・RLE など）復号も再符号化もせず、そのまま保存する（有損の JPEG を可逆へ変換しない）。出力は必ず圧縮済みなので、2 度通しても不変。保管庫の既存ファイルは読まない。小さくならなければ元のまま。
- 対象は非圧縮の CT・MR・CR・DX・MG・PT の単色 8/16 bit。SR・SEG・動画・カラー・Enhanced・XA・US などは変えない。
- 符号化後に復号して元の画素と全バイト比較し、PixelData より前の属性も比べる。1 つでも違えば元のまま保存し、受信は失敗させない（理由は警告ログ。患者名・ID は書かない）。
- 状態は `GET /api/dicom/receive-compress/status`（standalone のみ）。
