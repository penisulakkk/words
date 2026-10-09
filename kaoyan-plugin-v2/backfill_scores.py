"""把 words.db 里已有的 2026-10-08 评分与指正搬进界面缓存。

只搬已经存在的评分与 feedback（agent 当时给用户的指正原文），
不重新打分、不改记忆调度——记忆调度一直只在 words.db 里。
"""
import sqlite3, json, sys, os

SKILL = r"C:\Users\19827\Documents\deepseek-harness\default-workspace\.dsh\skills\kaoyan-daily"
sys.path.insert(0, os.path.join(SKILL, "scripts"))
from kaoyan_daily_ui import connect, init_db, cmd_score  # noqa: E402

DATE = "2026-10-08"
words = sqlite3.connect(os.path.join(SKILL, "data", "words.db"))
words.row_factory = sqlite3.Row

rows = words.execute(
    "SELECT sentence_id, score, feedback, user_translation FROM reviews"
    " WHERE date=? ORDER BY id", (DATE,)).fetchall()

conn = connect()
init_db(conn)
for r in rows:
    out = cmd_score(conn, DATE, r["sentence_id"], r["score"], r["feedback"], None)
    print("scored %s -> %s  (feedback %d 字)" % (
        r["sentence_id"], out["score"], len(r["feedback"] or "")))

plan = conn.execute(
    "SELECT date, ROUND(AVG(score),2) a, COUNT(*) n FROM reviews WHERE date=?"
    " GROUP BY date", (DATE,)).fetchone()
print("\n界面缓存 %s：%d 句，均分 %s" % (plan["date"], plan["n"], plan["a"]))
words.close()
