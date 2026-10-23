import { useState } from "react";
import { useI18n } from "../i18n/i18n";
import { parseJumpIndex } from "./jumpIndex";

/**
 * 番号を指定して移動する小さな入力。スライダーでは 1 コマ単位の位置決めがしにくいので、
 * 1 起点の番号を打って Enter で移動する（Esc で取り消し）。現在位置の表示（`n/N`）は別にあり、
 * ここは空のまま置く。キー入力はビューアのショートカット（矢印・数字キー）に渡さない。
 */
export function IndexJump({
  count,
  onJump,
  disabled,
  testId,
}: {
  count: number;
  onJump: (index: number) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  return (
    <input
      type="text"
      inputMode="numeric"
      data-testid={testId}
      value={text}
      disabled={disabled || count <= 1}
      placeholder="#"
      title={t("series.jump.title", { max: count })}
      aria-label={t("series.jump.title", { max: count })}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          const next = parseJumpIndex(text, count);
          if (next != null) onJump(next);
          setText("");
        } else if (e.key === "Escape") {
          setText("");
        }
      }}
      style={{ width: "3.6em", fontSize: 12, textAlign: "right" }}
    />
  );
}
