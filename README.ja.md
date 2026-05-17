# GHCC Custom Provider

日本語版 README です。英語版は [README.md](README.md) を参照してください。

GHCC Custom Provider は、Visual Studio Code の Language Model Chat Provider API を使って、GitHub Copilot Chat を OpenAI 互換エンドポイントや LM Studio に接続する拡張機能です。チャット対応 API を公開しているセルフホスト環境やサードパーティーのバックエンド向けに設計されています。Ollama 互換プロキシではなく、従来のプロキシ方式をそのまま置き換えるものでもありません。

## 主な機能

- VS Code のモデル選択に、接続先バックエンドのチャットモデルを登録します。
- 複数の接続先を 1 つの管理画面で登録し、有効化した接続先のモデルを同時に使い分けられます。
- `OpenAI-compatible (Chat Completions API)`、`OpenAI-compatible (Responses API)`、`LM Studio (Chat Completions API)`、`LM Studio (Responses API)`、`LM Studio Native` に対応します。
- ツール転送、ツール数の上限、リクエストオプション、モデルごとの上書きを調整できます。
- 会話の継続に必要なデータを、ターン間や必要に応じて再読み込み後にも引き継げます。
- 接続テスト、ログ確認、診断用 Probe モデルの表示に対応します。
- API キーは VS Code SecretStorage に、その他の設定は拡張機能用ストレージに保存します。

## 動作要件

- Visual Studio Code 1.118 以降。
- 言語モデルプロバイダーを利用できる VS Code のチャット機能。
- 到達可能な接続先エンドポイントと、必要であれば API キー。
- Dev Container や Remote SSH などのリモートウィンドウでは、GitHub Copilot Chat と同じリモート側の拡張ホストでこの拡張が実行される必要があります。拡張機能の実行中一覧で `GHCC Custom Provider` がコンテナまたはリモート側に表示されることを確認してください。

### Dev Container / Remote 利用時

- この拡張の非シークレット設定は、実行中の拡張ホストの `globalStorageUri` に保存されます。API キーは同じ拡張ホストの SecretStorage に保存されます。そのため、ホスト側にインストールした拡張の設定と、コンテナ側にインストールした拡張の設定は自動共有されません。
- 設定済みの非シークレット設定は VS Code の同期対象 `globalState` にもミラーされます。コンテナ側に設定ファイルがない、または未設定の場合、同期済みミラーから自動インポートを試みます。VS Code Settings Sync が無効、または同期がまだ届いていない場合は手動移行が必要です。
- ホスト側で設定を変更したあとにコンテナ側へ再取り込みしたい場合は、管理画面の `Common Settings` から `同期設定を取り込む` を実行できます。これは非シークレット設定だけを上書きします。
- API キーは接続先ごとに `VS Code SecretStorage` または `Environment variable` を選べます。SecretStorage は推奨ですが拡張ホストごとに分離されます。環境変数は Dev Container や CI で同じ設定を使いやすい一方、コンテナ環境へ安全に注入する管理が必要です。Dev Container では、シェルに存在するだけでは拡張ホストから見えないことがあるため、必要に応じて `devcontainer.json` の `remoteEnv` または `containerEnv` で渡してください。
- 環境変数を選んでいても、現在の拡張ホストから変数が見えない場合は、チャット開始時にこのコンテナの SecretStorage へ API キーを保存するか確認します。保存すると、その拡張ホストでは環境変数の代わりに SecretStorage fallback として利用できます。
- Advanced opt-in として、現在見えている API キーをパスフレーズで暗号化して VS Code Settings Sync 対象の `globalState` へ保存し、別の拡張ホストで復号して SecretStorage に取り込めます。管理画面の `API key を暗号化して同期` / `暗号化 API key を取り込む` を使います。パスフレーズは保存されません。忘れた場合、同期済みの暗号化 API キーは復号できません。
- LM Studio などがホスト OS 上で待ち受けている場合、コンテナ内の `127.0.0.1` はコンテナ自身を指します。既定の `Auto` では Docker コンテナ系 Remote 上で実行中、`localhost` / `127.0.0.1` を実通信時だけ `host.docker.internal` に読み替えます。接続先がコンテナ内で動いている場合は `Container localhost rewrite` を `Off` にしてください。
- 特定の Dev Container でこの拡張を自動インストールしたい場合は、そのリポジトリの `devcontainer.json` に `customizations.vscode.extensions` を追加してください。拡張自身の `package.json` だけで、任意のユーザーのコンテナへこの拡張を自動インストールすることはできません。

## インストール

- [Visual Studio Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ezomarten.ghcc-custom-provider) からインストールできます。
- オフライン導入や版固定の検証には `.vsix` パッケージを利用できます。

## クイックスタート

1. チャットのモデル選択を開き、GHCC Custom Provider のセットアップ項目を選ぶか、コマンドパレットから `GHCC Custom Provider: Manage Provider` を実行します。
2. 接続先の名前と Base URL を入力します。
3. 多くの接続先では `OpenAI-compatible (Chat Completions API)` を選びます。OpenAI Responses API または Open Responses 互換の `/v1/responses` を明示的に提供する接続先では `OpenAI-compatible (Responses API)` を選べます。LM Studio では、詳細なモデル情報を取得しつつ `/v1/chat/completions` で動かす `LM Studio (Chat Completions API)`、`/v1/responses` 対応時だけ選ぶ `LM Studio (Responses API)`、またはネイティブチャット API を使う `LM Studio Native` を選びます。
4. 接続先で必要なら API キーを設定します。
5. `Test connection` を実行します。
6. 取得できたモデルをチャットで選び、利用を開始します。

モデルが表示されない場合は、モデル選択に出るセットアップ項目が、未設定なのか、接続失敗なのか、チャットモデルが見つからなかったのかを示します。
拡張機能ビュー上のこの拡張の `Settings` 操作は、従来の設定 UI ではなく `Manage Provider` を開くようになりました。

## 設定のポイント

- `Send tools to endpoint`: 推論優先のローカルモデルや、VS Code のツール定義を渡したくない接続先では `Off` にします。
- `Tool limit`: 広告するツール数と転送するツール数を減らしたいときに使います。
- `Preserved thinking limit`: `reasoning_content` として保存または再送する hidden thinking の上限です。超過時は、結論に近いことが多い末尾を残します。未入力時は `64000` 文字までです。`0` にすると LM Studio Native の response ID などは残しつつ推論本文を破棄できます。`-1` は無制限ですが非推奨です。
- `Synthetic replay limit`: 合成 system replay prompt に入れる hidden thinking の上限です。超過時は先頭と末尾を残し、中間を省略します。未入力時は `12000` 文字までです。`0` にすると合成 replay を無効化できます。`-1` は無制限ですが非推奨です。
- `Store Responses state`: Responses API 専用です。`store: true` と `previous_response_id` によるサーバー側の会話継続を使いたい場合に `On` にします。既定では `store: false` を維持します。`Auto` では互換のため、従来の Advanced Custom JSON `{ "store": true }` も引き続き有効です。
- `Model Picker`: バックエンドモデルをモデルピッカーへ既定で表示できます。これを Off にしても、接続先が未設定・未接続の間は setup 項目を表示し続けるため、管理画面は開き直しやすいままです。
- `Common Settings`: 問題切り分け時に Probe モデル、詳細ログ、会話メモリの永続化を有効にできます。
- `Model Overrides`: 全モデル向けのツール対応、画像対応、トークン上限は簡易欄でまとめて上書きでき、必要なら従来どおり詳細JSONでモデルごとの調整もできます。
- `API key source`: SecretStorage または環境変数を接続先ごとに選べます。Remote/Dev Container で同じ endpoint 定義を使い回す場合は環境変数が便利です。
- `Import Synced Settings`: VS Code Settings Sync にミラーされた非シークレット接続先設定を、現在の拡張ホストへ再取り込みします。
- `Export/Import Encrypted API Keys`: パスフレーズで暗号化した API key を VS Code Settings Sync 経由で別の拡張ホストへ移し、移行先の SecretStorage に取り込めます。

## コマンド

- `GHCC Custom Provider: Manage Provider`
- `GHCC Custom Provider: Show Logs`

必要に応じて、API キー操作や生の設定ファイルを扱う補助コマンドも利用できます。

## プライバシーと保存先

- API キーは VS Code SecretStorage に保存されます。
- 非機密の接続先設定は `settings.json` ではなく、拡張機能のグローバル保存領域に保存されます。同じ VS Code ユーザープロファイルのウィンドウ間で共有されます。
- リクエストは、利用者が設定した接続先にのみ送信されます。
- この拡張機能が独自のテレメトリをチャットリクエストへ追加することはありません。
- 診断ログは API キー、生のチャット本文、バックエンドの会話 ID を出力しない設計です。

## 注意点と制限

- Dev Container などでモデルは表示されるのに会話時の応答がなく、`GHCC Custom Provider` ログにも `Language model chat response requested` が出ない場合は、拡張ホストの実行場所がずれている可能性があります。拡張をコンテナ側にもインストールして再読み込みし、ログの `extensionKind=workspace` と `remoteName=...` を確認してください。
- コンテナ側へインストール後にホスト側の接続先が表示されない場合は、拡張ホストごとに保存領域と SecretStorage が分かれていることが原因です。非シークレット設定は raw settings を移し、API キーはコンテナ側で再登録してください。
- 非シークレット設定の同期ミラーは SecretStorage の内容を含みません。同期後に API キー未設定になる場合は、接続先の `API key source` を環境変数にするか、その拡張ホストの SecretStorage に登録してください。
- 環境変数を API key source にした場合でも、変数が現在の拡張ホストの `process.env` に存在しなければ使えません。Dev Container では `remoteEnv` / `containerEnv` を設定したあと、コンテナまたは VS Code ウィンドウを再起動してください。
- 暗号化 API key 同期は opt-in の移行補助です。暗号化済みデータは Settings Sync に保存されるため、パスフレーズは十分長くし、共有端末や管理外のプロファイルでは利用しないでください。
- 汎用接続先で推奨かつ最も検証が進んでいる既定経路は `OpenAI-compatible (Chat Completions API)` です。
- `OpenAI-compatible (Responses API)` は `/v1/models` でモデル一覧を取得し、チャットは `/v1/responses` へ送ります。OpenAI Responses API と、それに基づく Open Responses 互換プロバイダー向けの任意経路です。
- `LM Studio (Chat Completions API)` は LM Studio のネイティブなモデル一覧 API からコンテキスト長、画像入力、ツール利用可否などの詳細情報を取得し、チャットは `/v1/chat/completions` へ送ります。Copilot のツールや Agent の流れにはこのモードを推奨します。
- `LM Studio (Responses API)` は LM Studio のネイティブなモデル一覧 API を使い、チャットは `/v1/responses` へ送ります。LM Studio または互換接続先が Responses 対応を明示している場合だけ選びます。
- Responses API 系の種別は既定で `store: false` を送ります。`Preserve thinking` が `On` のときは `reasoning.encrypted_content` を要求し、返却された reasoning item を hidden state に保存して次ターンへ再送します。stateful な `previous_response_id` 継続が必要な場合だけ `Store Responses state` を `On` にしてください。
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