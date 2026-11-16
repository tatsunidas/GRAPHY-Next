# 幾何検証（ROI・マスク・計測）の検査 8 本

ROI・マスク・計測の値が、患者座標（LPS、mm）の真値と合うことを、実アプリ（Radiomics は backend のみ）で確かめる検査群。
真値は合成ファントム（`scripts/make-geom-*-phantom.py` の `truth.json`）の解析形状で、アプリの座標変換・統計の式は真値に使わない。
**約束する内容と許容の導出は、各 spike の冒頭コメントと検査項目を参照**（この文書には写さない）。

| 検査 | 対象の機能 | ファントム ID | 所要時間（2026-11-16 実測 1 回） | 個別の実行 |
|---|---|---|---|---|
| Roi（`geomRoiCheck.ts`） | 2D ROI・計測の値と表示位置 | `g0_iso` `g1_aniso` | 139 秒 | `GEOM_IDS=g0_iso,g1_aniso` |
| Mask（`geomMaskCheck.ts`） | マスク（ROI→マスク・Wand・3D 球・しきい値）の位置・体積・重心 | `g1_aniso` | 175 秒 | `GEOM_IDS=g1_aniso` |
| Export（`geomExportCheck.ts`） | SEG・RTSTRUCT・ImageJ・CSV の書き出しと取り込み | `g1_aniso` | 151 秒 | `GEOM_IDS=g1_aniso` |
| Calib（`geomCalibCheck.ts`） | 空間校正・輝度校正（Rescale・SUV）が値に効くか | `make-geom-calib-phantom.py` の全ケース | 549 秒 | 既定 |
| Radiomics（`geomRadiomicsCheck.ts`） | Radiomics の形状・一次統計とマスク対応 | `g0_iso`〜`g5_reversed` の 7 本 | 72 秒 | `GEOM_PORT=18970` |
| Mpr（`geomMprCheck.ts`） | MPR の位置・縮尺・縦横比・チルト補正 | `g0_iso` `g1_aniso` `g2_oblique` `g3b_tilt_iop` | 199 秒 | `GEOM_DRIVER=desktop GEOM_IDS=... MPR_SIZES=default,1280x800` |
| XaSeed（`geomXaSeedCheck.ts`） | 幾何の無い画像（XA）・有る画像（CT）の Wand シードと ROI 統計 | `XA_iso` `XA_aniso` `CT_aniso` | 376 秒 | 既定 |
| XaIo（`geomXaIoCheck.ts`） | 同上の ROI の ImageJ 書き出し／取り込み／コピー＆貼り付け | `XA_iso` `XA_aniso` `CT_aniso` | 151 秒 | 既定 |

基準の件数（合格 / 失敗 / 未達）: Roi 36/0/0、Mask 52/0/1、Export 99/0/0（参考 21）、Calib 147/0/0、Radiomics 210/0/42、Mpr 182/0/1、XaSeed 84/0/0、XaIo 105/0/0。合計の所要は約 30 分。

## 実行方法

前提: `backend/target/graphy-next-backend.jar`（`mvn -Dfrontend.skip=true -DskipTests package`）、`desktop/` と `frontend/` の `npm ci`、画面（ヘッドレスなら `xvfb-run -a`）、
Python 依存（`python3 -m pip install -r scripts/requirements-geom.txt`。venv 推奨で、その python を `GRAPHY_TEST_PYTHON` に渡す）。

```bash
cd automator
bash scripts/run-geom-verify.sh                       # 8 本を 1 本ずつ
GEOM_ONLY=Roi,Mask bash scripts/run-geom-verify.sh    # 一部だけ
```

- アプリの検査は並行すると壊れるので 1 本ずつ。ポートは検査ごとに分ける（HTTP、SCP=+1、Vite=+3）: Roi 18900、Mask 18910、Export 18920、Calib 18930、Mpr 18940、XaSeed 18950、XaIo 18960、Radiomics 18970。
- 実行前に Python 依存を事前チェックする（版まで一致を見る）。不足なら使われる Python（`sys.executable`）と導入コマンドを出して止まる。環境は書き換えない。
- 結果: `.results/geom-verify/<検査名>.log`・`<検査名>.json`・`summary.txt`。終了後にポートの残りがあれば全体を失敗にして PID を出す。

## 結果 JSON と終了コード

```json
{ "name": "Mask", "passed": 52, "failed": 0, "unreached": 1, "info": 0,
  "failures": [], "unreachedNames": ["..."], "exitCode": 0, "finishedAt": "..." }
```

- 失敗が 1 件以上、または例外 → 終了コード 1（例外のときは JSON に `error`）。それ以外は 0。
- **未達は終了コードに入れない**（表示と JSON の記録のみ）。参考（情報）は合否にも未達にも入れない。
- 負例（`GEOM_NEG`・`CALIB_NEG` など）は「落ちること」が合格で、JSON は書かない。
- 一括実行は、どれかが 非 0・JSON なし・タイムアウト・ポートの残りなら全体 1。
