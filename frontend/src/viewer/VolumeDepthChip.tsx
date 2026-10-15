/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { CSSProperties } from "react";
import { useI18n } from "../i18n/i18n";
import type { VolumeDepthNote } from "./depthVolume";

/** 3D / MPR のヘッダに出す、奥行きの決め方の注記。言うことが無いとき（IPP で均一）は何も出さない。 */
export function VolumeDepthChip({ note, style }: { note: VolumeDepthNote | null; style: CSSProperties }) {
  const { t } = useI18n();
  if (!note) return null;
  const text =
    note.id === "missing"
      ? t("volumeDepth.missing", { n: String(note.n) })
      : note.id === "irregular"
        ? t("volumeDepth.irregular", { from: String(note.from), to: String(note.to), spacing: note.spacing.toFixed(2) })
        : t(`volumeDepth.${note.id}`);
  return (
    <span style={style} title={t(`volumeDepth.${note.id}Hint`)} data-testid="volume-depth-note">
      {text}
    </span>
  );
}
