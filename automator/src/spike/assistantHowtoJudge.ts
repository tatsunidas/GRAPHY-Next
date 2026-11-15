/*
 * 「操作の手順」を尋ねる質問と、その回答の機械的な判定。assistantHowtoCheck.ts（実アプリ）と単体テストが使う。
 *
 * 語は docs/*.md の画面の文言（`{.ui}` の語）から取る。創作した画面名・ボタン名を「正しい」としない。
 * 順序は、各語を前の語より後ろで見つけられるか（部分列）で見る。厳密な手順の順ではなく緩い判定。
 */

export interface HowtoCase {
  id: string;
  ask: string;
  /** steps: 文書に答えがある。absent: 文書に無い（「無い」と言い、手順を創作しない）。 */
  kind: "steps" | "absent";
  /** 必須の語。内側の配列は言い換え（どれか 1 つが出ればよい）。 */
  must?: string[][];
  /** true なら must の並びの順に、各語が前の語より後ろに出る。 */
  ordered?: boolean;
  /** 出てはいけない語（文書に無い画面名・ボタン名）。 */
  forbid?: string[];
  /** 根拠の docs。 */
  doc: string;
}

export const HOWTO_CASES: HowtoCase[] = [
  { id: "h-open-ct-today", ask: "今日のテスト花子さんの CT 画像を 2D Viewer で開きたいです。手順を教えてください。", kind: "steps", must: [["患者名"], ["検索"], ["シリーズ"], ["2D Viewer", "2D ビューア"]], ordered: true, doc: "main-screen.md 検査を探す／一覧と選択／ビューアを開く" },
  { id: "h-open-mr-yesterday", ask: "昨日撮った MR の検査を探して 2D Viewer で開く方法を教えて。", kind: "steps", must: [["昨日"], ["モダリティ"], ["検索"], ["2D Viewer", "2D ビューア"]], doc: "main-screen.md" },
  { id: "h-not-listed", ask: "取り込んだ検査が一覧に出ません。どうすればいいですか？", kind: "steps", must: [["全期間"], ["検索"]], doc: "main-screen.md 検査日の既定は「今日」" },
  { id: "h-all-period", ask: "過去の検査も含めて全部探したいです。", kind: "steps", must: [["全期間"], ["検索"]], doc: "main-screen.md" },
  { id: "h-import", ask: "DICOM のフォルダを取り込む手順を教えてください。", kind: "steps", must: [["ファイル"], ["インポート"], ["フォルダ"]], doc: "main-screen.md 検査を取り込む" },
  { id: "h-saved-search", ask: "前に保存した検索条件を呼び出したいです。", kind: "steps", must: [["保存した検索"]], doc: "main-screen.md" },
  { id: "h-save-cond", ask: "今の検索条件を保存するには？", kind: "steps", must: [["条件を保存"]], doc: "main-screen.md" },
  { id: "h-add-column", ask: "スタディ一覧に DICOM タグの列を足したいです。", kind: "steps", must: [["列"], ["辞書", "キーワード", "タグ"]], doc: "main-screen.md 一覧と選択" },
  { id: "h-multi-select", ask: "複数の検査をまとめて選択するにはどうしますか？", kind: "steps", must: [["チェック"]], doc: "main-screen.md 一覧と選択" },
  { id: "h-tree", ask: "検査の一覧をツリー表示に切り替えたいです。", kind: "steps", must: [["ツリー"]], doc: "main-screen.md 一覧の表示形式" },
  { id: "h-hide-preview", ask: "画面下のプレビューを畳みたいです。", kind: "steps", must: [["プレビューを隠す"]], doc: "main-screen.md 画面の構成" },
  { id: "h-open-3d", ask: "選んだシリーズを 3D Viewer で見るにはどうしますか？", kind: "steps", must: [["選"], ["3D Viewer", "3D ビューア"]], ordered: true, doc: "main-screen.md ビューアを開く" },
  { id: "h-compose-preview", ask: "患者名で探して、プレビューで画像を確認してから 2D Viewer で開く手順を教えて。", kind: "steps", must: [["患者名"], ["検索"], ["プレビュー"], ["2D Viewer", "2D ビューア"]], ordered: true, doc: "main-screen.md" },
  { id: "h-missing-name", ask: "患者 ID も患者名も入っていない検査だけを探したいです。", kind: "steps", must: [["未設定"]], doc: "main-screen.md 検査を探す" },
  { id: "h-url-import", ask: "URL から検査を取り込みたいです。", kind: "steps", must: [["URL から取り込む"]], doc: "main-screen.md" },
  { id: "h-accession", ask: "受付番号で検査を絞り込む方法は？", kind: "steps", must: [["受付番号"], ["検索"]], doc: "main-screen.md 検査を探す" },
  // 文書に無い: 「無い」と言う。創作した手順（存在しないボタン）を出さない
  { id: "a-report-print", ask: "レポートを PDF にして印刷する手順を教えてください。", kind: "absent", forbid: ["印刷ボタン", "プリンタ"], doc: "（無い）レポートは説明が未作成" },
  { id: "a-registry", ask: "Windows のレジストリでアプリの自動起動を設定する方法は？", kind: "absent", forbid: ["レジストリエディタ", "regedit", "HKEY"], doc: "（無い）" },
  { id: "a-tag-viewer", ask: "タグ表示で、特定の DICOM タグを検索して値を確認する手順を順番に教えてください。", kind: "absent", forbid: ["タグ検索ボックス", "フィルター欄"], doc: "（無い）タグ表示は説明が未作成（main-screen.md に名前だけ）" },
];

/**
 * 保留セット（b）: 開発セット（上）と別の課題・別の言い方。手順集（docs/howto.md）や検索の調整は開発セットを見て行うので、
 * 調整が質問への過学習でないことをこちらで確かめる。🔴 この組の質問を見て docs や検索を直さない。
 */
export const HOWTO_CASES_B: HowtoCase[] = [
  { id: "b-open-by-id", ask: "患者 ID で検査を探して、2D Viewer で表示するやり方は？", kind: "steps", must: [["患者ID", "患者 ID"], ["検索"], ["2D Viewer", "2D ビューア"]], ordered: true, doc: "main-screen.md" },
  { id: "b-today-list", ask: "今日の検査の一覧を出したいです。", kind: "steps", must: [["今日"], ["検索"]], doc: "main-screen.md 検査を探す" },
  { id: "b-week", ask: "この 1 週間の検査だけを見るにはどうすればいい？", kind: "steps", must: [["1週間", "1 週間"], ["検索"]], doc: "main-screen.md" },
  { id: "b-clear", ask: "入力した検索条件を全部空にしたいです。", kind: "steps", must: [["クリア"]], doc: "main-screen.md" },
  { id: "b-slider", ask: "シリーズの画像をスライダーで順に確認するには？", kind: "steps", must: [["シリーズ"], ["プレビュー"], ["スライダー"]], doc: "main-screen.md 一覧と選択" },
  { id: "b-split", ask: "検査の表の横に、シリーズの一覧をずっと表示しておきたいです。", kind: "steps", must: [["左右", "上下"]], doc: "main-screen.md 一覧の表示形式" },
  { id: "b-album", ask: "アルバムを使って検査を絞りたいです。", kind: "steps", must: [["アルバム"]], doc: "main-screen.md 画面の構成" },
  { id: "b-qr", ask: "ほかの DICOM 機器から画像を取得したいです。", kind: "steps", must: [["Query/Retrieve"]], doc: "main-screen.md／dicom-network.md" },
  { id: "b-open-mpr", ask: "選んだシリーズを MPR Viewer で開きたいです。", kind: "steps", must: [["選"], ["MPR Viewer", "MPR ビューア"]], ordered: true, doc: "main-screen.md ビューアを開く" },
  { id: "b-find-open-3d", ask: "昨日の CT の検査を探して 3D Viewer で開く方法を教えて。", kind: "steps", must: [["昨日"], ["検索"], ["3D Viewer", "3D ビューア"]], ordered: true, doc: "main-screen.md" },
  { id: "b-absent-pw", ask: "ログインのパスワードを変更する手順を教えてください。", kind: "absent", forbid: ["パスワード変更ボタン", "アカウント設定"], doc: "（無い）デスクトップ版にログインは無い（install.md の語は別の意味）" },
];

/** 「文書に載っていない」旨を言っている語。 */
export const ABSENT_PHRASES = ["載っていません", "記載されていません", "記載がありません", "ありません", "見当たりません", "分かりません", "わかりません", "案内できません", "説明は", "お答えできません", "含まれていません", "ドキュメントにはありません"];

/** 道具呼び出しが構造化されず、本文に JSON のまま出た（llama.cpp が解釈しなかった）。 */
export const hasRawToolCall = (text: string): boolean => /propose_steps\s*\{/.test(text);

/** 回答が日本語でない（ひらがな・カタカナ・漢字が 1 字も無い）。日本語の UI なので、英語の回答は失敗にする。 */
export const notJapanese = (text: string): boolean => !/[぀-ヿ㐀-鿿]/.test(text);

export interface Judgement {
  verdict: "pass" | "fail";
  reasons: string[];
}

/** answer = 吹き出しの本文＋手順カードの文。stepsCard = propose_steps のカードを作ったか。 */
export function judgeHowto(c: HowtoCase, answer: string, stepsCard: boolean): Judgement {
  const why: string[] = [];
  const text = answer.normalize("NFKC");
  if (notJapanese(text)) why.push("言語: 回答が日本語でない");
  const norm = (s: string) => s.normalize("NFKC");
  if (c.kind === "absent") {
    if (!ABSENT_PHRASES.some((p) => text.includes(norm(p)))) why.push("「文書に無い」旨を言っていない");
    if (stepsCard) why.push("文書に無いのに手順カード（propose_steps）を作った");
  } else {
    // 順序は「各語を前の語より後ろで 1 回ずつ見つけられるか」で見る（回答は質問の言い換えや、本文と手順カードの二重の記述で
    // 同じ語が何度も出る。最初の出現だけで見ると、正しい手順でも導入の言い換えで落ちる）。
    let at = -1;
    for (const alts of c.must ?? []) {
      const found = alts.map((a) => text.indexOf(norm(a), c.ordered ? at + 1 : 0)).filter((i) => i >= 0);
      if (found.length) at = Math.min(...found);
      else if (alts.some((a) => text.includes(norm(a)))) why.push(`順序が違う: ${alts.join("／")} が前の語より先にしか出ない`);
      else why.push(`必須の語が無い: ${alts.join("／")}`);
    }
  }
  for (const f of c.forbid ?? []) if (text.includes(norm(f))) why.push(`文書に無い語が出た: ${f}`);
  return { verdict: why.length ? "fail" : "pass", reasons: why };
}
