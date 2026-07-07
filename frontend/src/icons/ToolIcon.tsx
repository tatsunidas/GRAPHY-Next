/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/** ツールアイコン表示コンポーネント。ツール ID かファイル名からアイコンを描画する。 */
import { toolIcon, toolIconUrl } from "./toolIcons";

export function ToolIcon({
  id,
  file,
  size = 18,
  alt = "",
  style,
}: {
  /** TOOL_IDS の値。TOOL_ICON_FILES に登録済みのものを解決する。 */
  id?: string;
  /** tools/ 配下のファイル名を直接指定する場合（レジストリ外のアイコン用）。 */
  file?: string;
  /** 表示サイズ(px)。実解像度より小さく表示すること（高 DPI 対策）。 */
  size?: number;
  alt?: string;
  style?: React.CSSProperties;
}) {
  const src = file ? toolIconUrl(file) : id ? toolIcon(id) : undefined;
  if (!src) return null;
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt={alt}
      style={{ display: "inline-block", objectFit: "contain", verticalAlign: "middle", ...style }}
    />
  );
}
