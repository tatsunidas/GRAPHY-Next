# フーリエ解析（2D-DFT）設計

> 2D Viewer > 解析 > **フーリエ解析…**。2026-09-17 追加（`feat/fourier-analysis`）。
> 連載「GRAPHY-Next で学ぶ医用画像処理」の教材としても使う想定。

## 1. 要件（利用者と合意済み）

| 項目 | 決定 |
| :- | :- |
| 対象 | **選択シリーズで表示中のスライス 1 枚のみ**（スタックで束ねない）。対象タイルは `resolveTargets()[0]` |
| RGB | 輝度化（`readModalitySlice` の BT.601）→ **丸めて 0〜255 の 8bit グレー** |
| パディング | **2 のべき乗の正方形**へ**平均値**で埋め、**左上に置く**（ImageJ の Process > FFT と同じ。係数が ImageJ の Complex Fourier Transform と一致する）。逆変換は元サイズへ切り戻す |
| 表示 | 実数成分 \|Re\|・虚数成分 \|Im\|（絶対値）・振幅 \|F\|。log 表示切替。**四象限入れ替え**（fftshift）切替 |
| 2D-DFT / 2D-iDFT | 両方。iDFT は「自動更新」と「実行」ボタン |
| 基底関数 | 座標 (u,v) ごとのスタック（スライダー＝ index `v·N+u`）。**純粋な基底**と**係数で重み付け**（実寄与）の切替。スペクトル上に十字で位置を表示・クリックで選択 |
| フィルタ | 長方形（**内側除去のみ**、縦=全高で x 方向だけ移動／横=その逆、中心対称ミラー既定 ON）・円形（∧/!∧、半径可変）・ドーナツ（∧/!∧、半径と幅可変） |
| ガウシアン σ | **ノイズではなく、マスクの縁をなだらかにする幅**（px）。σ=0 で階段 |
| 書き出し | 32-bit float TIFF: \|Re\|・\|Im\|（入れ替え表示中なら入れ替え後の向き、log なし）・逆変換画像・現在の基底。**フィルタ適用中はすべて適用後**（\|Re\|・\|Im\| はマスク積、重み付き基底は F·m(u,v)。ファイル名に `_filtered`）。**Re・Im スタック（符号付き・ImageJ で逆変換可）**＝係数そのものの Re・Im を **ImageJ の「Complex Fourier Transform」と同じ形**で保存（2 ページ 32-bit、**常に四象限入れ替え後**、スライスラベル `Real` / `Imaginary`、プロパティ ` `=`Complex Fourier Transform`・`Original width/height`、Show Info に numpy の手順）。ImageJ で開いて **Process > FFT > Inverse FFT** で元サイズの画像に戻る。使うマスクは**最後に計算した逆変換と同じもの**（自動更新 OFF で未実行の変更はプレビュー同様まだ入らない）（利用者要望 2026-09-17） |
| 保存 | **新規シリーズとしては保存しない** |

## 2. 構成

| ファイル | 役割 |
| :- | :- |
| `frontend/src/viewer/fourier.ts` | 純関数: パディング/切り戻し、radix-2 FFT（1D→行・列）、fftshift、マスク、基底、`toGray8` |
| `frontend/src/viewer/fourierWorker.ts` / `fourierProtocol.ts` | Worker。**スペクトル（非シフト Float64）を Worker 内に保持**し、inverse/basis は保持分に対して計算 |
| `frontend/src/viewer/tiffFloat32.ts` | 無圧縮 LE・1 ストリップの 32-bit float TIFF（SampleFormat=3） |
| `frontend/src/viewer2d/FourierDialog.tsx` | UI。入力は `actions.getPixelData(tileId)`（H3 と同じ経路＝ThickSlab/DSA の合成スライスも表示どおり、校正はルール 2 どおり） |
| 接続 | `Viewer2DMenuBar`（`testId: menu-fourier`）→ `ViewerActions.openFourier` → `Viewer2DScreen` |

## 3. 数式の約束

- 順変換は係数そのまま（核 e^{-i}）、**逆変換で 1/N²**。
- 座標は 2 系統。**マスク・基底座標はシフト後**（DC = (N/2, N/2)、周波数 = index − N/2）。
  非シフト index = `(i + N/2) % N`（N は偶数なので fftshift は自己逆）。
- マスク: 縁までの符号付き距離 d（外側が正）→ 内側らしさ `Φ(−d/σ)`（erf 近似）。
  畳み込みなしで「二値マスクをガウシアンでぼかした縁」と同じ形になる。
- 長方形はミラー ON で DC 点対称 → 逆変換が実数に保たれる（虚部最大をダイアログに表示）。
  ミラー OFF では虚部が出るので「絶対値」表示に切り替えて見る。
- 重み付き基底 = `Re(F(u,v)·e^{i2π(fx·x+fy·y)/N}) / N²`。**全座標の和が（パディング後の）元画像**（vitest で固定）。

## 4. 制約

- パディング後 **4096² を超える**画像は処理しない（メッセージ表示）。4096² は Float64 の複素 2 枚で約 270MB。
- 基底・マスク・書き出しの基底画像は**パディング後の N×N**（元画像サイズではない）。
- スペクトルの枠（SVG）は**入れ替え ON のときだけ**描く。OFF でも除去域の赤は出る。
- 長方形の位置は `rectCenterLimit(n, width)` で **|center| ≤ floor(n/2 − 0.5 − width/2)** に収める（ドラッグ・スライダー・幅変更のすべて）。帯も枠もスペクトルからはみ出さない（利用者要望 2026-09-17）。
- 基底の初期座標は **DC（u = v = N/2）**＝十字線がスペクトル中央（利用者要望 2026-09-17）。

## 5. 検証

- vitest: `fourier.test.ts`（往復・cos 波のピーク位置・fftshift・パディング・マスク・基底の和・ローパス）／`tiffFloat32.test.ts`。
- 実機: `automator/src/spike/fourierCheck.ts`（ct-basic）**36/0**（2026-09-17、利用者の実機確認後の修正 2 件込み）。
  開く→iDFT が原画像と一致→表示切替 3 種→円形 ∧/!∧・半径・σ→ドーナツ幅→長方形の**斜めドラッグで x 位置だけ動く**→横モード→
  基底スライダー・**スペクトルのクリックで (−10, 7)**・重み付け→TIFF 4 種のヘッダ→スライスを送って再取得。
- **ImageJ 1.54p（`~/ImageJ`）で実証（2026-09-17）**:
  - ImageJ 自身の `FFT Options… complex` の出力と GRAPHY の Re・Im スタックの係数が**相対誤差 8.5e-8 で一致**（中央置きのパディングでは一致しなかった＝位相がずれる → 左上置きへ変更した理由）。
  - GRAPHY の TIFF を ImageJ で開き **Inverse FFT** → 300×220 に切り戻され、**元画像と最大誤差 3e-4**。フィルタ適用後の TIFF も GRAPHY の iDFT と最大誤差 2.4e-4。
  - ImageJ は title ではなく**スタック 2 枚＋1 枚目のラベル `Real`** で複素逆変換を選び、切り戻しは `Original width/height` プロパティを読む（`ij.plugin.FFT` を javap で確認）。
  - numpy: `ifft2(ifftshift(Re+1j·Im))[0:h, 0:w]` で最大誤差 2.4e-5。
- TIFF の複数ページは ImageJ 流: 1 枚目に `ImageJ=…images=2 slices=2`、画素は**連続配置**（ImageJ は連続を前提に読む）。
  Info・ラベル・プロパティは ImageJ の独自タグ 50838/50839（"IJIJ" ヘッダ＋`info`/`labl`/`prop` ＋UTF-16、ファイルのバイト順）。
- ⚠ **未検証**: RGB（US/SC）での 8bit 化の見た目、MR、4096² 近い大画像の所要時間。
