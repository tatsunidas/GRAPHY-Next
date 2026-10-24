/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { httpGet, httpSend } from "../http";
import type { ReceiveAnonProfile, ReceiveAnonView } from "./receiveAnonView";

/** web モードでは 404（受信は standalone のみ）。 */
export const fetchReceiveAnon = () => httpGet<ReceiveAnonView>("/api/dicom/receive-anonymize");

export const saveReceiveAnon = (enabled: boolean, profile: ReceiveAnonProfile) =>
  httpSend<ReceiveAnonView>("/api/dicom/receive-anonymize", "PUT", { enabled, profile });
