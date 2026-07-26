"""GLD-16 measurement harness, step 2: build the graph from the cached
extractions and print what the oracle asks about.

Prints, in the order the ticket's acceptance criteria ask for them: the stated
follow-ups the extractor found, the node count by kind, the inferred goal, the
ordered chain with its dates, what fell off the chain, the overdue set with the
basis sentence, the historical delays, and the stall.

Usage: npm run dev, then
  bash scripts/gld16/extract-letters.sh && python3 scripts/gld16/oracle-diff.py
"""
import json, glob, subprocess, collections, os

CACHE = os.environ.get("GLD16_CACHE", "/tmp/gld16-extractions")
AS_OF = os.environ.get("GLD16_AS_OF", "2026-07-25")
# The app under measurement. Set GLD16_PORT when the dev server for the branch
# being measured is not the one on the default port.
PORT = os.environ.get("GLD16_PORT", "3000")

ex = [json.load(open(f))["extraction"] for f in sorted(glob.glob(f"{CACHE}/*.json"))]
req = "/tmp/gld16-graph-req.json"
json.dump({"extractions": ex, "asOf": AS_OF}, open(req, "w"))
out = subprocess.run(
    ["curl", "-s", "-X", "POST", f"http://localhost:{PORT}/api/graph",
     "-H", "content-type: application/json", "-d", f"@{req}"],
    capture_output=True, text=True).stdout
d = json.loads(out)
g = d["graph"]
by = {n["id"]: n for n in g["nodes"]}

print("FOLLOW-UPS extracted:")
for e in ex:
    for f in e.get("follow_ups") or []:
        print("  ", e["letter_date"], "|", f["item"], "| phrase", repr(f["phrase"]),
              "| from", repr(f["from"]), "| due", f["due_date"])

print("\nNODES:", len(g["nodes"]), collections.Counter(n["kind"] for n in g["nodes"]))
print("\nGOAL:", g["goal"])

print("\nCHAIN (%d):" % len(g["chainIds"]))
for i in g["chainIds"]:
    n = by[i]
    print("  %-12s %-44s %-9s tl=%-11s due=%-11s %-7s %s" % (
        n["kind"], n["label"][:44], n["status"], n["timelineDate"],
        n["dueDate"], n["dateSource"],
        ("OVERDUE %dd" % n["overdue"]["daysOverdue"]) if n.get("overdue") else ""))

off = [n for n in g["nodes"] if n["id"] not in g["chainIds"]]
print("\nOFF-CHAIN (%d):" % len(off), [n["label"][:40] for n in off])

od = [n for n in g["nodes"] if n.get("overdue")]
print("\nOVERDUE (%d):" % len(od))
for n in sorted(od, key=lambda n: -n["overdue"]["daysOverdue"]):
    print("   %-44s %3dd | %s" % (n["label"][:44], n["overdue"]["daysOverdue"], n["overdue"]["basis"]))

s = d["stall"]
print("\nSTALL:", s["stalledNode"]["label"] if s else None)
if s:
    print("  dept:", s["owningDept"], "| since", s["sinceDate"],
          "| daysStalled", s["daysStalled"], "| daysOverdue", s["daysOverdue"],
          "| due", s["dueDate"])
    print("  chain:", " -> ".join(n["label"][:34] for n in s["chain"]))
    print("  explanation:", s["explanation"])
else:
    print("  noStallReason:", d.get("noStallReason"))
