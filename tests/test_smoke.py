"""スタブ Ollama を使った通しテスト:  python -m unittest discover -s tests"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

STUB = {"mode": "ok", "calls": 0}


class FakeOllama(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, body):
        body = json.dumps(body).encode()
        self.send_response(code); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        self.reply(200, {"models": [{"name": server.OLLAMA_MODEL}]})

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        STUB["calls"] += 1
        props = set((req.get("format") or {}).get("properties", {}))
        if STUB["mode"] == "down":
            return self.reply(500, {})
        if STUB["mode"] == "garbage" and STUB["calls"] % 2:
            out = "これはJSONではありません"
        elif not props:
            out = "やさしく言い換えた文章です。"
        elif "replies" in props:
            out = json.dumps({"replies": ["候補A", "候補B", "候補C"]})
        elif "groups" in props:
            out = json.dumps({"groups": [{"label": "G1", "answer_numbers": [1, 2, 99]}, {"label": "G2", "answer_numbers": [2, 3]}]})
        elif "action" in props:
            out = json.dumps({"topic_title": "t", "action": "followup", "text": "なるほど。具体的にはどんな場面ですか？", "quick_replies": ["毎日", "週1回"]})
        elif "key_points" in props:
            out = json.dumps({"summary": "テスト要約です。", "key_points": ["点1"], "answers": [], "sentiment": "neutral", "tags": ["a"]})
        elif "themes" in props:
            out = json.dumps({"overview": "全体像", "themes": [{"title": "論点", "description": "説明", "mentions": 99, "quotes": ["私の本当の発言", "捏造された引用"]}], "per_question": [], "recommendations": ["やる"]})
        else:
            out = json.dumps({"title": "AI作成", "description": "説明", "minutes": 5, "questions": [
                {"text": "Q1?", "guidance": "g", "quick_replies": ["a", "b"]}, {"text": "Q2?", "guidance": "", "quick_replies": []}]})
        self.reply(200, {"message": {"role": "assistant", "content": out}})


def call(base, method, path, body=None):
    req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def job(base, r):
    assert "job" in r, r
    for _ in range(200):
        _, j = call(base, "GET", "/interview/api/jobs/" + r["job"])
        if j["status"] != "running":
            return j
        time.sleep(0.05)
    raise AssertionError("job timeout")


class Smoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.mkdtemp()
        server.DATA_DIR = Path(tmp); server.DB_PATH = Path(tmp) / "interview.db"
        cls.fake = HTTPServer(("127.0.0.1", 0), FakeOllama)
        threading.Thread(target=cls.fake.serve_forever, daemon=True).start()
        server.OLLAMA_URL = f"http://127.0.0.1:{cls.fake.server_port}"
        server.init_db()
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler); cls.srv.daemon_threads = True
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.b = f"http://127.0.0.1:{cls.srv.server_port}"

    def setUp(self):
        STUB.update(mode="ok", calls=0)

    def test_full_flow(self):
        b = self.b
        _, r = call(b, "POST", "/interview/api/ai/draft", {"topic": "テスト"})
        d = job(b, r)
        self.assertEqual(d["status"], "done"); self.assertEqual(len(d["result"]["questions"]), 2)
        s, c = call(b, "POST", "/interview/api/interviews", {**d["result"], "max_followups": 1})
        self.assertEqual(s, 200)
        iid, tok = c["id"], c["admin_token"]
        self.assertEqual(call(b, "GET", "/interview/api/m/wrongtoken/interview")[0], 404)
        _, a = call(b, "GET", f"/interview/api/m/{tok}/interview")
        self.assertEqual(a["interview"]["id"], iid); self.assertNotIn("admin_hash", a["interview"])
        _, sess = call(b, "POST", f"/interview/api/a/{iid}/sessions")
        sid = sess["id"]; self.assertIn("Q1?", sess["messages"][0]["text"])
        _, r = call(b, "POST", f"/interview/api/s/{sid}/message", {"text": "私の本当の発言", "cid": "c1"})
        out = job(b, r)["result"]["session"]
        self.assertEqual(out["messages"][-1]["quick_replies"], ["毎日", "週1回"])
        _, r2 = call(b, "POST", f"/interview/api/s/{sid}/message", {"text": "私の本当の発言", "cid": "c1"})
        sess2 = r2.get("session") or job(b, r2)["result"]["session"]
        self.assertEqual(len([m for m in sess2["messages"] if m["role"] == "user"]), 1)  # 二重送信で増えない
        _, r = call(b, "POST", f"/interview/api/s/{sid}/message", {"text": "毎日です", "cid": "c2"})
        out = job(b, r)["result"]["session"]
        self.assertIn("Q2?", out["messages"][-1]["text"]); self.assertEqual(out["progress"]["current"], 2)  # 上限1回で強制的に次へ
        _, r = call(b, "POST", f"/interview/api/s/{sid}/message", {"skip": True, "cid": "c3"})
        out = job(b, r)["result"]["session"]
        self.assertEqual(out["stage"], "summary"); self.assertEqual(out["summary"]["summary"], "テスト要約です。")
        _, fin = call(b, "POST", f"/interview/api/s/{sid}/finish")
        self.assertEqual(fin["session"]["stage"], "done")
        _, r = call(b, "POST", f"/interview/api/m/{tok}/report")
        rep = job(b, r)["result"]
        self.assertEqual(rep["themes"][0]["quotes"], ["私の本当の発言"])  # 捏造引用は除去
        self.assertEqual(rep["themes"][0]["mentions"], 1)  # 人数を超えない
        with urllib.request.urlopen(f"{b}/interview/api/m/{tok}/export.csv") as x:
            self.assertIn("私の本当の発言", x.read().decode("utf-8-sig"))
        self.assertEqual(call(b, "PUT", f"/interview/api/m/{tok}/interview", {"status": "closed"})[0], 200)
        self.assertEqual(call(b, "POST", f"/interview/api/a/{iid}/sessions")[0], 403)

    def test_answer_helpers(self):
        b = self.b
        _, c = call(b, "POST", "/interview/api/interviews", {"title": "h", "max_followups": 0, "questions": [{"text": "A?", "quick_replies": ["案1"]}, {"text": "B?"}, {"text": "C?"}]})
        iid, tok = c["id"], c["admin_token"]
        _, sess = call(b, "POST", f"/interview/api/a/{iid}/sessions"); sid = sess["id"]
        # 候補を自動生成（他の候補は既出を除く）
        _, r = call(b, "POST", f"/interview/api/s/{sid}/suggest", {"exclude": ["候補A"]})
        res = job(b, r)["result"]; self.assertEqual(res["quick_replies"], ["候補B", "候補C"])
        _, st = call(b, "GET", f"/interview/api/s/{sid}")
        self.assertEqual(st["session"]["messages"][-1]["quick_replies"], ["候補B", "候補C"])  # 保存されて再読込でも残る
        # 言い換え
        _, r = call(b, "POST", f"/interview/api/s/{sid}/rephrase")
        self.assertIn("言い換え", job(b, r)["result"]["session"]["messages"][-1]["text"])
        # 文章整形
        _, r = call(b, "POST", f"/interview/api/s/{sid}/polish", {"text": "これはかきかけのぶんしょうです"})
        self.assertEqual(job(b, r)["status"], "done")
        # 回答（候補そのまま）→ 次の質問、取り消しで元に戻り、本文が返る
        _, r = call(b, "POST", f"/interview/api/s/{sid}/message", {"text": "案1", "cid": "a1", "via": "chip"})
        self.assertEqual(job(b, r)["result"]["session"]["progress"]["current"], 2)
        _, u = call(b, "POST", f"/interview/api/s/{sid}/undo")
        self.assertEqual(u["removed"], "案1"); self.assertEqual(u["session"]["progress"]["current"], 1)
        self.assertEqual(u["session"]["messages"][-1]["role"], "assistant")
        # 自由記述と via 集計・分類（番号は検証され重複/範囲外は除外）
        for i, (t, via) in enumerate([("案1", "chip"), ("自分の言葉", "typed"), ("案1と追加", "mixed")]):
            _, s2 = call(b, "POST", f"/interview/api/a/{iid}/sessions")
            _, r = call(b, "POST", f"/interview/api/s/{s2['id']}/message", {"text": t, "cid": f"x{i}", "via": via}); job(b, r)
        _, an = call(b, "GET", f"/interview/api/m/{tok}/answers")
        self.assertEqual([a["text"] for a in an["questions"][0]["answers"]], ["案1", "自分の言葉", "案1と追加"])
        self.assertEqual([a["who"] for a in an["questions"][0]["answers"]], [2, 3, 4])  # 回答者番号は開始順（未回答の先頭セッションも1人目）
        _, r = call(b, "POST", f"/interview/api/m/{tok}/cluster", {"qid": an["questions"][0]["id"]})
        g = job(b, r)["result"]["groups"]
        self.assertEqual([(x["label"], x["count"]) for x in g], [("G1", 2), ("G2", 1)])
        # 結果の公表: 発行前は 404、発行後は閲覧可、原文は設定でのみ出る、停止で無効化
        self.assertEqual(call(b, "GET", "/interview/api/r/nope")[0], 404)
        _, sh = call(b, "POST", f"/interview/api/m/{tok}/share", {"action": "enable", "answers": False})
        _, pub = call(b, "GET", f"/interview/api/r/{sh['share_token']}")
        self.assertEqual(pub["questions"][0]["answers"], []); self.assertNotIn("admin_token", json.dumps(pub))
        self.assertEqual(pub["questions"][0]["clusters"]["groups"][0]["label"], "G1")
        _, sh2 = call(b, "POST", f"/interview/api/m/{tok}/share", {"action": "enable", "answers": True})
        self.assertEqual(sh2["share_token"], sh["share_token"])  # 再 enable でトークンは変わらない
        _, pub = call(b, "GET", f"/interview/api/r/{sh['share_token']}")
        self.assertEqual(len(pub["questions"][0]["answers"]), 3)
        _, sh3 = call(b, "POST", f"/interview/api/m/{tok}/share", {"action": "rotate", "answers": True})
        self.assertEqual(call(b, "GET", f"/interview/api/r/{sh['share_token']}")[0], 404)
        call(b, "POST", f"/interview/api/m/{tok}/share", {"action": "disable"})
        self.assertEqual(call(b, "GET", f"/interview/api/r/{sh3['share_token']}")[0], 404)

    def test_ollama_down_degrades_gracefully(self):
        b = self.b
        _, c = call(b, "POST", "/interview/api/interviews", {"title": "x", "questions": [{"text": "A?"}, {"text": "B?"}]})
        _, sess = call(b, "POST", f"/interview/api/a/{c['id']}/sessions")
        STUB["mode"] = "down"
        _, r = call(b, "POST", f"/interview/api/s/{sess['id']}/message", {"text": "回答", "cid": "z"})
        out = job(b, r)["result"]["session"]
        self.assertIn("B?", out["messages"][-1]["text"])  # 固定質問で継続
        _, r = call(b, "POST", f"/interview/api/s/{sess['id']}/message", {"text": "回答2", "cid": "y"})
        self.assertEqual(job(b, r)["result"]["session"]["stage"], "summary")  # 要約もフォールバック
        _, e = call(b, "POST", "/interview/api/ai/draft", {"topic": "t"})
        self.assertEqual(job(b, e)["status"], "error")

    def test_garbage_output_is_retried(self):
        STUB["mode"] = "garbage"
        _, r = call(self.b, "POST", "/interview/api/ai/draft", {"topic": "t"})
        self.assertEqual(job(self.b, r)["status"], "done")

    def test_recover_rotates_token(self):
        _, c = call(self.b, "POST", "/interview/api/interviews", {"title": "r", "questions": [{"text": "A?"}]})
        env = {**os.environ, "DATA_DIR": str(server.DATA_DIR), "PUBLIC_URL": "https://x.example"}
        out = subprocess.run([sys.executable, str(Path(server.__file__)), "recover", c["id"]], env=env, capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        new = out.stdout.strip().splitlines()[-1].rsplit("/", 1)[1]
        self.assertEqual(call(self.b, "GET", f"/interview/api/m/{c['admin_token']}/interview")[0], 404)
        self.assertEqual(call(self.b, "GET", f"/interview/api/m/{new}/interview")[0], 200)

    def test_pages(self):
        for p in ("/interview/", "/interview/a/abc", "/interview/static/app.js"):
            with urllib.request.urlopen(self.b + p) as r:
                self.assertEqual(r.status, 200)
        with urllib.request.urlopen(self.b + "/interview/") as r:
            self.assertIn('content="/interview"', r.read().decode())


if __name__ == "__main__":
    unittest.main()
