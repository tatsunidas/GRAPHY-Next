/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { CSSProperties } from "react";

/** 見出しの横に付ける「ⓘ」。説明は `title`（入力欄・チェックの `title` と同じ文）。説明のある項目だと見て分かるようにする。 */
export function InfoMark({ tip }: { tip: string }) {
  return (
    <span data-testid="info-mark" role="img" aria-label={tip} title={tip} style={mark}>ⓘ</span>
  );
}

const mark: CSSProperties = { color: "#5a6672", fontSize: 11, marginLeft: 4, cursor: "help", userSelect: "none" };
