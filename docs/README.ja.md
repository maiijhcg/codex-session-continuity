<div align="center">

# codex session continuity

**長い Codex の作業を、きちんと引き継ぐために。**

[English](../README.md) · [繁體中文](README.zh-Hant.md) · [简体中文](README.zh-Hans.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [Deutsch](README.de.md)

![長い Codex の作業を、きちんと引き継ぐために。](images/hero.png)

</div>

ローカル履歴、引き継ぎノート、同じプロジェクトでの継続を支える Windows 用ヘルパーです。新しいタスクはノートを読み、必要な証拠だけを後から参照します。会話全体を新しいプロンプトに詰め込む仕組みではありません。

> [!IMPORTANT]
> 実験的なプレビューであり、OpenAI 公式製品ではありません。デスクトップのローカルインターフェースに依存するため、アプリ更新後に互換性修正が必要になる場合があります。新規インストール時の自動継続は一時停止です。モデルの実効コンテキストと閾値を先に確認してください。

## できること

![できること](images/overview.png)

| 機能 | 説明 |
| --- | --- |
| 作業の記録 | 保存済みの会話・ツール記録を増分アーカイブし、検索用に索引化します。 |
| 引き継ぎを整理 | 元のアシスタントに判断、進捗、制約、検証、次の手順を記録させます。 |
| 同じプロジェクトを維持 | プロジェクト、作業ディレクトリ、権限を確認し、checkout と未コミットのファイルを維持します。 |
| 添付資料を保持 | 対応するローカル／埋め込み添付と出典を保存します。保存だけで内容を理解したことにはなりません。 |

## 引き継ぎの3段階

![引き継ぎの3段階](images/workflow.png)

1. 保存：バックグラウンドで原文と添付の索引を作成します。
2. 準備：元のアシスタントが HANDOFF.md を書き、固有の確認トークンを返します。
3. 継続：元のターン終了と場所・権限の確認後、新しいタスクを1つ作成します。

## Windows へのインストール

サインイン済みの Codex Desktop、Node.js 24 以降、PowerShell 7 以降が必要です。正しい作業フォルダーをアプリのプロジェクトとして保存し、別の管理専用タスクを作って UUID／リンクをコピーしてください。管理タスク自体を引き継ぎ対象にしないでください。

Releases から ZIP と SHA256SUMS を入手し、SHA-256 を確認して展開します。PowerShell 7 で展開先を開き、以下のプレースホルダーを管理タスクの UUID に置き換えて実行します。

[Releases](https://github.com/maiijhcg/codex-session-continuity/releases)

```powershell
pwsh -NoProfile -File .\install.ps1 -OwnerThreadId "PASTE_MANAGEMENT_TASK_UUID" -WithIntegration
```

既定のインストール先は `%LOCALAPPDATA%\CodexSessionContinuity`。現在のユーザーの Windows サインイン時起動を既定で登録し、再起動・サインイン後は裏で実行します。管理者権限は不要で、ログイン前のシステムサービスではありません。新規インストールの自動継続は停止状態で、以後もスイッチ設定を保持します。

`-NoStartup` はサインイン時起動を登録せず、`-NoStart` は今すぐの起動を省略します。`-InstallDir`、`-CodexHome` で場所を、`-SoftLimit`／`-HardLimit` で閾値を指定します。`-WithIntegration` を省略すると hook とアシスタント指針の設定を延期します。Hook は Codex の通常の信頼確認で承認し、自動承認は行いません。

## 手動メニュー

![手動メニュー](images/control.png)

| キー | 操作 |
| --- | --- |
| **1** | 自動引き継ぎを有効化 |
| **2** | 自動引き継ぎを一時停止。原文保存は続行 |
| **3** | プロセス、接続、要求状態を更新 |
| **4** | 1つのタスクを明示的に選んで引き継ぐ。UUID／リンクも入力可 |
| **5** | メニュー言語を選んで保存 |
| **0** | 終了。スイッチは変更しない |

まず 3 でプロセス、最新ハートビート、デスクトップ接続を確認し、その後 1 または 4 を使います。実行中のタスクを先に、その中では最近の活動順に表示します。キュー登録は完了を意味しません。同じ未処理要求の連打は重複登録されません。

メニューは英語が既定で、英語・繁体字中国語・簡体字中国語・日本語・スペイン語に対応。文書はさらに仏・韓・露・独語で提供します。元のタスク名・履歴・低レベルの技術情報は原文のままです。5 は設定を保存し、`-Language` はその起動だけを上書きします。

```powershell
.\Codex-Session-Continuity.cmd -Language ja
pwsh -NoProfile -File .\manual-switch.ps1 -Action Status -Language ja -Json
```

## 閾値と制約

例の既定値はソフト 500,000／ハード 920,000 トークンで、すべてのモデルに適する値ではありません。ソフトは連続監視中の上向きの超過だけを検知します。起動・復帰時に既にソフト以上なら遡って発動せず、現在値がハードに達するのを待ちます。ネイティブ圧縮は別の計数や小さい窓を使う場合があります。モデルや圧縮設定は変更せず、コンテキスト容量も増やしません。

## データと安全性

インストール先の `archive/`、`notes/`、実行時 `assets/`、SQLite、設定、ログは機密情報を含みます。GitHub に公開しないでください。このユーティリティに独自のテレメトリ／クラウド送信クライアントはありませんが、通常の Codex メッセージとタスク作成は既存アカウントのサービスを利用します。

履歴と媒体を自動削除しません。容量を監視し、独立したバックアップを用意してください。暗号化・OCR・音声書き起こしは内蔵せず、遠隔添付も自動取得しません。一時停止は送信済み操作を取り消さず、プロセス停止中は新しい原文の保存も止まります。

[SECURITY.md](../SECURITY.md)

## 待機とエラー

`waiting_handoff` は元タスク待ち、`soft_expired` は期限切れのソフト通知、`checkpoint_interrupted` はユーザーによる再選択が必要な中断です。`checkpoint_uncertain`／`creation_uncertain` は結果を調べてから対応し、無闇に再送しないでください。プロジェクトや権限が不一致なら停止し、既定フォルダーへの移動や自動昇格は行いません。

```powershell
node .\cli.mjs status
node .\cli.mjs tasks
node .\controller.mjs resolve "PASTE_TASK_UUID"
```

## 起動・更新・アンインストール

以下はインストール先で実行します。更新前に停止して私的な実行フォルダー全体をバックアップし、同じインストール先で新しいインストーラーを実行します。削除処理はプログラム、設定、原文、ノート、添付を残し、Codex タスクを削除しません。

```powershell
pwsh -NoProfile -File .\install-startup.ps1
pwsh -NoProfile -File .\install-startup.ps1 -Remove
pwsh -NoProfile -File .\stop.ps1
pwsh -NoProfile -File .\restart.ps1
pwsh -NoProfile -File .\uninstall.ps1
```

[詳しい Windows ガイド（英語）](WINDOWS.md) · [CHANGELOG](../CHANGELOG.md) · [NOTICE](../NOTICE.md)

公開ライセンスは未選定です。MIT／GPL は適用していません。NOTICE.md を確認してください。画像は ImageGen によるオリジナルの概念図で、実画面や保証ではありません。

## 引き継ぎ指示の言語と権限

元の session への引き継ぎ通知と新しい session の開始指示は、`en`、`zh-Hant`、`zh-Hans`、`ja`、`es`、`fr`、`ko`、`ru`、`de` の9言語に対応します。既定は英語で、メニュー5で保存した言語に従います。新規インストールでは `-HandoffLanguage ja` で個別指定できます。既存環境は停止後、`config.json` に `"handoffLanguage": "ja"` を追加して再起動してください。更新時は設定を保持します。この項目を削除するとメニューに連動します。一時的な `-Language` はバックグラウンド指示を変えません。1回の引き継ぎ内では言語を固定し、元の題名、パス、コマンド、権限値、確認コードは翻訳しません。

後続 session は、全体の既定値や管理タスクではなく、直前の session の実際の sandbox と承認設定を自動継承します。元が読み取り専用なら、全体が Full access でも読み取り専用を期待します。Codex の通常の継承経路を使い、送信前に元の権限を再確認し、作成後に書き込み範囲、ネットワーク制限、profile を検証します。元の権限が変われば読み直します。不明・不一致なら新しい ID を保持して停止し、昇格、全体設定変更、重複作成は行いません。読み取り専用で HANDOFF.md を保存できない場合は、ユーザーの通常の権限手続きが必要です。既存のローカル版を自動更新する機能ではありません。

