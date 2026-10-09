"""kaoyan_daily_ui.py 的自检脚本：跑一遍界面层用到的全部入口并断言结果。

用法:
    python _test_bridge.py
"""
import json
import os
import subprocess
import sys
import tempfile

PY = r"C:\Users\19827\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
SKILL = r"C:\Users\19827\Documents\deepseek-harness\default-workspace\.dsh\skills\kaoyan-daily"
SCRIPT = os.path.join(SKILL, "scripts", "kaoyan_daily_ui.py")

failures = []


def run(args, payload=None):
    proc = subprocess.run([PY, SCRIPT] + args, cwd=SKILL,
                          input=(json.dumps(payload, ensure_ascii=False).encode("utf-8")
                                 if payload is not None else None),
                          capture_output=True)
    out = proc.stdout.decode("utf-8", "replace")
    err = proc.stderr.decode("utf-8", "replace")
    if proc.returncode != 0:
        failures.append("exit %s for %s: %s" % (proc.returncode, args, err.strip()))
        return None
    try:
        return json.loads(out)
    except Exception as exc:  # noqa: BLE001
        failures.append("bad json for %s: %s / %s" % (args, exc, out[:200]))
        return None


def check(label, cond, detail=""):
    print(("  OK   " if cond else "  FAIL ") + label + ("" if cond else "  <- " + str(detail)))
    if not cond:
        failures.append(label)


print("== bootstrap ==")
boot = run(["bootstrap"])
check("bootstrap 返回 plan/review", bool(boot and "plan" in boot and "review" in boot), boot)
plan = boot["plan"]
check("今日 plan 有 5 句", plan and len(plan["sentences"]) == 5, plan and len(plan["sentences"]))
check("新词标记为 {{...}}",
      any("{{" in s["marked"] for s in plan["sentences"]),
      plan["sentences"][0]["marked"][:80])
check("每句都带 newWords", all(isinstance(s["newWords"], list) for s in plan["sentences"]))
check("review 按天分组", boot["review"]["groups"] and boot["review"]["groups"][0]["label"] == "day1",
      [g["label"] for g in boot["review"]["groups"]])

sid = plan["sentences"][0]["id"]

print("== submit (payload) ==")
sub = run(["payload"], {"op": "submit", "sentenceId": sid,
                        "translation": "自检译文：这样的被劫持媒体是免费媒体的反面"})
check("submit 回写译文", bool(sub and sub["sentences"][0]["review"]
                             and sub["sentences"][0]["review"]["translation"]), sub)
check("submit 后 submittedCount=1", sub and sub["submittedCount"] == 1,
      sub and sub["submittedCount"])

print("== score (payload) ==")
sc = run(["payload"], {"op": "score", "sentenceId": sid, "score": 7.5,
                       "feedback": "自检指正摘要",
                       "corrections": [
                           {"wrong": "被劫持媒体", "why": "hijack 指内容被占用", "right": "被绑架的媒体"},
                           {"wrong": "免费媒体", "why": "earned media 是口碑赢得", "right": "口碑媒体"}]})
check("score 返回平均分", bool(sc and sc.get("score_avg") is not None), sc)

print("== plan 回读 ==")
pl = run(["plan"])["plan"]
s0 = pl["sentences"][0]
check("得分可读", s0["review"] and s0["review"]["score"] == 7.5, s0["review"])
check("指正 2 条", len(s0["review"]["corrections"]) == 2, s0["review"]["corrections"])
check("scoreAvg 已算", pl["scoreAvg"] == 7.5, pl["scoreAvg"])
check("scoredCount=1", pl["scoredCount"] == 1, pl["scoredCount"])

print("== candidates ==")
cand = run(["candidates"])
check("candidates 有 pending 与 words", bool(cand and cand.get("words")), cand and list(cand))
check("candidates 带真题上下文",
      any(w.get("contexts") for w in cand["words"]),
      [w["word"] for w in cand["words"][:5]])

print("== define ==")
word = cand["words"][0]["word"]
text = ("%s|归属;反义词;生活中常用于;真题关联;例句;常见短语搭配" % word)
d = run(["payload"], {"op": "define", "text": text, "source": "selftest"})
check("define 写库成功", bool(d and d.get("saved")), d)

print("== review 读注解 ==")
rv = run(["review"])
found = None
for g in rv["groups"]:
    for w in g["words"]:
        if w["word"] == word:
            found = w
check("注解已入库并随 review 下发", bool(found and found["annotated"]), found)
check("六项字段齐全",
      bool(found and found["annotation"]
           and set(found["annotation"]) == {"group", "antonym", "usage", "exam", "example", "phrase"}),
      found and found.get("annotation"))
check("注解带归属值", bool(found and found["annotation"]["usage"] == "生活中常用于"),
      found and found.get("annotation"))

print()
if failures:
    print("FAILED %d:" % len(failures))
    for f in failures:
        print("  -", f)
    sys.exit(1)
print("ALL BRIDGE CHECKS PASSED")
