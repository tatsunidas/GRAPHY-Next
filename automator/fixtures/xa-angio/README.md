# xa-angio — アンギオ（XA/XRF）検証データ

`fw/angio-design.md` の A1〜A4（シネ / DSA / 空間校正 / QCA）を実機で確認するためのデータ。

## 取得

```bash
bash automator/scripts/fetch-xa-samples.sh
```

Rubo Medical が公開しているビューア動作確認用サンプルを取得する。冪等（zip をキャッシュする）。

> ⚠️ **再配布しないこと。** 配布ページに利用条件・ライセンスの明示は無く、
> ビューアの動作確認用に公開されているサンプルなので**手元での検証にのみ使う**。
> このディレクトリは `.gitignore` 済みで、リポジトリには入らない。
> 出典: <https://www.rubomedical.com/dicom_files/>

## 中身（2026-08-14 に実データで確認）

| ファイル | SOP | フレーム | FrameTime | 用途 |
| :- | :- | -: | -: | :- |
| `0002.DCM` | XA (12.1) | **96** | 33 ms（≈30 fps） | A1 の主データ。フレーム数・fps・JPEG デコード |
| `0003.DCM` | XA (12.1) | 17 | 66 ms（≈15 fps） | biplane 対の片方（A6 の 2 方向候補） |
| `0004.DCM` | XA (12.1) | 17 | 66 ms（≈15 fps） | biplane 対のもう片方 |
| `0009.DCM` | XA (12.1) | **137** | 40 ms（25 fps） | 長いランでのメモリ・プリフェッチ |
| `0012.DCM` | XA (12.1) | **70** | 40 ms（25 fps） | 複数ラン（Run スライダー）の確認 |
| `0015.DCM` | XRF (12.2) | 1（単一） | — | **シネ展開の対象外**であることの確認 |

いずれも 512×512（0015 のみ 1024×1024）・8bit・MONOCHROME2・JPEG Baseline（0015 は非圧縮）。

## このデータで「確認できること / できないこと」

**できる**
- A1: フレーム展開・シネ再生・実測 fps・Frame/Run スライダーの提示・ホイール送り・Grid（フレーム一覧）
- A2: 対数変換（`PixelIntensityRelationship = LIN`）経路の DSA、マスク自動選択、ピクセルシフト
- A3: **未校正（P7）に落ちて px 表示になること**と、カテーテル校正（C2）で mm になること
- A4: QCA が動くこと（**数値の正しさは別**。下記）

**できない**
- A3 の **P1〜P5 の経路**（`PixelSpacing` / `ImagerPixelSpacing` / SID/SOD がこのデータに無い）。
  特に **P3'（`PixelSpacing` が `ImagerPixelSpacing` と同値＝未校正）の降格**は踏めない。
- A4 の **精度検証**（真値が無い）。`bench/` の GNBP-XA ファントム（設計 §16.3 / A4b）が要る。
- A6 の射影幾何（**SID/SOD が無い**ため射影行列を組めない）。
- A9（RDSR がこのデータに無い）。
