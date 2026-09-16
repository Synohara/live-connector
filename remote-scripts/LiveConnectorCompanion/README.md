# live-connector companion Remote Script

`live-connector` 拡張の運用強化（無人運用の保護）を担う Live 側 Remote Script。
loopback TCP（既定 `127.0.0.1:11002`）+ JSON 行プロトコルで拡張と通信する。

## 役割

- **heartbeat 期限**: 録音中に拡張からの heartbeat が途絶えたら transport を停止し、`record_mode` off・録音トラック disarm・loop/punch/停止位置を復旧する
- **録音範囲上限**: 指定拍数を超えたら停止する
- **対象トラック検証**: 指定名のトラックが指定 index に 1 件だけ存在するかを確認する
- **同じ Set の確認**: トラック名の並びから Set epoch を算出し、拡張側と照合する
- **停止後の安全化**: 停止時に録音トラック arm 解除と設定復旧を行う

Live 自体がクラッシュした場合は救済しない（設計書 §9.1）。

## インストール

AbletonOSC と同様、Remote Scripts フォルダへ配置する。

- macOS: `~/Music/Ableton/User Library/Remote Scripts/LiveConnectorCompanion/`
- Windows: `\Users\[username]\Documents\Ableton\User Library\Remote Scripts\LiveConnectorCompanion\`

その後、Live の Preferences → Link/Tempo/MIDI → Control Surface に `LiveConnectorCompanion` を追加する（Input/Output は None）。Live 起動時に
`live-connector companion listening on 127.0.0.1:11002` が表示されれば起動している。

拡張側は `LIVE_CONNECTOR_COMPANION_ENABLED=true` で接続する（既定は無効）。

## プロトコル

1 行 1 メッセージの JSON。要求は `{"id","command","params"}`、応答は `{"id","ok","result"|"error"}`。

| command | params | 説明 |
| --- | --- | --- |
| `status` | - | version / setEpoch / transport / heartbeat |
| `heartbeat` | - | heartbeat を更新 |
| `verify_track` | `name`, `index` | 対象トラック検証 |
| `watch` | `enabled`, `deadlineMs`, `captureTrackName`, `maxCaptureBeats`, `startBeat`, `endBeat` | safety watcher の有効化・無効化 |
| `enforce_stop` | - | 即時停止と安全化 |
| `events` | - | 直近の安全イベント |

## ライセンス

本リポジトリの MIT に従う。
