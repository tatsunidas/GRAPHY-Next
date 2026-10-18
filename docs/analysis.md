# ROI・マスク・解析

!!! note "このページは作成中です"
    以下の内容を予定しています。

## ROI

- ROI の描画（矩形・楕円・多角形・フリーハンド）
- ROI マネージャ — 一覧、名前・色の編集、表示切り替え
- 統計値（面積、平均、標準偏差、最大 / 最小など）とヒストグラム
- 動画シリーズでのフレーム指定 ROI

## マスク・セグメンテーション

- マスク塗り、ワンドツール、レベルセット
- ROI ↔ メッシュの変換
- DICOM SEG / RTSTRUCT の読み込みと書き出し

## 定量解析

- PET の SUV 校正（body weight ほか）
- Time-Intensity Curve
- テクスチャ解析（Radiomics）— RadiomicsJ 連携

### Radiomics 特徴量（ROI）

ROI 全体を 1 つの領域として、RadiomicsJ で Radiomics 特徴量を計算し、表と CSV に出します。研究用（Research Use Only）で、診断には使いません。

**開き方**: 2D ビューアで画像を表示し、メニューの 解析 ▸ Radiomics 特徴量（ROI）… を選ぶと、別ウィンドウが開きます（デスクトップ版のみ）。

**手順**

1. 対象シリーズと ROI マスクを選びます。必要なら「症例ラベル」（例 `case-012`）を入れます。CSV の `CaseLabel` 列とファイル名に入ります。症例を突き合わせるための番号などを入れ、患者名・患者 ID は入れないでください。マスクは DICOM SEG などのマスクシリーズです。SEG に複数のセグメントがあれば、セグメントを名前で選べます。塗りの ROI は、ROI マネージャーの「DICOM SEG で保存」でマスクシリーズにしてから選んでください。
2. 設定を選びます。
    - 離散化: ビン数（既定 32）かビン幅（既定 25）。
    - リサンプリング: なし、または等方の画素間隔（mm）。
    - 特徴量の族: 既定は RadiomicsJ と同じです（GLAM と 2D 形状はオフ）。GLAM は計算量が ROI のボクセル数の 2 乗で増えるので、大きな ROI では断られることがあります。
3. 「計算」を押します。計算中は「読み込み中／計算中」と経過時間が出ます。数万ボクセルの ROI では数十秒〜数分かかります。

**表の見方**

- 族ごとに、特徴名・IBSI の識別子・値・注記を並べます。IBSI の識別子で、IBSI（Image Biomarker Standardisation Initiative）の定義表と照合できます。
- 族の見出しに、その族の離散化（ビン数かビン幅）が出ます。
- 取り違えやすい定義には注記が付きます。
    - 過剰尖度（−3 済み）: 一次統計と強度ヒストグラムの Kurtosis は、正規分布で 0 になる過剰尖度です。
    - log2・離散化後: 強度ヒストグラムの Entropy は、離散化した値の、底 2 のエントロピーです。
    - IBSI 外: IBSI の定義に無い特徴です（フラクタル、GLAM、2D 形状、一次統計の TotalEnergy・StandardDeviation・StandardError など）。
    - Diagnostics の `ResegmentedROIMorphMaskVoxelCount` には、RadiomicsJ 2.4.1 では強度マスクの数が入ります。形態マスクの数は、表の上の「形態」か CSV の `Roi_MorphMaskVoxels` を見てください。
- 表の上に ROI の大きさが出ます。
    - 「ROI」: 選んだマスクのボクセル数。
    - 「計算に使った数」: リサンプリング・範囲フィルタ・外れ値除去の後に、強度とテクスチャの特徴を計算したボクセル数。
    - 「形態」: 形態特徴に使うマスクのボクセル数。リサンプリングの後の数で、範囲フィルタ・外れ値除去では減りません。
    - 「体積」: 形態のボクセル数 × 計算に使った画素の体積（mm³）。
- 環境設定 ▸ テクスチャの「小さい ROI の警告（ボクセル数）」に値を入れておくと、計算に使った数がそれより少ない ROI で、表の上に警告が出ます。空欄なら警告しません（[環境設定](settings.md)）。

**CSV に書き出す**

2 つのファイルを保存します。ファイル名は、症例ラベルがあれば `<症例ラベル>-seg<セグメント>`、無ければ `roi-features-<シリーズ番号>-seg<セグメント>` で始まります。

- `….csv`: 1 行目が列名、2 行目が値（1 行 = 1 ROI）。先頭の 5 列は記録です。
    - `CaseLabel`: 症例ラベル（空のこともあります）。
    - `Provenance_GraphyNextVersion`・`Provenance_RadiomicsJVersion`: 計算したソフトの版。
    - `Provenance_ExtractedAt`: 計算した日時（ISO 8601、UTC）。
    - `Provenance_SettingsSha256`: 計算に使った設定ファイルの SHA-256。設定が同じなら同じ値になるので、症例ごとの CSV を集めたときに設定の違いがこの列で分かります。

    続く 6 列は ROI の大きさです。体積を共変量として解析に入れるときに使います。
    - `Roi_InitialVoxels`・`Roi_IntensityMaskVoxels`・`Roi_MorphMaskVoxels`・`Roi_VolumeMm3`: 表の上の「ROI」「計算に使った数」「形態」「体積」と同じ値。
    - `Warning_SmallRoiThresholdVoxels`: 計算したときの警告の基準値。
    - `Warning_SmallRoi`: 小さい ROI なら 1、そうでなければ 0。基準値が空欄なら、この 2 列は空です（0 ではありません）。

    その後ろが特徴量の列で、列名は RadiomicsJ の結果表と同じです（例 `IntensityBasedStatistical_Kurtosis`）。計算できなかった値は `NaN` です。症例ごとのファイルを縦につなげば、そのまま統計ソフトに読み込めます。
- `…_definitions.csv`: 列名ごとの族・特徴・IBSI の識別子・注記の符号（`EXCESS_KURTOSIS`・`LOG2_DISCRETISED`・`NON_IBSI`・`RJ_MORPH_COUNT_IS_INTENSITY`）・離散化。

**設定ファイルを書き出す**

表の上に、版と設定の要約（離散化・リサンプリング・有効な族の数）が出ます。「設定ファイルを書き出す」で、計算に実際に使った設定を RadiomicsJ の設定ファイル（`…_radiomicsj.properties`）として保存します。

- 全部の設定を、既定値も含めて書きます。RadiomicsJ が範囲外の値を直した場合（ビン数 0 → 1 など）は、直した後の値です。
- このファイルの SHA-256 が、CSV の `Provenance_SettingsSha256` と一致します。
- 同じ画像とマスクで、このファイルを RadiomicsJ（ImageJ・コマンドライン）に読ませると、同じ値が出ます。

患者名などの患者情報は、表にも CSV にも入りません。

**計算済みの結果（キャッシュ）**

同じ画像・マスク・設定・RadiomicsJ の版で計算し直すと、保存してある結果がすぐに出ます。表の上に「キャッシュの結果（計算 日時）」と出ます。「計算し直す」を押すと、保存した結果を使わずに計算し、結果を置き換えます。

「取り消す」を押すと、結果を画面に出さなくなります。ただし計算そのものは最後まで続き、結果は保存されます（RadiomicsJ に途中で止める仕組みが無いため）。

関連: [2D ビューア](viewer2d.md) ／ [3D ビューア](viewer3d.md)
