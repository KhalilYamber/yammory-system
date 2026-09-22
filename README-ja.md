<div align="center">

# yammory_system

**アシスタントは、もう知っているはずのことを、あなたに尋ねなくなる。**

セッションをまたいであなたを覚えています。各分野でどこまで深く理解しているか、どんな話し方を望むか、すでに決着したことは何か。そして、あなたの承認なしに書き込みが着地することはないので、あなたについての何かが、あなたの知らないうちに保存されることはありません。

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/dsh--plugin-✅-green)](https://github.com/topics/dsh-plugin)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](#compatibility)
[![CI](https://img.shields.io/github/actions/workflow/status/KhalilYamber/yammory-system/ci.yml?branch=main&label=CI)](https://github.com/KhalilYamber/yammory-system/actions)
[![Version](https://img.shields.io/github/v/tag/KhalilYamber/yammory-system?label=version)](https://github.com/KhalilYamber/yammory-system/releases)

[简体中文](README.md) · [English](README-en.md) · [日本語](README-ja.md) · [Русский](README-ru.md)

<sub>配布チャネルは GitHub のみです。npm パッケージも、マーケットプレイスへの掲載もありません。</sub>

</div>

---

## Why this exists

有能なアシスタントも、記憶を失ったアシスタントでしかありません。セッションが始まるたびに、すべてが振り出しに戻ります。あなたが固有ベクトルをすでに理解していてテンソルネットワークには一度も触れたことがないこと、励まされるより訂正されたいこと、三週間前にあの道を取らないと決めたことを、知りません。だからあなたは何度も自己紹介をやり直すことになり、面白いところから始められたはずの会話が、ゼロから始まります。

`yammory_system` は、そうした知識を保持する場所と、推測せずにそれを使う方法を DeepSeek Harness に与えます。メモリ倉庫との違いは三つです。

- **検索する前に、どう話すかを決めます。** 七つのファセットからなるプロフィールが領域別の知識レベルを携えているので、アシスタントは答える前に、あなたが受け取れる語彙を知っています。注入はプロンプトの組み立て時に行われ、検索の段階の後ではありません。
- **あなたなしには何も書かれません。** すべての書き込み経路は、ツール層ではなくサービス内部で DSH 自身の承認ゲートを通されます。拒否された書き込みも痕跡を残します。無言の書き込みは、このプラグインが到達しうる状態ではありません。
- **その仕事をあなたが検査できます。** モデルが見たものはすべて記録され、ストアはあなたが閲覧・エクスポート・監査できる素の SQLite ファイルであり、ある種の誤りは自制ではなく設計によって防がれます。

## Install

```sh
# 1. install the bundle into your profile
dsh plugin --profile web add "github:KhalilYamber/yammory-system#main"

# 2. restart, then verify the row
dsh --profile web --dump-config | grep -A3 'id: yammory_system'
```

その他のチャネルと削除方法：

- **git channel**（最新の `main`）：`dsh plugin --profile web add git+https://github.com/KhalilYamber/yammory-system.git`。
- **tarball channel**：このリポジトリで `npm pack` を実行し、続けて `dsh plugin --profile web add ./yammory_system-<version>.tgz` を実行します。
- **uninstall**：`dsh plugin --profile web remove yammory_system`（メモリデータベースとセッションログは保持されます）。

## The first minute

再起動後、何も設定しなくても次のものが見えるはずです：

| 場所 | 内容 |
|---|---|
| サイドバー下部 | 設定の隣にある**メモリ**の項目（クリックでドロワーを開閉します。`panel.enabled` で隠せます） |
| 会話ヘッダー | セッション単位のメモリスイッチ。オフにすると、そのセッションの注入・想起・書き込み・観察が止まります |
| サイドバー下部 → その項目 | ドロワー：トラックとレイヤー別のエントリ一覧、検索、警告ラインの使用量、直近の監査、三つの可観測性の数値、そして作業をバックグラウンドへ渡す **Tidy the whole library** ボタン（ヘッドレスセッションを 1 回起動し、戻ってくるのはステータス行 1 行とバッチ id だけです） |
| DSH 設定 → `yammory-system` | すべての設定項目。それぞれに疑問符が付き、平易な言葉で説明されます |
| `/memory` | `list`、`query`、`stats`、`audit`、`session on\|off`、`export` / `import <path>`、その他多数 |

## Table of contents

- [Why this exists](#why-this-exists)
- [Install](#install)
- [The first minute](#the-first-minute)
- [How it works](#how-it-works)
- [Capabilities](#capabilities)
- [Compatibility](#compatibility)
- [Configuration](#configuration)
- [Tools & surfaces](#tools--surfaces)
- [MCP server](#mcp-server)
- [Permissions & data](#permissions--data)
- [Security boundaries](#security-boundaries)
- [Known limitations](#known-limitations)
- [How it's different](#how-its-different)
- [dsh-memory-protocol v1](#dsh-memory-protocol-v1)
- [What we learned from the terminal memories](#what-we-learned-from-the-terminal-memories)
- [Development](#development)
- [Topics](#topics)
- [Contributors](#contributors)
- [Upstream](#upstream)

## How it works

`yammory_system` は機能のシームであり、もう一つのメモリ倉庫ではありません。型付きの `ctx.memory` サービス、ローカルの SQLite プロバイダー（`node:sqlite`、WAL、`0600`、`$DSH_HOME/dsh-memento/memory.db`）、そしてその利用側である `memory` ツールと、システムプロンプトに注入される凍結スナップショットです。

二つのトラック × 二つのレイヤー × agent 単位のキー。`user` トラック（ユーザーに関する事実）と `agent` トラック（環境の事実と約束事）があり、それぞれが `user-global` と `workspace` のレイヤーに分かれ、`agentPreset` ごとに隔離されます。スナップショットはセッションごとに最初のプロンプト組み立て時に一度だけ凍結され、セッションの途中で変わることはありません。ウォームアップブロックは表現制約と常駐プロフィールを載せ、末尾を一行のディレクトリ（`N more workspace / agent-track entries stay out of this block`）で閉じます。これでモデルは `memory_recall` で取りに行くものがあると分かります。件数は一行だけで、中身はオンデマンドのままです。

## Capabilities

- **承認ゲートは迂回できません。** すべての書き込み経路（`add` / `replace` / `remove` / `seed`）は、ツール層ではなくサービス内部の承認ウォーターフォールを通されます。`writePolicy: ask | auto | off` はモデルから見えない設定です。`replace` / `remove` / `consolidate` は、変更するエントリの全文を承認ペイロードに載せます。拒否された書き込みも `*-denied` の監査行を残します。
- **モデルから見えるものは記録されるものと一致します（Model-visible ⟺ logged）。** 注入されたスナップショットはそのまま `system/message` に着地し、すべての書き込みは `approval/asked` + `approval/decided` + プラグイン自身の監査テーブルから再構成できます。
- **上限があり、正直です。** トラック別・レイヤー別のソフト警告ライン（既定は user 2000 / agent 4000）。ラインを超えても書き込みが止まることはなく、そのレイヤーは統合する価値があるという印が付くだけです。切り詰めも自動圧縮も行いません。
- **セッション単位のスイッチ。** すべてのセッションに専用のメモリスイッチがあります（プラグイン所有の SQLite テーブル、スキーマ v6、既定はオン）。オフにすると、注入が止まり（凍結済みのウォームアップブロックは即座に取り除かれます）、想起は拒否され（`SESSION_MEMORY_OFF`）、書き込みは承認ゲートと同じ層で拒否され、観察チャネルはそのセッションを走査せず履歴としても選びません。管理用の読み取り（`/memory list` / `budgets` / `audit` / `export`）は引き続き利用できます。切り替えは `/memory session on|off` かヘッダーのスイッチで行います。スイッチの状態そのものはセッションログに入らず、その監査行は `text: null` を持ちます。
- **観察し、その観察を自走させます。** 観察チャネルは、あなた自身の過去メッセージから範囲を限って一部を読み、アンケートでは届かない行動エントリを書き込みます。
  - **目覚まし時計。** 読み取り専用のチェックが、最後の観察から一週間以上経つとそれを指摘します。`observe-due` の監査行 1 行と、次のウォームアップブロックの末尾の 1 行です。
  - **無人で走る回。** 週次でスケジュールした回は、ひとつのワークスペースでこれを実行できます。ヘッドレスの `dsh` セッションが走査し、根拠に基づくエントリを最大 3 件推論し、同じ承認ゲートを通してコミットします。許可は専用の書き込みポリシー source（`source:observation`、`auto` / `ask` / `off`）が与えます。
  - **スケジュールの置き場所。** タイマーはプラグインの内部にはありません。整理の回とまったく同じく、Windows タスクスケジューラのエントリです。
- **整理し、計測します。** モデル駆動の整理パスは、同じことを言っているエントリを `merged` タグ付きの 1 件に統合し、古いものを `superseded` へ降格します。ディスク上には残り、どのセッションからも見えなくなり、削除はされません。バケット（`track × scope × agentKey`、ワークスペースレイヤーではさらに `workspaceKey`）を越えることはなく、勝手に走り出すこともありません。
  - **誰が決めるのか。** 五つの機械的なハードゲート（同一バケット / メンバー数 / 句読点・空白・記号を取り除いたうえでのリテラル同一性 / 類似度 / カバレッジ）が、人の確認なしに統合を書き込んでよいかを決めます。モデル自身の確信度は判断に関与しません。取り除いた後にメンバーが同一になる層だけが `auto` と判定され、無人で着地できます。完全に言い換えられたペアは `skip` と判定されてその場に留まり、一字違いは `review` と判定されてあなたを待ちます。
  - **バックグラウンドの回。** あなた自身のスケジューラに起こされたヘッドレスの `dsh` セッションが、機械的に曖昧さのない重複を統合し、残りには手を触れません。この書き込みは自分の監査 source（`tidy-auto`）を固定するので、細粒度の書き込みポリシーはまさにこの一経路だけを許可し、他のすべての書き込みは承認ゲートの後ろに留められます。
  - **印を付けるだけで、行動はしません。** 読み取り専用の `agent/turn-stopping` チェックは、バックログがラインを越えたことを示すだけです。`tidy-due` の監査行 1 行と、次のウォームアップブロックの末尾の 1 行です。
  - **数値。** `/memory stats` は重複率、想起ヒット率、注入量を報告し、ドロワーにも表示されます。成功率は意図的に空欄です。このリポジトリには「注入されたブロックが実際に効いたか」を知る信号源がないためです。
  - **パネルのボタン。** **Tidy the whole library** が本当に実行されるようになりました。1 回クリックするとマーカーが登録され（`tidy_requests`、スキーマ v7）、ヘッドレスセッションが起動します。そのセッションは計画を読み、許される範囲を統合し、マーカーを消してバッチ id を残します。ドロワーはステータス行を 1 行（`pending` → `running` → `done` · 統合 N グループ、または `nothing needed merging`、`failed` の場合は Retry 付き）と、バッチブロックのロールバックボタンを保ちます。会話もコンテキスト消費もありません。実行者はプラットフォームからの推測ではなく**解決**されます（設定された `tidy.exec`、なければホスト自身のランチャー、それもなければ PATH 上の `dsh.cmd` / `dsh`）。バッチを残さず終わった回も自身の `exited` 受領記録を残すので、ボタンがロックされたままになることはありません。`tidy.enabled: false` にすると、キューに貯めるだけの以前の挙動に戻ります。
- **メモリを統治します。降格を巻き戻し、対立をファセット単位で仲裁します。**
  - **`restore`** は降格を逆方向にたどります（`superseded → active`、`version` は変わらず、すべてのセッションから再び見えるようになります）。降格状態から抜ける唯一の経路です。
  - **`arbitrate`** は、ひとつの事実が二つの source を伴う場合を裁定します。決めるのは**ひとつのファセット**についてであり、方向は固定の表から来ます。能力は観察に従い、選好は自己申告に従い、残る五つのファセットは**両方**のエントリを保ってそれぞれに `gap` を付けます（その食い違い自体が証拠です）。表が方向を決めるので、逆方向の議論を渡す余地はありません。グループ内では、最も新しく更新されたエントリが残ります。
  - **他のあらゆる書き込みと同じ規則。** 同じ承認ゲート、同じセッション単位スイッチ、同じバケット規則です。監査証跡は、`restore` はエントリごと、`arbitrate` は降格ごと（`text: null`、id のみ）、`arbitrate-tag` はタグごとに残り、最後に `arbitrate` の要約が 1 件、誰が残り、誰が降格され、なぜかを記します。

## Compatibility

| 項目 | 状態 |
|---|---|
| ハーネス | DeepSeek Harness `dsh-v0.1.5-rc.2`（2026-09-09 に対応）：セッションエンベロープは、保存済みログの読み取り互換性のためだけに無視可能フィールドを保っています。Session.append は依然としてそれを刻めないため、監査ゲートの挙動は変わりません。2026-09-11 に dsh-v0.1.5-rc.2 の master チェックアウトに対して検証済み（ゲートチェーン全体 + プロファイルインストールのスモーク）。 |
| Node | `^22.19.0 \|\| >=24.0.0` |
| プラットフォーム | Windows / macOS / Linux（ピュアホスト。ネイティブコードなし、ネットワークなし） |
| Model | 任意 |

## Configuration

調整可能な項目はすべて Schemastery の `Config` フィールドです（cordis.yml から変更できます）。不正な値は読み込み時に大きな音を立てて失敗します。上書きは `yammory_system` の行の下で行います。

**設定パネル。** DSH の設定サービスがマウントされているときは、以下のすべてのフィールド（`enabled` を除く）を、**DSH 設定サイドバーにあるプラグイン自身の `yammory-system` 項目**（General や Plugins と同じトップレベルのセクション）から編集できます。編集は設定のユーザーレイヤー（`settings.yaml`）に着地し、ファイルを直接編集する必要はありません。ほとんどは即時に反映されます（書き込みポリシー、言語、バジェット、各種上限、提案、パネル、ストアの再オープンによる `dbPath` / `auditRetentionDays`、検索器の差し替えによる `retrieval.vector`）。DSH のリロードが要るのは `snapshotOrder` だけです。設定サービスがない場合、すべては以前とまったく同じく合成された cordis 設定にフォールバックします。サイドバーのメモリ項目は同じページから隠せます（`panel.enabled`）。

| キー | 既定値 | 意味 |
|---|---|---|
| `enabled` | `true` | マスタースイッチ。`false` にするとサービス、ツール、スナップショット、コマンド、パネル、回答者が取り除かれます（設定ページからは編集できません。無効なプラグインには設定項目が現れないためです） |
| `panel.enabled` | `true` | サイドバー下部にメモリ項目を表示します。設定ページで `false` を保存すると即座に隠れ、リロードは不要です（設定ページ自体には引き続き到達できます） |
| `dbPath` | `''` → `$DSH_HOME/dsh-memento/memory.db` | 絶対パス、または `$DSH_HOME` からの相対パス（Windows では `~/.dsh` にフォールバックします） |
| `budgets.user.userGlobal` | `2000` | `user` トラックの user-global レイヤーに対するソフト警告ライン |
| `budgets.user.workspace` | `2000` | `user` トラックの workspace レイヤーに対するソフト警告ライン |
| `budgets.agent.userGlobal` | `4000` | `agent` トラックの user-global レイヤーに対するソフト警告ライン |
| `budgets.agent.workspace` | `4000` | `agent` トラックの workspace レイヤーに対するソフト警告ライン |
| `writePolicy` | `'ask'` | 既定の書き込みポリシー：`ask` / `auto` / `off`（モデルからは見えません） |
| `writePolicies` | `{}` | トラック／スコープ単位、または source 単位の上書き（例：`user/workspace`、`source:claude`） |
| `language` | `'en'` | モデルから見える言語とコマンド出力の言語：`en` / `zh` |
| `snapshotOrder` | `-50` | スナップショットのセクション順（ハーネスの識別情報の後、ペルソナの前） |
| `maxEntriesPerQuery` | `20` | 1 クエリあたりの既定の結果上限（ハード上限は 1000） |
| `commandListLimit` | `50` | `/memory list` / `query` ごとに描画するエントリ数 |
| `commandAuditLimit` | `10` | `/memory audit` ごとに描画する監査行数 |
| `recall.historyLimitDefault` | `8` | `memory_recall` が既定で走査するセッション数 |
| `recall.snippetCap` | `5` | `memory_recall` の 1 セッションあたりのスニペット数 |
| `recall.snippetChars` | `300` | `memory_recall` のスニペット文字数 |
| `recall.windowDays` | `30` | `memory_recall` の新しさウィンドウ（日数） |
| `observe.days` | `14` | `memory_observe scan` のウィンドウ（日数。ハード上限は 90） |
| `observe.sessions` | `8` | 1 回のスキャンで抽出する直近セッション数（ハード上限は 20） |
| `observe.perSession` | `12` | 1 セッションあたりに抽出するメッセージ数。冒頭と後半の訂正がどちらも残るよう均等に散らします（ハード上限は 20） |
| `observe.messageChars` | `400` | 1 メッセージあたりの文字数上限。超えると省略記号を付けて切り詰めます（ハード上限は 800） |
| `observe.totalChars` | `12000` | スライス全体の文字バジェット。ここでスキャンは止まり、カバーできなかった範囲を報告します（ハード上限は 30000） |
| `recall.weighting.heat` | `0.3` | ヒートボーナスの上限（乗算。`0` で無効になります）。ヒート = 想起回数（飽和あり）× 最後の想起からの半減期減衰。熱を保つには想起され続ける必要があります |
| `recall.weighting.heatSaturation` | `10` | ヒートボーナスを飽和させる想起回数 |
| `recall.weighting.heatHalfLifeDays` | `14` | ヒートの半減期（日数）。しばらく想起されないエントリは冷めていきます |
| `recall.weighting.freshness` | `0.2` | フレッシュネスボーナスの上限（乗算。`0` で無効になります） |
| `recall.weighting.freshnessHalfLifeDays` | `30` | フレッシュネスの半減期（日数） |
| `recall.weighting.tagDiscount` | `0.5` | トークンが `tags` にだけ一致したときの重み（本文に一致した場合は `1`） |
| `retrieval.vector` | `false` | セマンティック想起のスイッチ。`true` は**本当にセマンティックな埋め込みプロバイダーが登録されている場合に限り**ベクトル想起に差し替えます。ハッシュや偽物のプロバイダーでは意図的に足りません。意味をモデル化しておらず、CJK の想起を黙ってゼロにしてしまうためです。それ以外の場合は依存ゼロのキーワード検索器がそのまま残ります（CJK バイグラム分割、いずれかのトークンの一致、ヒート／フレッシュネスの重み付け、関連度ランキング） |
| `panelEntriesLimit` | `200` | Web パネルのエントリ 1 ページあたりの件数 |
| `panelAuditLimit` | `20` | Web パネルの監査行数の既定値 |
| `auditRetentionDays` | `0` | 監査の保持期間（0 = 無期限に保持） |
| `proposals.enabled` | `true` | 圧縮が成功するたびにメモリ提案を自動で取り込みます |
| `proposals.maxChars` | `2000` | 提案の文字数上限 |
| `proposals.maxPending` | `8` | 保留中の提案の上限 |
| `tidy.enabled` | `true` | **Tidy the whole library** が実際にバックグラウンドの回を起動するかどうか。`false` にすると以前の挙動（マーカーを置くだけで、次のセッションを待つ）に戻ります |
| `tidy.profile` | `'headless'` | バックグラウンドの回が使う実行者プロファイル名 |
| `tidy.exec` | `''` → 自動検出 | 実行者の指定。空は「自分で解決する」という意味です。まずホスト自身のランチャー（起動に使われた CLI スクリプトを、同じ node で実行）、次に PATH 上の `dsh.cmd` / `dsh`。設定した値（絶対パス、または自前のランチャースクリプト）はその両方を上書きします。見つからない場合は「the executor could not be started」と正直に報告され、Retry ボタンが付きます |
| `tidy.timeoutMs` | `480000` | 待機ウィンドウ。この時間までに終了しない回は強制終了され、「timeout」として報告されます（最小 30 秒） |
| `tidy.task` | `''` → 組み込みのタスク文 | ヘッドレスセッションに渡す指示を上書きします（設定ファイル専用で、設定カードには現れません） |

## Tools & surfaces

| 項目 | 種類 | 備考 |
|---|---|---|
| `memory` | ツール | add/replace/remove/consolidate/supersede/auto-tidy/restore/arbitrate/query/tidy（Save/Skip の指針付き）。エントリはプロフィール座標を伴えます（`facet` = 七つのファセットのいずれか、`level` = 領域別の知識レベル）。`supersede` は 1..20 のエントリを `merged` タグ付きの 1 件に統合し、古いものを `superseded` へ降格します（保持され、削除はされません）。`restore` は降格されたエントリを戻し、`arbitrate` は二つの source が対立する件を、仲裁表が固定する方向でひとつのファセットについて裁定します。`tidy` は読み取り専用の整理計画を返します。書き込みは承認ゲートに乗ります |
| `memory_profile` | ツール | 31 のサブドメイン尺度にわたる領域別の知識レベル（`set` / `list` / `get`）。`set` は承認ゲートを通り監査されます。`tier` は `level` から導出されます |
| `yammory-survey` | スキル | ユーザーが起動するプロフィールアンケート。アンケートで尋ねてよい 24 のサブブロックを扱います。`memory` + `memory_profile` を通して書き込みます。出典：`skills/yammory-survey/` |
| `memory_recall` | ツール | 範囲を限ったメモリの一致（クエリは CJK バイグラムとラテン語をそのままにトークン化。いずれかのトークンが想起し、関連度で順位付けられます）と、直近のセッション履歴の一致 |
| `memory_observe` | ツール | 観察チャネル。`scan` はユーザー自身の過去メッセージを範囲を限って読みます（読み取り専用、`cwd` 単位、システムが注入した疑似メッセージは除外して件数を報告、バジェットの不足も報告）。`commit` は根拠に基づくエントリを 1..8 件、`source: observation` を伴う承認ゲート付きの単一アトミックバッチで書き込みます |
| `yammory-observe` | スキル | ユーザーが起動する行動観察。観察でしか得られない五つの面（思考の型、困難に直面したときの性格、感情のパターン、自己認識、意思決定の型）を `memory_observe` を通して書き込みます。出典：`skills/yammory-observe/` |
| `yammory-tidy` | スキル | ユーザーが起動するメモリ整理。読み取り専用の計画を読み、同じことを言っているものを統合し、古いエントリを降格します（保持され、削除はされません）。バケットを越えることはありません。出典：`skills/yammory-tidy/`。判定規則は `references/merge-rules.md` |
| `yammory-experience` | スキル | 仕事の進め方について再利用できる教訓を `agent` トラックに記録します（環境の事実、約束事、教訓）。ユーザープロフィールとは一つの問いで切り分けます。この知識は毎ターン存在している必要があるか。出典：`skills/yammory-experience/` |
| `/memory` | コマンド | `list` · `query` · `add` · `remove` · `consolidate` · `restore <id...>` · `arbitrate <id...>` · `tidy [--days=N]` · `stats` · `proposals` · `budgets` · `audit` · `export` · `import <path>` · `adapters` · `observe [--days=N]` · `session [on\|off]` |
| セッションスイッチ | セッションヘッダー | 会話ヘッダーにあるセッション単位のメモリスイッチで、agent-preset のラベルのすぐ後ろに置かれます（`conversation.session.header.actions`、セッションスコープ）。現在の状態を示し、`GET`/`POST /api/memento/session` で切り替えます（このルートはパネルのルートと同じ `connection.fetch` の信頼フェンスに乗ります） |
| Web パネル | クライアントのドロワー | メモリの中身に対しては読み取り専用で、二つの世界に分かれます。**memory** タブは折りたたみ式の七ファセットツリー（まずカテゴリ、クリックでエントリ）と知識レベルのブロックです。**experience** タブは `agent` トラックをトピック別にまとめます。どちらも検索、バジェットバー、三つの可観測性の数値、監査の末尾を共有します。ユーザー操作のボタンが 1 つあり、バックグラウンドの整理の回を起動して、その回のステータス行とバッチブロックを表示します（すべての書き込み経路はサーバー側に留まります）。サイドバーの項目は隠せます（`panel.enabled`） |
| 設定セクション | DSH 設定サイドバー → `yammory-system` | ファイルに触れずにすべての設定フィールド（`enabled` を除く）を編集できます。即時反映かリロードが必要かはページ上に明示されます |

## MCP server

`yammory_system` は読み取り専用の stdio **MCP サーバー**（`yammory_system-mcp`）を同梱しているので、外部の MCP クライアント（Claude、Codex など）がハーネスなしでメモリストアを検索できます。改行区切りの JSON（NDJSON）で JSON-RPC 2.0 を話します。1 行に 1 つの JSON オブジェクトで、`Content-Length` のフレーミングはありません。

**読み取り専用。** データベースは `node:sqlite` の `readOnly: true` で開かれます（マイグレーションなし、WAL への書き込みなし、想起回数の加算なし）。データベースが存在しない場合はクラッシュせず、空の結果を返します。

| ツール | 目的 |
|---|---|
| `memory_search` | `{query, limit?}` → 順位付けされたエントリ（検索 Provider のシームを通した、大文字小文字を区別しない部分文字列） |
| `memory_stats` | `{}` → `{total, namespaces}` のエントリ数 + トラック／スコープ別の概要 |

直接実行する場合：

```sh
node bin/mcp-server.mjs
# or, through the GitHub channel: npx -y -p github:KhalilYamber/yammory-system yammory_system-mcp
```

データベースのパスは `$DSH_MEMENTO_DB_PATH` です（絶対パス、または `$DSH_HOME` からの相対パス）。既定は `$DSH_HOME/dsh-memento/memory.db` です。

Claude Desktop（`claude_desktop_config.json`）の例：

```json
{
  "mcpServers": {
    "yammory_system": {
      "command": "npx",
      "args": ["-y", "-p", "github:KhalilYamber/yammory-system", "yammory_system-mcp"],
      "env": {
        "DSH_MEMENTO_DB_PATH": "/home/you/.dsh/dsh-memento/memory.db"
      }
    }
  }
}
```

ここでは `npx` が GitHub チャネル経由でパッケージを解決します（このリポジトリは npm レジストリにありません）。取得を行っているのは `-p github:…` の指定です。

サーバーは読み取り専用です。ネットワークなし、書き込みなし、承認ゲートなし。検索と統計だけです。

## Permissions & data

- **権限**：ワークショップマニフェストで `harness:tool`、`filesystem:read`、`filesystem:write`、および `network:none` / `subprocess:none` / `shell:none` / `python:none` / `credentials:none` を宣言します。書き込みの承認は公式の承認シームに乗ります。ただし一点だけ文字どおりに読まないでください。**Tidy the whole library** ボタンは使い捨てのヘッドレスセッションを 1 つ起動します（`dsh --profile headless`）。これはプラグインが唯一プロセスを起動する箇所で、ユーザーが操作したときだけ動き、専用ファイルに記録され、バッチ単位でロールバックでき、`tidy.enabled` で切れます。
- **データ**：ローカルの SQLite データベース（`0600`）、ネットワークゼロ、資格情報ゼロ。
- **セッションログ**：監査の完全性は、承認のペア（`approval/asked` + `approval/decided`）と、プラグイン自身の監査テーブルから来ます。

## Security boundaries

- **公開サービスだけを使います。** `tools`、`systemPrompt`、承認シームを消費します。エンジン / agent-loop / apiproxy / 公式 UI への変更はありません。
- **ネットワークゼロ、資格情報ゼロ。** POSIX ファイルモード `0600` のローカルデータベースです。
- **大きな音を立てて失敗します。** 壊れた DB、新しすぎるスキーマ、不正な設定は読み込み時に失敗します。曖昧な部分文字列の一致は構造化されたエラーで失敗します。警告ラインを超えても、書き込みが失敗することはありません。
- **1 プロセス、1 ストア。** 複数のセッションが同じ SQLite ストアを共有します。ひとつの `$DSH_HOME` を共有する 2 つのプロセスは同じファイルに書き込みます（SQLite のロックの下で、最後の書き手が勝ちます）。

## Known limitations

- **セッションイベントは宣言済みですが、まだ発行されていません（rc.2）。** `memory/added|updated|removed|recalled|snapshot` はマージ時に宣言されていますが、rc.2 にはリポジトリ外のイベント種別を登録するサーフェスがありません。発行は、ハーネスのビルドがそれらを登録した時点で有効になります。
- **バックグラウンドの整理の回は、ひとつのワークスペースしか見ません。** 第一のゲートは `cwd` が呼び出し元と等しいセッションだけを読むので、パネルから起動した回が対象にするのは、起動元の作業ディレクトリ（と user-global レイヤー）です。他のワークスペースはそれぞれ自分の回を持ちます。
- **`ask` ポリシーには回答者が必要です。** UI/ACP の回答者が構成されていない場合、書き込みはフェイルクローズします。
- **FTS5 インデックスはありません。** 部分文字列検索は大文字小文字を区別しない `instr` で動きます（CJK に対しては正しく働きます）。
- **観察はホワイトリストであり、そのホワイトリストには限界があります。** `memory_observe scan` が残すのは、`source.kind` が `user` または `user-rpc` である `user/message` イベントだけです。このマシンで計測したところ、これは全 `user/message` イベントの 48% を落とします（実行時コンテキスト、AGENTS.md、スキルカタログ、ゴールのラウンド、サブエージェントの通知）。ただし、人が直接入力したメッセージと、`kind: 'user'` を宣言して外部ブリッジ経由で届いたメッセージを区別することはできません。ログが運ぶ信号は kind だけです。引用された一行は弱い証拠として扱い、セッションをまたいだ繰り返しを求めてください。
- **「セマンティック」と呼ばれる検索の半分は、まだセマンティックではありません。** `retrieval.vector` は自分をセマンティックだと宣言するプロバイダーでのみ働きます。ここに同梱されている唯一のプロバイダーは `false` を宣言しているので、現時点でこのスイッチは設計どおりキーワード想起にフォールバックします。本当のセマンティック想起を有効にするには、このリポジトリがまだ選んでいない埋め込みの供給源が必要です。

## How it's different

| プラグイン | どんなものか | yammory_system との違い |
|---|---|---|
| dsh-mneme | 機能の幅が広い自己進化型のメモリ | 小規模コーパスのプロフィールに限定：機能を広げるのではなく、計測されたユーザーのレベルに合わせて話すことで差をつけます |
| dsh-meow-memory | BM25 検索を備えた七層のストア | 検索の作り込みはしません：領域別のレベル表とファセット仲裁です |
| dsh-persona-memory | プロンプトへのペルソナ注入 | さらに一段深く：常駐プロフィールの上に**領域別の知識レベル**と**ファセット仲裁**を載せます |
| dsh-memory-evolve | メモリ倉庫 / 進化ループ | 型付きのサービスシーム、承認ゲート、セッションログ監査。倉庫を目指す気はありません |
| dsh-mnemon | メモリストアの補助ツール | プロトコル + ゲート + 監査であり、もう一つのストアではありません |
| dsh-kb-sieve | ナレッジベースのふるい分け | 検索の作り込みはしません：小規模コーパスの部分文字列検索、`session_search`/`sessionQuery` によるセッションをまたいだ想起 |
| dsh-tdai-memory | タスク駆動のメモリツール群 | バジェットはトラック×レイヤー単位で、サービス内で強制されます。努力目標ではありません |
| claude-bridge | Claude Code のブリッジ | DSH ネイティブ。将来の `seed(source:'claude')` 経路により、ブリッジが同じストアに供給できます |
| dsh-external/Recall | 外部エージェントのメモリ | ローカルファースト、ネットワークゼロ、DSH 自身の承認シームに乗ります |
| 公式の MCP メモリの例 | DSH が掲げる「memory = external MCP」の立場 | **ネイティブなファーストパーティ**の補完：同じ目的を外部サーバーなしで。両者は共存します |

今日のフィールドに対して有効な二つの違いは、上の表の最後の組です。**領域別の知識レベルを携えた七ファセットプロフィール**（検索が起きる前に、アシスタントの話し方を決めます）と、**ファセット仲裁**（二つの source が対立したときの落としどころを決めます。能力は観察に従い、選好は自己申告に従い、残る五つのファセットは両方を保ってそれぞれに `gap` を付けます）。

名前は **`yammory_system`** です（GitHub チャネルからインストールするもので、npm レジストリにはありません）。`dsh-recall` でも（dsh-external/Recall と紛らわしいため）、削除された旧名の `dsh-memory` でもありません。

## dsh-memory-protocol v1

`yammory_system` は DSH メモリプロトコルのコミュニティによる予行演習です。公式の `ctx.memory` シームの候補形でもあります。このプロトコルは、本プラグインのシームをプラグイン横断の契約へと正規化します：

- **エントリ仕様** — 二つのトラック × 二つのレイヤー × agent 単位のキー。加えて短い `tags`（16 個以下 × 32 文字以下）と、`replace` のたびに増えるエントリ単位の `version`。
- **書き込みの意味論** — 冪等な、一意な部分文字列による条件付き書き込み。見たままを承認するペイロード（`replace` / `remove` / `consolidate` は変更する全文を載せます）。
- **監査の契約** — すべての書き込みは `approval/asked` + `approval/decided` + プロバイダーの台帳から再構成できます。
- **警告ラインのモデル** — レイヤー別のソフト警告ライン / `AMBIGUOUS_MATCH` の意味論。
- **スキーマのバージョン管理** — 大きな音を立てるバージョンチェックを伴うマイグレーション規則。

- **仕様** — [docs/protocol-v1.md](docs/protocol-v1.md)（中国語：[protocol-v1.zh.md](docs/protocol-v1.zh.md)）。規範となる JSON Schema は [docs/schemas/dsh-memory-protocol-v1.schema.json](docs/schemas/dsh-memory-protocol-v1.schema.json)。

**アダプター登録簿** — `ctx.memoryAdapters`（`register` / `list` / `adapt` / `export`）により、サードパーティのメモリプラグインは純粋なデータ変換器を登録するだけでこのプロトコルを話せます（`register()` は可逆。取り込みは承認ゲート付きの `seed` に乗り、エクスポートは読み取り専用です）。導入方法：[docs/adapters-guide.md](docs/adapters-guide.md)（中国語：[adapters-guide.zh.md](docs/adapters-guide.zh.md)）。

| 内蔵アダプター | 外部フォーマット | 備考 |
|---|---|---|
| `mem0` | mem0 の事実コレクション（`{facts: [{memory, metadata?}]}`） | `metadata.category` / `metadata.tags` はタグになります。生の `messages` 配列は拒否されます。アダプターは変換するだけで、抽出はしません |
| `hermes-memory-md` | Hermes の `memory.md`（`## section` + 箇条書き） | セクション名はタグになります。箇条書きでない散文は大きな音を立てて失敗します |
| `claude-code-memory-md` | `CLAUDE.md` 風の markdown（見出し、箇条書き、段落） | 箇条書きと段落はエントリになり、セクション名はタグになります |

**適合性スイート** — [test/protocol-conformance/](test/protocol-conformance/README.md)：互換性を名乗るプロバイダーならどれでも実行できる、配布可能なケース集です（`node test/protocol-conformance/run.mjs --provider ./your-factory.mjs`）。このリポジトリの CI は、自分自身のプロバイダーを正解の基準としてこれを実行します（`npm run test:conformance`）。

- **上流への提案** — [docs/upstream-proposal.md](docs/upstream-proposal.md)（中国語：[upstream-proposal.zh.md](docs/upstream-proposal.zh.md)）：公式の `ctx.memory` シームがこのプロトコルを採用すべき理由、相違点、移行経路。

## What we learned from the terminal memories

`yammory_system` は Claude Code、Codex、Hermes の移植ではありません。ただしその設計は、それぞれが正しくやっていた部分を意図的に取り込み、害になる部分は拒否しています：

| ターミナルメモリ | 正しかった点 | yammory_system が採用したもの |
|---|---|---|
| **Claude Code** — `CLAUDE.md` | 階層化されたプレーンテキストのメモリファイル（ユーザーレベル → プロジェクトレベル）。人が読めて人が編集でき、毎セッション自動でマージされます | プレーンテキストのエントリ。`user-global` / `workspace` レイヤーをセッションごとにマージ。閲覧・`export`・監査できるストア。透明性を機能として扱います |
| **Codex** — `AGENTS.md` | ディレクトリ単位でスコープされた指示を自動検出し、モデル側の手間ゼロで注入します | セッションの cwd をキーにした `workspace` レイヤー（Windows では大文字小文字を区別しません）。セッション開始時に凍結スナップショットを自動注入します |
| **Hermes** — `memory.md` | 先回りするメモリ保存と、ツール層だけで強制されたゲートは後からのツール注入で迂回できるというセキュリティ上の教訓 | Save/Skip の指針付きの `memory` ツール + 承認ゲート付きの自動取り込み提案。ゲートはツール層ではなく `ctx.memory` の書き込みメソッドの内部にあります |

出典：[Claude Code memory](https://code.claude.com/docs/en/memory) · [Codex AGENTS.md](https://developers.openai.com/codex/cli/agents-md) · [Hermes memory](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md) · [Hermes #48181](https://github.com/NousResearch/hermes-agent/issues/48181)。

意図的に拒否した部分は次のとおりです。モデルだけが持つ状態への隠れた自動要約（ここでは圧縮の要約が**保留中の提案**になり、人が承認するか却下するまで待ちます）、倉庫やベクトルストアを目指す野心、人の目に触れる承認または監査証跡を欠くあらゆる書き込みです。同じく取り込んだものとして、ホームディレクトリを共有する 2 つのプロセスが同じメモリファイルに書き込むという Hermes の文書化された注意点があります。セキュリティ境界の節をご覧ください。

## Development

```sh
npm install              # node ^22.19 || >=24
npm test                 # node --test: 484 tests
npm run lint             # oxlint
npm run test:conformance # dsh-memory-protocol v1 conformance suite
npm run typecheck        # tsc --checkJs gate
npm run check:coverage   # line-coverage gate
npm run check:readmes    # five-language README consistency gate
npm run verify:self-contained # reject out-of-repo dependency specs
npm run verify:artifacts # artifact presence + syntax + import
```

`lib/` は DSH への依存がゼロです（node: の組み込みのみ）。DSH の import は `index.mjs` にだけ存在します。

## Topics

`dsh`, `dsh-plugin`, `deepseek-harness`, `memory`, `agent-memory`, `approval`, `audit`, `sqlite`, `cordis`, `llm`

## Contributors

- [@Niuniu-Sir](https://github.com/Niuniu-Sir) — [issue #1](https://github.com/PerryLink/dsh-memento/issues/1) の起動クラッシュ報告。これが 0.3.1 で出荷された `~/.dsh` フォールバックにつながりました。

## Upstream

このプロジェクトは [`dsh-memento`](https://github.com/PerryLink/dsh-memento) のフォークで、もともとは [PerryLink DSH plugin family](https://github.com/PerryLink) の一部でした。上流の帰属表示と Apache-2.0 ライセンスは保持されています。

[Apache License 2.0](LICENSE) © 2026 dsh-memento contributors
