# cxr-dx

NIH ChestX-ray14 の画像 `00000003_000`（PA・1024x1024・8bit）を DX の DICOM に包んだもの。胸部X線レポート生成プラグインの実機確認用。

- 画像の出典: NIH Clinical Center, ChestX-ray14（https://nihcc.app.box.com/v/ChestXray-NIHCC, Wang et al. CVPR 2017）。NIH の FAQ「The usage of the data set is unrestricted」（出典の表示・引用・謝辞が条件）。取得は Hugging Face の timm/nih-chest-xray-14（原画像 1024x1024 を JPEG q95 で再符号化した版）
- DICOM のヘッダは**このファイルのために作った架空の値**（PatientName / PatientID / 日付 / 施設）。匿名化が消すことの確認用で、実在の患者情報ではない
- git 管理しない（.gitignore 対象）
