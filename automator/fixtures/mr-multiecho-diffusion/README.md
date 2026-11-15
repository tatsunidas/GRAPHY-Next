# fixtures/mr-multiecho-diffusion

MRシリーズ（multi-echoまたはdiffusion、C次元を持つ）。5D C/T切替検証用。

- 最低ファイル数: 1
- 実データはこのフォルダ直下に置く（サブフォルダ可）。git管理対象外（.gitignore）。
- 配置確認: `npm run automator -- check-fixtures --category mr-multiecho-diffusion`
- 実データが無いときの代替（合成のマルチエコー MR、既知の T2）: `python3 automator/scripts/make-t2-phantom.py <出力> --form channels --truth`
