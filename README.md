# philtzjp/live-connector

<img src="https://github.com/philtzjp/.github/blob/main/images/philtz.png?raw=true" width="150px" alt="Philtz Logo">

live-connector は、Ableton Live を AI エージェントから操作するための MCP サーバーです。

配布済みの `.ablx` を Ableton Live にインストールすると、Live 起動時に `http://127.0.0.1:7799/api/v1/mcp` で MCP endpoint が起動します。Claude Code などの MCP クライアントから、Live Set のトラック、クリップ、デバイス、MIDI ノート、デバイスパラメータを読み書きできます。

> live-connector is an MCP server for controlling Ableton Live from AI agents. Install the `.ablx` file, restart Live, and connect your MCP client to `http://127.0.0.1:7799/api/v1/mcp`.

## 必要なもの

- Ableton Live（Extensions 対応の Beta ビルド）
- [live-connector v3.0.0](https://github.com/philtzjp/live-connector/releases/tag/v3.0.0) の `.ablx`
- Claude Code などの HTTP MCP クライアント

## インストール

1. [`live-connector-3.0.0.ablx`](https://github.com/philtzjp/live-connector/releases/download/v3.0.0/live-connector-3.0.0.ablx) をダウンロードします。
2. Ableton Live を起動し、Preferences → Extensions を開きます。
3. `Choose file` から `.ablx` を選択、または `.ablx` を Extensions ページへドロップします。
4. Developer Mode を OFF にします。
5. Ableton Live を再起動します。

![Ableton Live Extensions settings showing where to select the .ablx file and turn Developer Mode off](docs/assets/settings-instructions.png)

Live 起動後、ブラウザで次の URL を開きます。

<http://127.0.0.1:7799/health>

ページに次のような JSON が表示されれば、live-connector は起動しています。

```json
{"status":"pass","version":"3.0.0","description":"live-connector MCP server","tools":{ ... },"structure":{ ... }}
```

## Claude Code で使う

初回のみ、プロジェクトルートで MCP server を登録します。

```sh
claude mcp add --transport http live-connector http://127.0.0.1:7799/api/v1/mcp --scope project
```

登録後に Claude Code を再起動します。URL が変わらない限り、`.ablx` の再インストールや Live 再起動のたびに再登録する必要はありません。

## できること

v3.0.0 では MCP ツールが 4 つに統合されています。推奨フローは **meta → do read → do write → render → undo** です。

| 動詞 | ツール | できること |
| --- | --- | --- |
| 入口 | `meta` | サービス情報、LOM スキーマ、Cypher 文法契約、例文、Live Set overview |
| 見る・変える | `do` | Cypher で読み取り（MATCH … RETURN）と書き込み（SET / CREATE / DELETE / COPY） |
| 聴く | `render` | AudioTrack の指定範囲を Pre-FX オーディオとしてレンダリング |
| 戻す | `undo` | do 書き込みの取り消し（LIFO）。履歴は `do` read の `WriteEvent` 仮想ラベルで照会 |

読み取り例:

```cypher
MATCH (:Track {name:"Drums"})-[:HAS_DEVICE]->(:Device {name:"Operator"})-[:HAS_PARAM]->(p:Parameter {name:"Cutoff"})
RETURN p.value, p.min, p.max
```

書き込み例:

```cypher
MATCH (t:Track {name:"Drums"}) SET t.mute = true
```

```cypher
CREATE (t:MidiTrack {name:"Bass"})
```

## 注意点

- インストール済み `.ablx` を使う場合、Developer Mode は OFF にします。
- `localhost:7799` が起動しない場合は、Ableton Live を再起動し、`/health` を確認してください。
- v3.0.0 は **破壊的変更**です。v2.x の個別ツール名（`query` / `set_track` / `render_audio` 等）は存在しません。
- Ableton Extensions SDK v1.0.0-beta.0 には Browser API がないため、`.adv` / `.adg` / third-party plug-in のネイティブプリセットを Live へ直接読み込むことはできません。
- third-party plug-in の非公開内部状態や波形選択は保存・復元できません。デバイスパラメータの保存・復元は `do` read で Parameter 値を取得し、`do` SET で再適用してください（旧 `save_device_state` / `apply_device_state` は廃止）。
- SDK には MIDI 楽器トラックの合成出力を audio 化する手段がありません。`render` は AudioTrack の pre-FX 音声のみ対象です。MIDI 楽器の実音を検証するには、Live 上で対象トラックを AudioTrack へ手動で resample / freeze してから `render` を適用します（詳細は `llm/midi-audition.md`）。

## 開発

モノレポは pnpm + Turborepo で管理します。主なコマンド:

```sh
pnpm typecheck   # 全パッケージの型チェック
pnpm test        # vitest によるユニットテスト（実機・Ableton SDK 実体なしで完走）
pnpm lint        # Biome によるリント
pnpm format      # Biome によるフォーマット
```

`pnpm test` は `packages/cypher`（tokenizer / parser / evaluator / parseStatement）、`packages/lom-schema`（ラベル継承・サブタイプ判定）、`apps/extension`（フェイク SDK とフェイク MCP サーバーによる meta / do / undo / render ツール層）を検証します。`typecheck` と `test` は lefthook の `pre-push` で実行します。

## ライセンス

本リポジトリの自作コード・ドキュメント・アセットは [MIT](./LICENSE) です。

Ableton Extensions SDK は Ableton AG の第三者コンポーネントであり、本リポジトリには同梱していません。詳細は [NOTICE](./NOTICE) を参照してください。
