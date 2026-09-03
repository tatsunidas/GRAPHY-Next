# 移植元について

このディレクトリ配下の `com/vis/uvs/{analysis,common,video}/**` は、非公開リポジトリ
**`tatsunidas/UltrasoundVideoSummarization-Web`** の `backend/src/main/java/com/vis/uvs/**`
から**そのまま持ち込んだもの**（2026-09-03 時点）。

🔴 **書き直していない。** 理由は `fw/uvs-plugin-design.md` §5 のとおり——
乱数シード（76 / 123）・消費順序（幅→高さ→X→Y）・ImageJ の丸め規則・非加重グレースケール・
Farnebäck のパラメータのどれか 1 つでも変わると、**学習済みモデルが不整合になる**。
書き直しは「同じつもりで別の量を作る」危険が高い。

## 持ち込んだもの

| パッケージ | 中身 |
| :- | :- |
| `analysis/flow/` | Farnebäck（408 行）・平滑化・パラメータ |
| `analysis/roi/` | ボックス生成・スコア・特徴・k-means クラスタリング |
| `analysis/candidate/` | 候補領域抽出の入口 |
| `common/Indices` | 0/1-based の集約 |
| `video/Frame` | rgb24 フレームの器 |
| `analysis/AnalysisSettings` | 定数 |

## 依存（すべて**本体が持っている**ので同梱しない）

`commons-math3 3.6.1`（Farnebäck の LU 分解）／`ij 1.54p`（ROI 幾何）／`slf4j-api`。
プラグインのクラスローダは親（アプリ）優先なので、そのまま解決される（段 2 で実測）。

## 変えたところ

**パッケージ名は変えていない**（`com.vis.uvs.*` は本体の `com.vis.graphynext.*` と衝突しない）。
上流を取り込み直すときに差分が読めるよう、**素のまま置く**。
