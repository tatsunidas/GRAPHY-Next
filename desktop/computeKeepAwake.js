// 一括の計算の実行中、OS が眠って計算（特に Colab のランタイム）を止めないようにする。
// powerSaveBlocker を注入できる形にしてある（単体テスト用）。ブロッカーは常に 1 つだけで、解放を取りこぼさない。
function create(powerSaveBlocker) {
  let id = null;
  const active = () => id !== null && powerSaveBlocker.isStarted(id);
  return {
    /** 眠りを止める／止めない。返すのは「いま実際に止めているか」（画面はこれを見て表示する）。 */
    set(on) {
      if (on) {
        if (!active()) id = powerSaveBlocker.start("prevent-app-suspension");
      } else if (id !== null) {
        if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
        id = null;
      }
      return active();
    },
    active,
  };
}

module.exports = { create };
