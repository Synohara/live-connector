# 引き継ぎ書 — live-connector ゲインステージング / Hybrid Runtime

最終更新: 2026-09-17 09:00 頃

## 0. これは何か

`live-connector-hybrid-design.md`（`~/Downloads/`）の仕様を、フォーク `Synohara/live-connector` に実装中。
本ドキュメントは「次に触るエージェント」向けの作業状態の引き継ぎ。ルールは `AGENTS.md` / `CLAUDE.md` に従う（日本語回答、`issue-branch-pr-flow`、`commit-and-git`、`typescript-monorepo`）。

## 1. 目的と合意事項（ユーザー決定）

- **ゲインステージングの定義**: 各デバイスを順に通したとき、**各段のゲインが一貫して VU 0（-18 dBFS RMS）**になるよう調整する作業。最終出力を目標に寄せるのでは**ない**。
- VU 0 目標 = **-18 dBFS RMS**。
- トランジェント／低 VU 音（snare 等）= **PEAK -6 dBFS**（`auto`: crest > 12 dB → peak、target + 12）。
- Main キャプチャ = **PEAK -1 dBFS**。
- **トラック volume は触らない**。変更した 4 トラックは 0.85 に復元済み。
- Dry/Wet は自動では触らない（音色が変わるため）。明示 `param` 指定時のみ可。
- ログは `packages/log`、エラーは `packages/error`、環境変数は `packages/env` に集約。

## 2. ブランチ / PR / Issue

| ブランチ | PR | Issue | 状態 |
| --- | --- | --- | --- |
| `feat/1-hybrid-osc-main-render` | #2 | #1 | **merge 済み**（main `d74dff1`、3.1.0） |
| `feat/3-gain-staging` | #4 | #3 | draft。**現在作業中** |
| `feat/4-p5-operational-hardening` | #6 | #5 | draft |

最新コミット（`feat/3-gain-staging`）:

```
fbe436f feat(extension): chain の段結果をログへ記録する
d25b30e feat(extension): 段ごとに VU0 へ揃える gainstage.chain を追加する
b3bd4fe fix(extension): 計測前にメーターを整定して過小補正を防ぐ
022c1e4 fix(extension): 計測前に Transport を停止して競合を避ける
f10acd8 feat(extension): デバイスの入力ゲイン候補と明示指定に対応する
b9edd3b feat(extension): トラック収束に VU/PEAK の自動選択を追加する
```

## 3. 実装済み

- 3.1.0: Hybrid Runtime、OSC アダプタ、`render source:"main"`、限定 `CALL`、`Transport` 仮想ノード、`RenderJob` 拡張、annotations、docs。実機で Main キャプチャ成功。
- P5: companion Remote Script（`remote-scripts/LiveConnectorCompanion/`、TCP+JSON 行、status/heartbeat/verify_track/watch/enforce_stop/events）、`apps/extension/src/companion/{client,protocol,epoch}.ts`、artifact registry、runtime capabilities。Main キャプチャ成功、`companion safety stop: range` / `: heartbeat` 確認。
- ゲインステージング: `render/levels.ts`（RMS/peak、WAV/AIFF デコード）、`Meter` 仮想ノード、`gainstage.measure/track/device/main/chain`、`auto` metric、二分探索収束、`originalValue` 返却、未収束時復元、メーター整定。
- Artifact 配信: `GET /api/v1/artifacts/<jobId>/<token>`、実機で 200/403/400/404 確認済み。

## 4. 未コミットの変更（`apps/extension/src/tools/do/gainstage.ts`、+67/-14）

ユーザーが画像で「値が小さすぎ」と指摘した件への対策。**未コミット・未 PR 反映**。

1. **計測前のメーター減衰待ち**（過小補正の根本対策）
   - 定数: `METER_DECAY_TIMEOUT_MS = 4_000`、`METER_DECAY_THRESHOLD = 0.005`
   - 停止中に `routing.getOutputMeterLevel(index)` を 100ms 間隔でポーリングし、しきい値以下になるまで待ってから再生。
2. **chain 失敗時に収束済みの段ゲインを復元**
   - `applied_stages: { label, restore }[]` を蓄積し、`catch` で逆順に復元してから rethrow。
   - 従来は `Device On` しか戻さず、Granulator Volume が -59 のまま残った。
3. **効かない段はスキップして続行**
   - `GAINSTAGE_NOT_CONVERGED` を段単位で捕捉し `status: "skipped"` として記録、`continue`。
   - 従来は OTT.Output のような「レベルを変えない段」でチェーン全体が中断していた。

状態: `biome check` / `typecheck` / `test` は通過済み。**未コミット**。

## 5. 判明した原因（重要）

- **値が小さく見えるのは仕様**:
  - `Utility.Output` 等は **-1..1 の正規化パラメータ**（dB 直ではない）。小さい値は正常。
  - `Volume`（Granulator III 等）は **dB 直**（min -60 / max +6）。
  - Live の fader は非線形。実測: 0.85→-3.0 dBFS、0.5→-6.2、0.25→-10.6、0.15→-16.1、0.10→-24.0、0.073→-40.4。
- **過小補正の真因**: Live メーターのピーク保持（リリース遅れ）。値を大きく下げた直後は古い高い値が残り、短い測定窓では「まだ目標より大きい」と誤判定し、下限まで下げ続ける（例: Granulator Volume -14 → -59）。`MEASURE_SETTLE_MS=800` だけでは不足。
- **OTT の `Output` はレベルを変えない**（アップワードコンプ／内部正規化）。無反応を致命扱いするとチェーンが全滅する。

## 6. 直近の実測結果（修正後、`GRAN | Metal Splinters`、目標 -18）

```
status ok
  GRAN | Metal Splinters Volume                status not_converged orig -14 applied -14  before -2.61 after -17.27 conv False
  REF | Breaks OTT Output                     status skipped
  REF | Breaks Saturator Drive                status skipped
  Granular peak control Input Gain            status not_converged orig 0.5 applied 0.5 before -2.98 after -8.07 conv False
```

解釈:
- 中断・異常復元は解消。段スキップも機能。
- ただし **許容値 ±0.5 dB が厳しく**、-17.27（目標 -18、差 0.73 dB）でも「未収束」として**元に戻す**ため、実質何も適用されない。→ 次項。

## 7. 次にやること

1. **収束判定の緩和 or ベストエフォート適用**（最優先）
   - 環境変数で試す: `LIVE_CONNECTOR_GAINSTAGE_TOLERANCE_DB=1.0`、`LIVE_CONNECTOR_GAINSTAGE_MAX_ITERATIONS=12`（既定は 0.5 / 8）。
   - 恒久策の候補: 未収束でも「最も近い値」を適用して `converged: false` で返す（何もしないより良い）。または測定拍数 `LIVE_CONNECTOR_GAINSTAGE_MEASURE_BEATS`（既定 8）を増やす。
2. **未コミット変更のコミット**（`feat/3-gain-staging`、PR #4 へ）。
3. **全トラック `gainstage.chain` の再実行と集計**（成功／スキップ理由／未収束）。
4. **KICK の元値**: `JT_PV2_95_kick_loop_catch.Volume = -26`、`Compressor.Output = 1.5` が chain により変更済み。元値は応答取りこぼしで未取得。復元可否をユーザーに確認。
5. gain 系パラメータを持たない楽器（`Ac Strings Orch` 等）はスキップ扱いで良いか確認。

## 8. 実機環境・運用手順

- Live **12.4.15b3**（設計は b2 想定）。AbletonOSC master 11000（応答 11001）、companion **11002**、開発ホスト `extensions-cli run` で **7799**。Developer Mode ON。
- 開発ホスト起動（`apps/extension` から）:

```sh
pkill -f "cli.mjs run"; sleep 3
LIVE_CONNECTOR_OSC_ENABLED=true \
LIVE_CONNECTOR_GAINSTAGE_TOLERANCE_DB=1.0 LIVE_CONNECTOR_GAINSTAGE_MAX_ITERATIONS=12 \
./node_modules/.bin/extensions-cli run --live "/Applications/Ableton Live 12 Beta.app" \
  --storage-directory /tmp/lc-dev-storage --temp-directory /tmp/lc-dev-temp
```

- 強制終了後は Developer Mode をトグルして再接続。再起動で稀に旧ビルドが応答 → `pkill -f "cli.mjs run"` で全停止してから起動。
- 現行 Set: `Shostakovich8_Movement_III_Footwork_Serum2_v01`（27 regular tracks、tempo 160）。
- `do` の read は LIMIT 省略で 500 行 truncate。パラメータ探索は `WHERE p.name IN [...]` で絞る。

## 9. 一時スクリプト（リポジトリ外、`/var/folders/pj/v76nw3s5695b6yq3l9hh7gzw0000gn/T/opencode/`）

- `mcpcall.py` / `oscsend.py`: MCP `do` 呼び出し、OSC 送信。
- `chain_all.py`（ログ `chain-all.jsonl` / `chain-all.log`）: 全トラック chain 実行。**現在停止中**。
- `gainstage_driver.py` / `device_driver.py`: 個別検証。
- 直近ログ: `devhost34.log` / `devhost35.log` / `devhost36.log`。

## 10. 変更ファイル早見

- `apps/extension/src/tools/do/{gainstage,call}.ts`: ゲインステージング本体（二分探索、`MEASURE_SETTLE_MS`、`AUTO_CREST_THRESHOLD_DB=12`、`AUTO_PEAK_OFFSET_DB=12`、`GAIN_PARAMETER_NAMES`、`gainstage.chain`）。
- `apps/extension/src/render/{levels,artifacts,artifact-registry,journal,plan,jobs,capture-state}.ts`。
- `apps/extension/src/osc/{codec,client,protocol,transport,routing,verify}.ts`。
- `apps/extension/src/companion/{client,protocol,epoch}.ts`、`remote-scripts/LiveConnectorCompanion/{__init__,manager}.py`。
- `apps/extension/src/runtime/{runtime,capabilities,locks,resolver,procedures}.ts`。
- `packages/env/src/index.ts`、`packages/error/src/index.ts`、`packages/cypher/src/*`、`packages/lom-schema/src/{schema,types}.ts`。

## 11. 注意

- `feat/3` と `feat/4` で `packages/env` 等の内容が異なる。ブランチを跨ぐときは要確認。
- commit は `type(scope): 日本語`、`--author="DeepSeek <noreply@deepseek.com>"`、`Co-Authored-By` なし、`git add .` 禁止。
- マージ前に ahead/behind の同期確認（`issue-branch-pr-flow`）。
