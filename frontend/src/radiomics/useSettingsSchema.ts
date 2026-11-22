/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";

import { getRoiFeatureSettingsSchema } from "../api";
import type { SettingSchemaEntry } from "./advancedSettings";

/** 一覧は版（RadiomicsJ）で決まり、アプリの実行中は変わらないので、1 回だけ読んで使い回す。読めなかったときは undefined（検査は形だけ）。 */
let cached: SettingSchemaEntry[] | undefined;
let pending: Promise<SettingSchemaEntry[] | undefined> | null = null;

function load(): Promise<SettingSchemaEntry[] | undefined> {
  if (cached) return Promise.resolve(cached);
  pending ??= getRoiFeatureSettingsSchema()
    .then((s) => (cached = s))
    .catch(() => undefined)
    .finally(() => { pending = null; });
  return pending;
}

export function useSettingsSchema(): SettingSchemaEntry[] | undefined {
  const [schema, setSchema] = useState<SettingSchemaEntry[] | undefined>(cached);
  useEffect(() => {
    let alive = true;
    void load().then((s) => alive && setSchema(s));
    return () => { alive = false; };
  }, []);
  return schema;
}
