# Roles and scripts for jira-ticket-pipeline.yaml

## Contents

- [roles/designer](#rolesdesigner)
- [roles/hardener](#roleshardener)
- [roles/triager](#rolestriager)
- [roles/builder_cheap](#rolesbuilder_cheap)
- [roles/builder_mid](#rolesbuilder_mid)
- [roles/completion_reviewer](#rolescompletion_reviewer)
- [roles/publisher](#rolespublisher)
- [roles/code_reviewer](#rolescode_reviewer)
- [roles/review_fixer](#rolesreview_fixer)
- [scripts/lint-spec.py](#scriptslint-specpy)
- [scripts/pick-phase.py](#scriptspick-phasepy)
- [scripts/verify-phase.py](#scriptsverify-phasepy)
- [scripts/collect-evidence.py](#scriptscollect-evidencepy)
- [scripts/check-review.py](#scriptscheck-reviewpy)
- [scripts/queue-audit.sh](#scriptsqueue-auditsh)
- [scripts/begin-audit.sh](#scriptsbegin-auditsh)
- [scripts/record-audit.sh](#scriptsrecord-auditsh)
- [scripts/after-fix.sh](#scriptsafter-fixsh)

Place under `.paseo/plugins/playbooks/`: `roles/<name>/role.yaml` + `instructions.md`, `scripts/*` (chmod +x). The five Python scripts and four label scripts are working code, tested in a scratch git repo except the four that call `gh` (syntax-checked only). Needs `python3` with PyYAML, `jq`, `gh`, and `~/.claude/skills/pr-agent-review/scripts/set-review-label.sh`.

## roles/designer
```yaml
title: Designer
agent: { tier: mid }
```

You turn a Jira ticket and the human's answers into a spec file. Every phase names its tier (cheap or mid), a task a builder can follow without inferring anything, and at least one check: a shell command that exits 0 when the phase is done. If you cannot write such a check, the design is not ready: ask the human.

Put a `definition_of_done` block in every spec: this standard list, plus anything the human adds. The completion reviewer can judge only what the spec says, so what you leave out is never checked.

```yaml
definition_of_done:
  - { id: DOD-1, rule: "No placeholders: no TODO, FIXME, stub bodies, NotImplemented, fake data or commented-out code in files this plan changed, unless a phase names it as intended." }
  - { id: DOD-2, rule: "Every item in a phase's task list is implemented in full." }
  - { id: DOD-3, rule: "Tests assert the behaviour the phase names. None is skipped, tautological or mocks out the code under test, and at least one test per phase fails when the feature is removed." }
  - { id: DOD-4, rule: "Every check of every phase ran and passed on the final tree (see evidence.md)." }
  - { id: DOD-5, rule: "Files changed are the files the phases name." }
```

A phase has `id`, `tier` (cheap|mid), `task` (a list, one action each), `checks` (a list of shell commands that exit 0 when done).

## roles/hardener
```yaml
title: Hardener
readonly: true
agent: { tier: gate }
```

You attack the spec. Flag only what would make a builder fail or guess: unstated assumptions, a phase without an exit condition, a check no tool can run. Style, naming and 'could be better' are out of scope. Return pass or defects with a numbered list. Never rewrite the spec. Stop after one pass over the whole spec.

## roles/triager
```yaml
title: Triager
readonly: true
agent: { tier: mid }
```

A builder stopped on a judgment call. Decide 'answered' with the answer only when the spec already settles it. Escalate to a human when it needs a product decision or touches security, auth, billing or data migrations; choose 'redesign' when the spec is wrong.

## roles/builder_cheap
```yaml
title: Builder (cheap)
readonly: false
agent: { tier: cheap }
```

You execute one phase of a finished spec exactly as written. Never infer. If anything is ambiguous, stop and report needs_judgment with the question. Commit only the files the phase names.

If a feedback file is named in your prompt, it is the reviewer's concrete list for this phase. Do every item in it, run the phase checks, and change nothing else. If you think an item is wrong, stop and report needs_judgment.

## roles/builder_mid
```yaml
title: Builder (mid)
readonly: false
agent: { tier: mid }
```

You execute one phase of a finished spec. You may make small implementation choices inside the phase; report needs_judgment for anything that changes scope or interfaces.

If a feedback file is named in your prompt, it is the reviewer's concrete list for this phase. Do every item in it, run the phase checks, and change nothing else. If you think an item is wrong, stop and report needs_judgment.

## roles/completion_reviewer
```yaml
title: Completion reviewer
readonly: true
agent: { tier: mid }
```

You check whether the builders did the work the plan assigned. You judge by the plan and nothing else.

Read the spec, `.workflow/<ticket>/evidence.md` and the branch diff against the base. For each phase, decide whether the work it assigned was done. The spec's `definition_of_done` block and each phase's `task` and `checks` lists are the only criteria. The usual ones: planned work missing, placeholders or stubs left in (DOD-1), tests that cannot fail or never exercise the code (DOD-3), a check never run or run against the wrong thing (DOD-4).

Every defect must carry:
- `phase`: the phase whose work fell short.
- `criterion`: `DOD-<n>`, `<phase>.task.<n>` or `<phase>.check.<n>` (1-based). It must exist in the spec.
- `quote`: the exact words of that criterion.
- `finding`: what you saw, with file and line.
- `required_fix`: the concrete instruction for the builder who owns the phase.
- `expected_evidence`: what will show it fixed. Add `expected_check`, a shell command that exits 0, when one can prove it.

A defect that cites nothing in the spec is deleted before anyone reads it. Style, naming, architecture, 'could be better' and requirements you think are missing are out of scope. Do not rewrite code or the spec. One pass over the whole diff.

Return `gaps` as a JSON array. Outcome `complete` with `[]` when nothing is short. Outcome `defects` otherwise. Outcome `plan_gap` only when two declared criteria contradict each other or one cannot be met as written; cite both in the summary.

## roles/publisher
```yaml
title: Publisher
readonly: false
agent: { tier: cheap }
```

Push the branch (never the default branch) and open the PR, reusing the open PR if the branch already has one. Title starts with the Jira key. The body says what changed and why from the spec, and summarises evidence.md. Add a closing line ("Closes #n") only for a GitHub issue number you were given; the Jira key is not one, and you never invent a number. Comment the PR link on the Jira ticket with acli. Never touch a label and never merge. Return `pr_url` and `pr_number` (digits only).

## roles/code_reviewer
```yaml
title: Code reviewer
readonly: true
agent: { tier: gate }
```

You are the pull request audit in the repository's review cycle. Review the PR diff for correctness bugs, security problems, missing error handling at real boundaries, and tests that do not prove what they claim. Read the spec for intent; the completion review already checked plan coverage, so do not repeat it.

Return `findings`: numbered, each with file:line, why it is a defect, and the smallest fix. Return `issue_count`: the number of distinct actionable issues, counting issues, not comments or files. Do not post to the PR, and never touch a label: a script does both from your outcome.

Outcome `pass`: no actionable issue (put a one-line note in `findings`, `issue_count` 0). Outcome `changes`: at least one. Outcome `blocked`: you cannot continue without a human decision (say which). Stop after one pass.

## roles/review_fixer
```yaml
title: Review fixer
readonly: false
agent: { tier: mid }
```

The PR audit requested changes. Before touching code, invoke `/writing-plans` to plan the fixes for the findings, then `/subagent-driven-development` to execute that plan. Fix only what the findings name.

Run every phase check from the spec and the project's normal tests. If any fails, do not commit or push: report needs_input with the exact failure. Otherwise commit on the PR branch, push it normally (never force-push, never merge), and return `issues_addressed` (distinct issues fixed) and `resolution` (commit SHA, files changed, the exact verification commands and their results). Never touch a label or post a comment: a script does both.

## scripts/lint-spec.py
```python
#!/usr/bin/env python3
# Structure only, no model. Spec needs: definition_of_done (>=1 item with id DOD-n and rule) and phases,
# each with id, tier (cheap|mid), task (non-empty list), checks (non-empty list of shell commands).
import json, os, pathlib, re, yaml

spec = yaml.safe_load(pathlib.Path(os.environ["PLAYBOOK_INPUT_SPEC_PATH"]).read_text()) or {}
problems = []
dod = spec.get("definition_of_done") or []
if not dod: problems.append("definition_of_done is missing")
for d in dod:
    if not re.fullmatch(r"DOD-\d+", str(d.get("id", ""))) or not str(d.get("rule", "")).strip():
        problems.append(f"bad definition_of_done item: {d}")
for p in spec.get("phases") or [{}]:
    pid = p.get("id", "?")
    if not p.get("id"): problems.append("a phase has no id")
    if p.get("tier") not in ("cheap", "mid"): problems.append(f"{pid}: tier must be cheap or mid")
    if not p.get("task"): problems.append(f"{pid}: task is empty")
    if not p.get("checks"): problems.append(f"{pid}: no check command, so no exit condition")
print(json.dumps({"outcome": "incomplete", "summary": "; ".join(problems)} if problems else {"outcome": "success"}))
```

## scripts/pick-phase.py
```python
#!/usr/bin/env python3
# First phase (spec order) whose status is not "passed". Creates state.json on first use.
# state.json: {"review_round": 0, "phases": {"p1": {"status": "pending|passed|reopened", "attempts": 0, "extra_checks": []}}}
# Prints {"outputs":{"phase_id","tier","feedback_file"}}; tier "none" when nothing is left.
import json, os, subprocess, sys, pathlib, yaml

spec_path = pathlib.Path(os.environ["PLAYBOOK_INPUT_SPEC_PATH"])
exclude = pathlib.Path(subprocess.run(["git", "rev-parse", "--git-path", "info/exclude"], capture_output=True, text=True).stdout.strip())
if exclude.parent.exists() and ".workflow/" not in (exclude.read_text() if exclude.exists() else ""):
    exclude.write_text((exclude.read_text() if exclude.exists() else "") + "\n.workflow/\n")
spec = yaml.safe_load(spec_path.read_text())
state_path = spec_path.parent / "state.json"
if state_path.exists():
    state = json.loads(state_path.read_text())
else:
    state = {"review_round": 0, "phases": {p["id"]: {"status": "pending", "attempts": 0, "extra_checks": []} for p in spec["phases"]}}
    state_path.write_text(json.dumps(state, indent=2))

for phase in spec["phases"]:
    if state["phases"][phase["id"]]["status"] != "passed":
        fb = spec_path.parent / "feedback" / f"{phase['id']}.md"
        print(json.dumps({"outputs": {"phase_id": phase["id"], "tier": phase["tier"], "feedback_file": str(fb) if fb.exists() else "none"}}))
        sys.exit(0)
print(json.dumps({"outputs": {"phase_id": "none", "tier": "none", "feedback_file": "none"}}))
```

## scripts/verify-phase.py
```python
#!/usr/bin/env python3
# Runs the checks of one phase (spec checks + extra_checks added by a review). Exit code 0 = pass.
# Pass: mark the phase passed; outcome all_done if none left, else phase_passed.
# Fail: attempts += 1; under the cap, retry_cheap / retry_mid by tier, summary = failing command + output tail
# (it reaches the builder as "Feedback to address"); at the cap, phase_stuck.
import json, os, pathlib, subprocess, yaml

CAP = 3
spec_path = pathlib.Path(os.environ["PLAYBOOK_INPUT_SPEC_PATH"])
pid = os.environ["PLAYBOOK_INPUT_PHASE_ID"]
spec = yaml.safe_load(spec_path.read_text())
state_path = spec_path.parent / "state.json"
state = json.loads(state_path.read_text())
phase = next(p for p in spec["phases"] if p["id"] == pid)
st = state["phases"][pid]

for cmd in list(phase["checks"]) + st["extra_checks"]:
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if r.returncode != 0:
        st["attempts"] += 1
        state_path.write_text(json.dumps(state, indent=2))
        tail = (r.stdout + r.stderr)[-1500:]
        if st["attempts"] > CAP:
            print(json.dumps({"outcome": "phase_stuck", "summary": f"{pid} failed {cmd!r} {st['attempts']} times"}))
        else:
            print(json.dumps({"outcome": f"retry_{phase['tier']}", "summary": f"check failed: {cmd}\n{tail}"}))
        raise SystemExit(0)

st["status"] = "passed"
state_path.write_text(json.dumps(state, indent=2))
left = [p for p in spec["phases"] if state["phases"][p["id"]]["status"] != "passed"]
print(json.dumps({"outcome": "phase_passed" if left else "all_done"}))
```

## scripts/collect-evidence.py
```python
#!/usr/bin/env python3
# Re-runs every phase check on the final tree (a later phase may have broken an earlier one) and writes
# .workflow/<ticket>/evidence.md for the completion reviewer: check results, files changed vs the base,
# and added lines that look like placeholders. The scan is evidence, not a verdict: only the reviewer,
# citing DOD-1, can turn it into a defect.
# A failing check reopens its phase (feedback file, attempts reset) and the outcome is "regressed".
# EVIDENCE_NO_REOPEN=1 reports only, and never edits state.json (after-fix.sh uses this).
import json, os, pathlib, re, subprocess, yaml

spec_path = pathlib.Path(os.environ["PLAYBOOK_INPUT_SPEC_PATH"])
base = os.environ.get("PLAYBOOK_INPUT_BASE_BRANCH", "main")
work = spec_path.parent
spec = yaml.safe_load(spec_path.read_text())
state_path = work / "state.json"
state = json.loads(state_path.read_text())
sh = lambda c: subprocess.run(c, shell=True, capture_output=True, text=True)

out, failed = ["# Evidence", ""], {}
for p in spec["phases"]:
    for cmd in list(p["checks"]) + state["phases"][p["id"]]["extra_checks"]:
        r = sh(cmd)
        out.append(f"- {p['id']} `{cmd}` -> exit {r.returncode}")
        if r.returncode:
            failed.setdefault(p["id"], []).append((cmd, (r.stdout + r.stderr)[-800:]))

out += ["", "## Files changed vs base", "```", sh(f"git diff --stat origin/{base}...HEAD").stdout.strip(), "```", "",
        "## Added lines that look like placeholders", "```"]
pat = re.compile(r"TODO|FIXME|XXX|NotImplemented|not implemented|placeholder|lorem ipsum|@pytest\.mark\.skip|\.skip\(|xit\(|assert True|raise NotImplementedError")
out += [l for l in sh(f"git diff -U0 origin/{base}...HEAD").stdout.splitlines() if l.startswith("+") and not l.startswith("+++") and pat.search(l)] or ["(none)"]
out.append("```")
(work / "evidence.md").write_text("\n".join(out) + "\n")

if failed and not os.environ.get("EVIDENCE_NO_REOPEN"):
    (work / "feedback").mkdir(exist_ok=True)
    for pid, fails in failed.items():
        body = [f"# Rework for phase {pid}", "", "A check that passed earlier now fails on the final tree. Fix it and nothing else.", ""]
        body += [f"- `{c}`\n```\n{t}\n```" for c, t in fails]
        (work / "feedback" / f"{pid}.md").write_text("\n".join(body))
        state["phases"][pid].update(status="reopened", attempts=0)
    state["review_round"] += 1
    state_path.write_text(json.dumps(state, indent=2))
print(json.dumps({"outcome": "regressed" if failed else "ready", "summary": f"{len(failed)} phase(s) regressed" if failed else "all checks pass on the final tree"}))
```

## scripts/check-review.py
```python
#!/usr/bin/env python3
# The guard behind "the reviewer judges only by what the plan declares".
# Input GAPS: JSON array of {phase, criterion, quote, finding, required_fix, expected_evidence, expected_check?}.
# A defect is kept only if:
#   - criterion resolves in the spec: DOD-<n> | <phase>.task.<n> | <phase>.check.<n>  (n is 1-based)
#   - quote is a verbatim substring (whitespace and case folded) of that criterion's text
#   - phase exists, and equals <phase> when the criterion names one
#   - finding, required_fix and expected_evidence are non-empty
# Kept defects: written to feedback/<phase>.md, phase reopened (attempts reset, expected_check appended).
# Dropped defects: appended to withdrawn.md with the reason. They never reach a builder.
# Outcome: rework (>=1 kept) | withdrawn (none kept).
import json, os, re, sys, pathlib, yaml

spec_path = pathlib.Path(os.environ["PLAYBOOK_INPUT_SPEC_PATH"])
work = spec_path.parent
spec = yaml.safe_load(spec_path.read_text())
state_path = work / "state.json"
state = json.loads(state_path.read_text())
norm = lambda s: re.sub(r"\s+", " ", str(s)).strip().lower()
phases = {p["id"]: p for p in spec["phases"]}
dod = {d["id"]: d["rule"] for d in spec.get("definition_of_done", [])}

def criterion_text(crit, phase):
    if crit in dod:
        return dod[crit], None
    m = re.fullmatch(r"(\w+)\.(task|check)\.(\d+)", crit)
    if not m:
        return None, "criterion is not in the plan"
    pid, kind, n = m.group(1), m.group(2), int(m.group(3))
    items = phases.get(pid, {}).get({"task": "task", "check": "checks"}[kind], [])
    if isinstance(items, str):
        items = [items]
    if not 1 <= n <= len(items):
        return None, "criterion is not in the plan"
    if pid != phase:
        return None, "criterion belongs to another phase"
    return items[n - 1], None

try:
    gaps = json.loads(os.environ["PLAYBOOK_INPUT_GAPS"])
except Exception as e:
    print(f"gaps is not valid JSON: {e}", file=sys.stderr); sys.exit(1)

kept, dropped = {}, []
for g in gaps:
    reason = None
    if g.get("phase") not in phases:
        reason = "unknown phase"
    if reason is None:
        text, reason = criterion_text(g.get("criterion", ""), g["phase"])
    if reason is None and norm(g.get("quote", "")) not in norm(text):
        reason = "quote is not in the cited criterion"
    if reason is None and not all(str(g.get(k, "")).strip() for k in ("finding", "required_fix", "expected_evidence")):
        reason = "finding, required_fix and expected_evidence are all required"
    if reason:
        dropped.append((g, reason))
    else:
        kept.setdefault(g["phase"], []).append(g)

if dropped:
    with (work / "withdrawn.md").open("a") as f:
        for g, reason in dropped:
            f.write(f"- withdrawn ({reason}): {json.dumps(g)}\n")

if not kept:
    print(json.dumps({"outcome": "withdrawn", "summary": f"{len(dropped)} defect(s) cited nothing in the plan and were dropped"}))
    sys.exit(0)

(work / "feedback").mkdir(exist_ok=True)
for pid, items in kept.items():
    lines = [f"# Rework for phase {pid}", "", "Do every item below and nothing else. Each item cites the plan.", ""]
    for i, g in enumerate(items, 1):
        lines += [f"## {i}. {g['criterion']}", f"Plan says: \"{g['quote']}\"", f"Found: {g['finding']}",
                  f"Required fix: {g['required_fix']}", f"Done when: {g['expected_evidence']}", ""]
        if g.get("expected_check"):
            state["phases"][pid]["extra_checks"].append(g["expected_check"])
    (work / "feedback" / f"{pid}.md").write_text("\n".join(lines))
    state["phases"][pid].update(status="reopened", attempts=0)
state["review_round"] += 1
state_path.write_text(json.dumps(state, indent=2))
print(json.dumps({"outcome": "rework", "summary": f"reopened {', '.join(kept)} ({sum(map(len, kept.values()))} defect(s) kept, {len(dropped)} dropped)"}))
```

## scripts/queue-audit.sh
```bash
#!/usr/bin/env bash
# Author side of /pr-agent-review: make sure the repo has the review:* catalog, queue the audit,
# and record the cursor (repo, PR, head SHA, time) so later steps refuse to touch another PR.
set -euo pipefail
pr=$PLAYBOOK_INPUT_PR_NUMBER
remote=$(git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')
case ${remote%%/*} in
  Eventus-Whole-Health|joshgilpatrick) acct=joshgilpatrick ;;
  eventuswh-apps)                      acct=jgilpatrick_ewh ;;
  *) echo "no gh account mapped for ${remote%%/*}" >&2; exit 1 ;;
esac
export GH_TOKEN=$(gh auth token -u "$acct")
set_label="$HOME/.claude/skills/pr-agent-review/scripts/set-review-label.sh"
"$set_label" "$remote" "$pr" ensure >/dev/null
labels=$("$set_label" "$remote" "$pr" review:needs-agent-audit)
sha=$(gh pr view "$pr" --repo "$remote" --json headRefOid --jq .headRefOid)
mkdir -p .workflow
jq -n --arg repo "$remote" --arg pr "$pr" --arg sha "$sha" --arg at "$(date -u +%FT%TZ)" \
  '{repo:$repo, pr:$pr, head_sha:$sha, queued_at:$at}' > .workflow/pr-cursor.json
echo "{\"summary\":\"queued $remote#$pr at $sha ($labels)\"}"
```

## scripts/begin-audit.sh
```bash
#!/usr/bin/env bash
# Reviewer side: the audit starts, so the PR moves to review:audit-in-progress.
set -euo pipefail
pr=$PLAYBOOK_INPUT_PR_NUMBER
repo=$(jq -r .repo .workflow/pr-cursor.json)
[ "$(jq -r .pr .workflow/pr-cursor.json)" = "$pr" ] || { echo "cursor is for another PR" >&2; exit 1; }
case ${repo%%/*} in
  Eventus-Whole-Health|joshgilpatrick) acct=joshgilpatrick ;;
  eventuswh-apps)                      acct=jgilpatrick_ewh ;;
  *) echo "no gh account mapped" >&2; exit 1 ;;
esac
export GH_TOKEN=$(gh auth token -u "$acct")
labels=$("$HOME/.claude/skills/pr-agent-review/scripts/set-review-label.sh" "$repo" "$pr" review:audit-in-progress)
echo "{\"summary\":\"$labels\"}"
```

## scripts/record-audit.sh
```bash
#!/usr/bin/env bash
# One script for audit_passed / audit_changes / audit_blocked: posts the findings as a PR comment,
# then sets the label the convention names for that verdict. Nothing else in the playbook sets a review:* label.
set -euo pipefail
pr=$PLAYBOOK_INPUT_PR_NUMBER
repo=$(jq -r .repo .workflow/pr-cursor.json)
[ "$(jq -r .pr .workflow/pr-cursor.json)" = "$pr" ] || { echo "cursor is for another PR" >&2; exit 1; }
case $PLAYBOOK_STEP_ID in
  audit_passed)  label=pass;                    head='Pipeline code review: pass' ;;
  audit_changes) label=review:changes-requested; head='Pipeline code review: changes requested' ;;
  audit_blocked) label=review:audit-blocked;     head='Pipeline code review: blocked, needs a human' ;;
  *) echo "unexpected step $PLAYBOOK_STEP_ID" >&2; exit 1 ;;
esac
case ${repo%%/*} in
  Eventus-Whole-Health|joshgilpatrick) acct=joshgilpatrick ;;
  eventuswh-apps)                      acct=jgilpatrick_ewh ;;
  *) echo "no gh account mapped" >&2; exit 1 ;;
esac
export GH_TOKEN=$(gh auth token -u "$acct")
body=$(mktemp); trap 'rm -f "$body"' EXIT
printf '**%s**\n\n%s\n' "$head" "$PLAYBOOK_INPUT_FINDINGS" > "$body"
gh pr comment "$pr" --repo "$repo" --body-file "$body" >/dev/null
labels=$("$HOME/.claude/skills/pr-agent-review/scripts/set-review-label.sh" "$repo" "$pr" "$label")
echo "{\"summary\":\"$labels\"}"
```

## scripts/after-fix.sh
```bash
#!/usr/bin/env bash
# After the fixer pushed: re-run every phase check (report only), post the resolution comment,
# then label by the convention. 4+ distinct issues this round -> re-queue the audit.
# Fewer, all addressed -> the pass label (review:ready-for-human, or review:remediated after a human-ordered rework).
set -euo pipefail
pr=$PLAYBOOK_INPUT_PR_NUMBER
issues=$PLAYBOOK_INPUT_ISSUES_ADDRESSED
repo=$(jq -r .repo .workflow/pr-cursor.json)
[ "$(jq -r .pr .workflow/pr-cursor.json)" = "$pr" ] || { echo "cursor is for another PR" >&2; exit 1; }
case ${repo%%/*} in
  Eventus-Whole-Health|joshgilpatrick) acct=joshgilpatrick ;;
  eventuswh-apps)                      acct=jgilpatrick_ewh ;;
  *) echo "no gh account mapped" >&2; exit 1 ;;
esac
export GH_TOKEN=$(gh auth token -u "$acct")

ev=$(EVIDENCE_NO_REOPEN=1 "$(dirname "$0")/collect-evidence.py" | tail -1)
if [ "$(jq -r .outcome <<<"$ev")" = regressed ]; then
  echo "{\"outcome\":\"checks_failed\",\"summary\":\"phase checks fail after the review fix; nothing was posted or relabeled\"}"
  exit 0
fi

body=$(mktemp); trap 'rm -f "$body"' EXIT
printf '**Review fixes pushed (%s issue(s) addressed)**\n\n%s\n' "$issues" "$PLAYBOOK_INPUT_RESOLUTION" > "$body"
gh pr comment "$pr" --repo "$repo" --body-file "$body" >/dev/null
set_label="$HOME/.claude/skills/pr-agent-review/scripts/set-review-label.sh"
if [ "$issues" -ge 4 ]; then
  labels=$("$set_label" "$repo" "$pr" review:needs-agent-audit); outcome=requeue
else
  labels=$("$set_label" "$repo" "$pr" pass); outcome=done
fi
echo "{\"outcome\":\"$outcome\",\"summary\":\"$labels\"}"
```
