/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 取り込んだ文字列に、患者識別子らしきものがあるかの目安。誤検出も見落としもある（保証ではない）。自動マスクはしない。
const PATTERNS: RegExp[] = [
  /\b(patient\s*(name|id)|PatientName|PatientID|MRN|DOB|BirthDate)\b\s*[:=：]/i,
  /(患者(氏名|名|ID)|カルテ番号|生年月日|診察券)\s*[:：=]?/,
  /\b(19|20)\d{2}[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b.*(生|birth)/i,
  /\(0010,\s*00(10|20|30)\)/,
];

export function looksLikeIdentifiers(text: string): boolean {
  return PATTERNS.some((p) => p.test(text));
}
