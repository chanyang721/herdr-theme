"""Replay today's real submissions against voice_policy, offline.

Reads the gate's verdicts, the listener log and Claude Code transcripts on this
machine; prints only to the terminal. `--other HH:MM:SS,...` names submissions
known not to be the user's and `--typed` ones sent from the keyboard.
"""
import argparse
import datetime
import glob
import json
import os
import re
import sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import voice_policy

STATE = os.path.expanduser("~/.local/state/herdr/plugins/local.focus-queue/")


def events(day):
    found = []
    previous = ""
    lines = open(STATE + "focus-queue.log", errors="ignore").read().split("\n")
    days = [[]]
    for line in lines:
        match = re.match(r"(\d\d):(\d\d):(\d\d\.\d+) (.*)", line)
        if not match:
            continue
        if line[:8] < previous[:8]:
            days.append([])
        previous = line
        hour, minute, second = int(match[1]), int(match[2]), float(match[3])
        stamp = datetime.datetime.combine(day, datetime.time(hour, minute)).timestamp() + second
        days[-1].append((stamp, match[4]))
    return days[-1] + found


def messages(since, until):
    found = []
    for path in glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl")):
        if os.path.getmtime(path) < since:
            continue
        for line in open(path, errors="ignore"):
            if '"type":"user"' not in line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if entry.get("type") != "user" or entry.get("isMeta") or entry.get("isSidechain"):
                continue
            content = entry.get("message", {}).get("content")
            text = content if isinstance(content, str) else " ".join(
                part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text")
            when = datetime.datetime.fromisoformat(entry["timestamp"].replace("Z", "+00:00")).timestamp()
            if text.strip() and not text.lstrip().startswith("<") and "<hc from=" not in text and since <= when <= until:
                found.append((when, os.path.basename(path)[:6], text.strip()))
    return sorted(found)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--panes", required=True, help="session prefix=pane,...")
    parser.add_argument("--other", default="")
    parser.add_argument("--typed", default="")
    args = parser.parse_args()
    panes = dict(item.split("=") for item in args.panes.split(","))
    segments = voice_policy.read_segments(STATE + "voice-segments.jsonl", 1000)
    scored = [item for item in segments if item.get("score") is not None]
    day = datetime.datetime.fromtimestamp(scored[0]["end"]).date()
    log = events(day)
    tally = {}
    hhmmss = lambda t: datetime.datetime.fromtimestamp(t).strftime("%H:%M:%S")
    for when, session, text in messages(scored[0]["end"], segments[-1]["end"]):
        pane = panes.get(session)
        clock = hhmmss(when)
        if not pane or clock in args.typed:
            continue
        armed = [t for t, line in log if t < when - 0.4 and re.search(rf"voice (on|re-armed) {pane}$", line)]
        if not armed:
            continue
        mine, others = voice_policy.heard(segments, armed[-1] - 1, when + 1)
        passed = voice_policy.own_dictation(segments, armed[-1] - 1, when + 1, len(text))
        kind = "other" if clock in args.other else "own"
        tally[kind, passed] = tally.get((kind, passed), 0) + 1
        ratio = f"{len(text) / mine:.1f}" if mine else "-"
        score = voice_policy.mean_score(segments, armed[-1] - 1, when + 1)
        print(clock, pane, kind, f"{len(text)}자 본인 {mine:.1f}s 타인 {others:.1f}s 자/초 {ratio} 평균 {score:.2f}",
              "통과" if passed else "차단", "" if passed == (kind == "own") else "  <== 어긋남: " + text[:30])
    print(tally)


if __name__ == "__main__":
    main()
