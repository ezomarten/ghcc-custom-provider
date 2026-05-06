# GHCC Custom Provider

日本語版 README です。英語版は [README.md](README.md) を参照してください。

GHCC Custom Provider は、Visual Studio Code の Language Model Chat Provider API を使って、GitHub Copilot Chat を OpenAI 互換エンドポイントや LM Studio に接続する拡張機能です。チャット対応 API を公開しているセルフホスト環境やサードパーティーのバックエンド向けに設計されています。Ollama 互換プロキシではなく、従来のプロキシ方式をそのまま置き換えるものでもありません。

> ステータス: 初版リリース 0.1.0 です。汎用の既定経路は `OpenAI-compatible` です。LM Studio では、ネイティブのモデル情報取得と OpenAI-compatible チャットを組み合わせる `LM Studio` を推奨します。LM Studio のネイティブチャット挙動が必要な場合だけ `LM Studio Native` を選んでください。

## 主な機能

- VS Code のモデル選択に、接続先バックエンドのチャットモデルを登録します。
- 複数の接続先を 1 つの管理画面で登録し、有効化した接続先のモデルを同時に使い分けられます。
- `OpenAI-compatible`、`LM Studio`、`LM Studio Native` に対応します。
- ツール転送、ツール数の上限、リクエストオプション、モデルごとの上書きを調整できます。
- 会話の継続に必要なデータを、ターン間や必要に応じて再読み込み後にも引き継げます。
- 接続テスト、ログ確認、診断用 Probe モデルの表示に対応します。
- API キーは VS Code SecretStorage に、その他の設定は拡張機能用ストレージに保存します。

## 動作要件

- Visual Studio Code 1.118 以降。
- 言語モデルプロバイダーを利用できる VS Code のチャット機能。
- 到達可能な接続先エンドポイントと、必要であれば API キー。

## インストール

- [Visual Studio Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ezomarten.ghcc-custom-provider) からインストールできます。
- オフライン導入や版固定の検証には `.vsix` パッケージを利用できます。

## クイックスタート

1. チャットのモデル選択を開き、GHCC Custom Provider のセットアップ項目を選ぶか、コマンドパレットから `GHCC Custom Provider: Manage Provider` を実行します。
2. 接続先の名前と Base URL を入力します。
3. 多くの接続先では `OpenAI-compatible` を選びます。LM Studio では、詳細なモデル情報を取得しつつ OpenAI-compatible チャットで動かす `LM Studio`、またはネイティブチャット API を使う `LM Studio Native` を選びます。
4. 接続先で必要なら API キーを設定します。
5. `Test connection` を実行します。
6. 取得できたモデルをチャットで選び、利用を開始します。

モデルが表示されない場合は、モデル選択に出るセットアップ項目が、未設定なのか、接続失敗なのか、チャットモデルが見つからなかったのかを示します。

## 設定のポイント

- `Send tools to endpoint`: 推論優先のローカルモデルや、VS Code のツール定義を渡したくない接続先では `Off` にします。
- `Tool limit`: 広告するツール数と転送するツール数を減らしたいときに使います。
- `Model Picker`: バックエンドモデルをモデルピッカーへ既定で表示できます。これを Off にしても、接続先が未設定・未接続の間は setup 項目を表示し続けるため、管理画面は開き直しやすいままです。
- `Common Settings`: 問題切り分け時に Probe モデル、詳細ログ、会話メモリの永続化を有効にできます。
- `Model Overrides`: 全モデル向けのツール対応、画像対応、トークン上限は簡易欄でまとめて上書きでき、必要なら従来どおり詳細JSONでモデルごとの調整もできます。

## コマンド

- `GHCC Custom Provider: Manage Provider`
- `GHCC Custom Provider: Show Logs`

必要に応じて、API キー操作や生の設定ファイルを扱う補助コマンドも利用できます。

## プライバシーと保存先

- API キーは VS Code SecretStorage に保存されます。
- 非機密の設定は `settings.json` ではなく、拡張機能用の保存領域に保存されます。
- リクエストは、利用者が設定した接続先にのみ送信されます。
- この拡張機能が独自のテレメトリをチャットリクエストへ追加することはありません。
- 診断ログは API キー、生のチャット本文、バックエンドの会話 ID を出力しない設計です。

## 注意点と制限

- 汎用接続先で推奨かつ最も検証が進んでいる既定経路は `OpenAI-compatible` です。
- `LM Studio` は LM Studio のネイティブなモデル一覧 API からコンテキスト長、画像入力、ツール利用可否などの詳細情報を取得し、チャットは OpenAI-compatible chat completions API へ送ります。Copilot のツールや Agent の流れにはこのモードを推奨します。
- `LM Studio Native` では LM Studio 固有の `/api/v1/chat` 会話継続を利用できますが、VS Code のカスタムツール定義はそのまま転送しません。
- バックエンドがターンを完了したのに可視の assistant テキストも tool call も返さなかった場合、この拡張は `Sorry, no response was returned.` に落ちる代わりに明示的なエラーを返します。多くは、そのターンで reasoning-only の出力になっていることを意味します。
- Copilot 側でツール予算が先に決まることがあるため、ローカルモデルがツール付き入力を苦手とする場合は `Send tools to endpoint` を `Off` にしてください。
- 会話継続まわりの一部挙動は VS Code と Copilot の transcript の扱いに依存するため、バージョンによって差が出る場合があります。

## ドキュメント

- Architecture notes: [docs/architecture.md](docs/architecture.md)
- Manual test plan: [docs/test-plan.md](docs/test-plan.md)
- Release and packaging notes: [docs/release.md](docs/release.md)

## ライセンス

MIT