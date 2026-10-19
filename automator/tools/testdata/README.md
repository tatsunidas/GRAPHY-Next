# 採点スクリプトの固定データ

- `seg_fixture.dcm` … 本体の `SegExportService`（ラベルの平面から BINARY SEG を作る経路）が書いた SEG。4 スライス × 5 行 × 6 列、3 ラベル、
  行間隔 0.8 mm・列間隔 1.5 mm・スライス間隔 3 mm、向き IOP = (1,0,0, 0,-1,0)（スライスは -z 方向に進む）。
- `expected.json` … 正しい答え。ラベルごとのボクセル中心の患者座標（LPS・mm）と 1 ボクセルの体積（mL）。
  Java のテストの中の配列から、DICOM の式（IPP + 列番号×列間隔×IOP[0..2] + 行番号×行間隔×IOP[3..5]）で別に計算して書き出している。
  読み取り側（`monai_score.py`）の式とは独立。

作り直し（SEG の UID・日時は毎回変わるので、バイト一致ではなく `expected.json` の一致と、読み取った座標の一致で確かめる）:

    cd backend && mvn -q -Dfrontend.skip=true test -Dtest=SegExportScoringFixtureTest -Dseg.fixture.out=<出力先>
