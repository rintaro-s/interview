# AI Interview

聞きたいことを書くだけで AI が質問を作り、回答者と 1 対 1 でインタビューして、レポートまで作る。
Python 標準ライブラリだけで動作（`pip install` 不要）。LLM はこのマシンの **Ollama** を使う。

## 起動

```bash
ollama pull hf.co/LuffyTheFox/Qwen3.6-35B-A3B-Uncensored-Genesis-Hermes-Final-GGUF:latest
ollama serve            # 起動していなければ
python server.py        # → http://localhost:8787/interview/
```

## ドメイン/interview で公開

アプリ自体が `/interview` 配下で動く（`BASE_PATH` で変更可）。リバースプロキシで転送するだけ。

```caddy
# Caddy
example.com {
    handle /interview* { reverse_proxy 127.0.0.1:8787 }
}
```
```nginx
# nginx
location /interview { proxy_pass http://127.0.0.1:8787; proxy_set_header X-Forwarded-For $remote_addr; }
```
Cloudflare Tunnel 等でも可。プロキシ経由なら `TRUST_PROXY=1 PUBLIC_URL=https://example.com` も指定する
（レート制限が実 IP で効く／`recover` が正しい URL を表示する）。
LLM 処理はジョブ化してポーリングで待つため、プロキシの 100 秒タイムアウト等に影響されない。

## 使い方

1. トップで聞きたいことを書く → **質問を作成** → 確認して **公開**
2. 発行された 2 つのリンクを使う
   - **回答用リンク** `/interview/a/<ID>` … 回答者に共有（ログイン不要）
   - **管理用リンク** `/interview/m/<TOKEN>` … あなた専用。質問編集（自動保存）・回答閲覧・AIレポート・設定・CSV/MD/JSON 出力
3. 管理画面「レポート」タブの下部で **結果の公表リンク** `/interview/r/<TOKEN>` を発行できる（ログイン不要の閲覧専用ページ。再発行・停止も可。回答者ごとの会話全文は公開されない。回答の原文と引用は匿名でオプション公開）
4. 管理画面の「テスト回答する」で実際の流れを試せる（テスト回答は集計・レポートに含まれない）

## 管理用リンクをなくしたら（手動復旧）

管理用リンクはサーバーにハッシュしか保存されず、再表示できない。サーバー上で手動で再発行する:

```bash
python server.py list              # インタビューID を確認
python server.py recover <ID>      # 新しい管理用リンクを発行（旧リンクは無効化）
```

## 設定（環境変数）

| 変数 | 既定値 | 説明 |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | 待受 |
| `BASE_PATH` | `/interview` | 公開パス（`/` で直下） |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | |
| `OLLAMA_MODEL` | `hf.co/LuffyTheFox/Qwen3.6-35B-A3B-Uncensored-Genesis-Hermes-Final-GGUF:latest` | |
| `LLM_CONCURRENCY` | `1` | 同時 LLM 呼び出し数（VRAM に合わせる） |
| `LLM_TIMEOUT` / `LLM_NUM_CTX` | `400` / `8192` | |
| `DATA_DIR` | `./data` | SQLite（`interview.db`）の場所。**バックアップ対象** |
| `TRUST_PROXY` / `PUBLIC_URL` | 空 | 上記参照 |

## 安定動作の仕組み

- 進行（何問目か・深掘り回数）は **サーバーが管理**。AI は「深掘り / 次へ / 終了」を JSON で返すだけで、次の質問文は事前定義のまま表示（言い換えやスキップの事故がない）。
- AI の出力は JSON スキーマで制約・検証し、失敗時は再試行。それでも失敗なら **固定質問で継続**、要約は回答抜粋にフォールバック（回答者が止まらない）。
- 送信は `cid` で冪等。通信断・二重送信・ページ再読込でも発言が重複せず、返信待ちなら自動で続行。同じブラウザなら再開できる。
- レポートの引用は実際の回答者発言と照合し、AI が作った引用は除去。言及人数は回答者数を超えない。
- 「終了」は回答者が終了を望んだときだけ途中終了できる。

## テスト

```bash
python -m unittest discover -s tests   # スタブ Ollama で通しテスト
```
