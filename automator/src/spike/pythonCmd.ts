/**
 * スパイクが合成データ・予測値のために呼ぶ Python の起動方法。
 *
 * Windows の `python3` は Microsoft Store の案内だけを出す別名で動かないので、Windows では `python` を使う
 * （環境変数 `GRAPHY_SPIKE_PYTHON` で上書きできる）。隔離モード（`-I`）は利用者領域の site-packages を見ないため、
 * pydicom をそこに入れた機では `GRAPHY_SPIKE_PYTHON_USERSITE=1` で外す（呼ぶスクリプトは同じ階層の自分のもの）。
 */
export const PY = process.env.GRAPHY_SPIKE_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
export const PY_FLAGS: string[] = process.env.GRAPHY_SPIKE_PYTHON_USERSITE ? [] : ["-I"];
