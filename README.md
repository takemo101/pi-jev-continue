# pi-jev-continue

Jev の判定で pi の開発ループを継続する extension。実装・調査・コマンド実行は pi のモデルが担当し、Jev は次の作業種別と継続条件だけを判断します。

通常の継続回数は **無制限**。指定した目標の範囲で、実装 → 検証 → 修正・改善を繰り返します。Jev が判断できない場合や人の入力が必要な場合まで強制的に回し続けるものではありません。

## 必要なもの

- **pi 0.87.1 以降**の `@earendil-works/pi-coding-agent`。動作確認版は 0.87.1。
- Node.js 24.12 以降。
- pi の開発用モデルとその認証。
- TypeSafe の `TYPESAFE_API_KEY`。pi のモデル用 API キーとは別です。

旧 `@mariozechner/pi-coding-agent` 向けの互換コードは含めていません。`agent_before_settle` を提供する pi が必要です。

## インストール

このディレクトリの親から実行します。

```bash
pi install ./pi-jev-continue
```

起動中の pi では `/reload`。グローバル設定に追加せず試す場合は、開発対象のディレクトリで次のように起動します。

```bash
export TYPESAFE_API_KEY='your-typesafe-api-key'
pi -e /absolute/path/to/pi-jev-continue/src/index.ts
```

パッケージの公開・ユーザーの pi 設定への自動インストールは行っていません。実行時の追加 npm 依存はなく、pi が TypeScript を読み込みます。`.env` は自動ロードしないので、キーは起動する pi の環境に渡してください。

## 対話モード

```text
/jev-on このリポジトリのCSVパーサーを完成させ、境界値テストを実行し、エラー処理を改善する。公開APIは変更しない。
```

有効化すると、その目標で最初の開発ターンも開始します。各反復の末尾で pi に「実施内容・実行証拠・人に依存する障害・具体的な次の作業」を報告させ、その報告を Jev が評価します。

| コマンド | 動作 |
| --- | --- |
| `/jev-on <目標>` | 目標を設定し、カウンターをリセットして開始。実行中の目標変更は拒否 |
| `/jev-on` | 同じセッションで直前に指定した目標を再開。カウンターはリセット |
| `/jev-off` | 自動継続を停止。判定中の Jev リクエストも中断 |
| `/jev-status` | 有効状態・継続回数・上限・直近の状態・目標を表示 |
| `/jev-max <n>` | 自動継続回数の上限を設定。`0` は無制限。カウンターはリセットしない |

上限は「最初の実行を除いた自動継続回数」です。`/jev-max 10` なら最初の実行＋最大10回の継続。最初は小さい上限で挙動を確認することを推奨します。

フッターには `Jev on 3/unlimited: verify` のように表示します。手動で通常のメッセージを入力した場合は、その入力を優先して自動継続を解除します。再開は `/jev-on`。

### 停止とセッション

- **Escape**: TUI の自動継続と判定を停止し、pi 本来の中断操作も通します。
- **`/jev-off`**: 自動継続を止めます。実行中の開発用モデルやツール自体は中断しないため、それも止める場合は Escape を使ってください。
- `/new`、セッション切替、fork、tree 移動、reload、再起動後は、自動では再開しません。目標と上限もセッション開始時に初期化します。
- RPC では `prompt` コマンドで `/jev-off` を送ると、Jev 判定中でも直ちに停止できます。
- **pi 0.87.1 の RPC `abort` 制約**: 判定境界では `ctx.signal` が提供されないため、ネイティブ `abort` だけでは Jev の HTTP 待ちを直ちに中断できません。次の開発ターンは開始されませんが、応答または30秒のタイムアウトまで settlement が遅れます。判定も即時中断するには `/jev-off` を使用してください。

## 非対話モード

開発対象のディレクトリで実行します。

```bash
export TYPESAFE_API_KEY='your-typesafe-api-key'
pi -e /absolute/path/to/pi-jev-continue/src/index.ts \
  --jev-goal 'CSVパーサーを実装・検証し、公開APIを維持してエラー処理を改善する' \
  --jev-max 10 \
  --print '目標に沿って開発を開始してください'
```

`--jev-max 0` または省略で無制限です。`--jev-goal` は起動後の最初のプロンプトで有効になります。flag だけではモデル実行を開始しないので、非対話モードではプロンプトも渡してください。通常の入力が pi の実行を開始するため、キー不足で自動継続を有効化できなかった場合も、その通常入力の処理は行われます。

環境変数:

| 名前 | 用途 |
| --- | --- |
| `TYPESAFE_API_KEY` | TypeSafe の Bearer 認証キー。必須 |
| `TYPESAFE_MODEL` | Jev のモデル名。既定は `jev-1.13.0` に固定 |

モデルやしきい値の変更後は、実際の開発報告を使って判定を再評価してください。特に日本語の判定品質はこのパッケージでは実測していません。

## 判定と制御

`agent_end` のたびにタイマーでメッセージを送り込むのではなく、pi の最終的な継続判断境界 `agent_before_settle` を使います。1回の HTTP リクエストで3問を並列評価します。

| 質問 | 型 | 継続条件 |
| --- | --- | --- |
| 最新報告で提案された次の具体的な作業は何か | Choice | `implement` / `fix` / `verify` / `improve` で、confidence ≥ 0.85 |
| 未提供の人の判断・情報・認証・承認が必要か | Noul | `needs_human` ≤ 0.10 |
| 提案された作業は指定目標に含まれるか | Noul | `in_scope` ≥ 0.90 |

すべて満たした場合のみ、コードで選んだ作業指示を次ターンに追加します。Jev 自体にはコードや次の指示文を生成させません。`other`、低確信度、目標外、必要な人の入力があれば停止します。具体的で有用な次の作業がなくなった場合も停止します。

以下も停止条件です。

- Jev の HTTP エラー・不正応答・30秒のタイムアウト。extension 独自の自動リトライはしません。
- pi の失敗・中断、または完了していない assistant 応答。pi 本体の既存リトライ・圧縮は、この判定境界より前に処理される場合があります。
- ユーザー入力・待機中のメッセージ・設定した継続上限。
- 報告の欠落・過大な判定入力。

別の extension がすでに継続を要求している境界では、重ねて Jev を呼びません。ただし他 extension のループを制御するものではないため、`pi-auto-continue` など同種の自動継続 extension は無効にして使ってください。

## 外部送信と安全性

`/jev-on` または `--jev-goal` を使うと、次の情報を **`https://api.typesafe.ai/v1/systemone` に送信**します。

- 指定目標（最大4000文字）。
- 最新の assistant 報告（最大12000文字）と前回の報告。
- 最新ユーザーメッセージ以降の直近6件のツール結果。ツール名・失敗フラグ・テキスト出力の先頭2000文字・省略フラグ。
- コードで計算した反復番号。

thinking、画像、ツール引数、tool details、セッション全履歴は送信しません。JSON 化した state 全体にも24000 UTF-8バイトの上限を設けます。目標・報告・state が上限を超えた場合は、判断材料を黙って切り捨てず停止します。ツール出力だけは明示的に省略します。

**ツール結果や報告に秘密情報が含まれていれば、それも送信され得ます。自動的な秘密情報の除去は保証しません。** 機密リポジトリで有効にする前に、TypeSafe への送信可否を確認してください。

Jev の確信度は正しさの保証ではありません。報告やツール出力内の指示を無視するよう質問を設計していますが、プロンプトインジェクションを防ぐセキュリティ境界ではありません。また判定は反復終了後なので、その反復内の危険なツール実行を個別に承認・阻止する仕組みではありません。

無制限モードは pi と Jev の API 利用・ファイル変更を継続できます。分離した作業ディレクトリ、バックアップ、pi 側の権限制御、必要なら継続上限を併用してください。

## ログと開発

セッションに次の custom entry を保存します（`--no-session` ではメモリ内のみ）。

- `jev-judgment`: 選択した action、停止理由、元の answers と確率分布、実モデル名、usage。
- `jev-continue-state`: 有効化・停止時の状態、目標、継続カウンター。

これらはモデルの会話コンテキストには挿入しません。TypeSafe の usage は記録しますが、pi の開発用モデルの料金表示には合算しません。永続ログから自動運転を復元することもありません。

```bash
npm ci --ignore-scripts
npm run check
npm test
```

実装は `src/index.ts`（pi ライフサイクル）、`src/state.ts`（入力抽出・制限）、`src/jev.ts`（HTTP・質問・判断ポリシー）に分離しています。

### 保守時の変更箇所

| 変更したい内容 | 主な場所 |
| --- | --- |
| コマンド・pi イベントへの反応 | `src/index.ts` の各登録ハンドラー |
| 非同期判定の中断・結果適用 | `src/index.ts` の `evaluateContinuation` と `cancelRequest` |
| 継続上限の入力形式 | `src/index.ts` の `parseContinuationLimit`（CLI とコマンドで共有） |
| 既定モデル・判定タイムアウト | `src/index.ts` の `DEFAULT_MODEL` / `JUDGMENT_TIMEOUT_MS` |
| 外部送信する入力と上限 | `src/state.ts` の `buildState` / `INPUT_LIMITS` |
| Jev への質問 | `src/jev.ts` の `questions` |
| Jev 応答の形式・整合性の検証 | `src/jev.ts` の `parseResponse` / `ParsedResponse` |
| 継続・停止の判断と優先順位 | `src/jev.ts` の `applyPolicy` としきい値定数 |

保守時も、次の不変条件を維持してください。

- 停止・再開・セッション切替では、HTTP の中断に加えて世代番号を更新し、古い応答で新しい実行を操作しない。
- `await` の前後の確認は単なる重複ではない。判定中の入力・上限変更・中断を結果適用前にも確認する。
- 応答形式の検証と運用ポリシーは分離する。不正応答は例外で停止し、正常な回答による停止は `action: "stop"` として記録する。
- 質問文・しきい値の変更は挙動変更として扱う。単なる整理では、既存の質問・しきい値・停止理由の優先順位を変えない。

### 検証

検証範囲:

- 型チェックと64件のテスト成功。決定ポリシーの境界値、不正応答、入力制限、停止時の競合、セッション遷移を検証。
- 実 pi 0.87.1 の読み込み、および外部モデル応答だけを固定したオフライン実行で、ファイル作成 → 自動継続 → Node による実行検証 → 停止を確認。
- 実 TUI で `/jev-on` による開始、および通常・Kitty 形式の Escape による判定中断を確認。
- 実 RPC で `/jev-off` とネイティブ `abort`、JSON モードで継続上限と HTTP エラー時の停止を確認。
- **TypeSafe の実 API による判定精度・しきい値校正は未検証**。開発環境にキーがなく、テストは固定応答に対する制御の検証です。

## 参考

- [Building with Jev skill](https://github.com/dbreunig/building-with-jev-skill/blob/main/skills/jev/SKILL.md)
- [pi-auto-continue](https://github.com/latent-variable/pi-auto-continue/)
- [pi extension API](https://pi.dev/docs/latest/extensions)
- [TypeSafe HTTP API](https://docs.typesafe.ai/api)
- [Jev モデルと制限](https://docs.typesafe.ai/models)
