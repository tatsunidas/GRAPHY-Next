/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { httpGet } from "../http";
import type { FacilityResponse } from "./facilityView";

/** 未設定は 204（undefined）。内容は検証を通した構造だけで、ファイルの生の内容は返らない。 */
export const fetchFacilityConfig = () => httpGet<FacilityResponse | undefined>("/api/facility/config");
