"""Service, account and graph checks (JP-152): the headless Session Atlas, the Azure backup copy, Jira credentials,
the `claude` command the summary job calls, and whether the walker's compiled graphs match their sources. Reads only.
It never prints a token or an email address, and the keychain item is asked about, not read. Sources: JP-111,
JP-107, JP-108, JP-114, JP-121, JP-150."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import List, Optional

sys.dont_write_bytecode = True
from .core import FAIL, PASS, SKIP, WARN, Ctx, Result, check  # noqa: E402
from .install_checks import ago  # noqa: E402

ATLAS_LABEL = "com.josh360.session-atlas"
OLD_ATLAS_LABEL = "com.eventus.claude-atlas"
ATLAS_HEALTH = "http://127.0.0.1:8770/api/health"
AZ_PLACES = ("/opt/homebrew/bin/az", "/usr/local/bin/az")
KEYCHAIN_SERVICE = "jira-claude-api-key"  # asked for by name alone, as the runner and the walker read it
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _retired(ctx: Ctx) -> bool:
    state = ctx.job_state() or {}
    return (state.get("retire-session-atlas") or {}).get("last_result") == 0


@check("services", "atlas-launchd")
def atlas_launchd(ctx: Ctx) -> Result:
    cid = "services.atlas-launchd"
    if not _retired(ctx):
        return Result(cid, SKIP, "waits for the retire-session-atlas job to succeed (see backfills.retire-session-atlas)")
    loaded = ctx.launchd_loaded(ATLAS_LABEL)
    if loaded is None:
        return Result(cid, SKIP, "launchctl is not available here (not a Mac)")
    if loaded:
        return Result(cid, PASS, "{} is loaded in launchd".format(ATLAS_LABEL))
    return Result(cid, FAIL, "{} is not loaded: the worktree removal guard has no Atlas to ask".format(ATLAS_LABEL),
                  "python3 ~/.josh-360/repo/scripts/atlas_service.py (the hourly session-atlas-service job does this too)")


@check("services", "old-atlas-gone")
def old_atlas_gone(ctx: Ctx) -> Result:
    cid = "services.old-atlas-gone"
    loaded = ctx.launchd_loaded(OLD_ATLAS_LABEL)
    if loaded is None:
        return Result(cid, SKIP, "launchctl is not available here (not a Mac)")
    if loaded:
        return Result(cid, FAIL, "the old Session Atlas ({}) is still loaded; two Atlases would write the same files".format(
            OLD_ATLAS_LABEL), "it is stopped by the retire-session-atlas job; check backfills.retire-session-atlas")
    return Result(cid, PASS, "the old Session Atlas is not loaded")


@check("services", "atlas-health")
def atlas_health(ctx: Ctx) -> Result:
    cid = "services.atlas-health"
    if not _retired(ctx):
        return Result(cid, SKIP, "waits for the retire-session-atlas job to succeed")
    code, _ = ctx.http_get(ATLAS_HEALTH, 4.0)
    if code == 200:
        return Result(cid, PASS, "Atlas answers at {}".format(ATLAS_HEALTH))
    return Result(cid, FAIL, "Atlas does not answer at {}".format(ATLAS_HEALTH),
                  "read ~/.josh-360/atlas/atlas.log and ~/.josh-360/logs/session-atlas.err.log")


@check("services", "atlas-log")
def atlas_log(ctx: Ctx) -> Result:
    cid = "services.atlas-log"
    path = ctx.home / "atlas" / "atlas.log"
    if not path.is_file():
        return Result(cid, SKIP, "no Atlas log yet")
    try:
        tail = path.read_text(encoding="utf-8", errors="replace").splitlines()[-200:]
    except OSError:
        return Result(cid, WARN, "{} cannot be read".format(ctx.tilde(path)))
    if any("ledger.db not readable" in line for line in tail[-20:]):
        return Result(cid, FAIL, "Atlas's recent log says ledger.db is not readable by the session mirror",
                      "check data.ledger; read ~/.josh-360/atlas/atlas.log")
    return Result(cid, PASS, "no recent Atlas errors about the ledger")


@check("services", "node")
def node_ok(ctx: Ctx) -> Result:
    """Atlas needs Node 22.18 or newer. Asks the same question the service job asks."""
    cid = "services.node"
    candidates = [ctx.env.get("JOSH360_NODE")] if ctx.env.get("JOSH360_NODE") else [
        "/opt/homebrew/opt/node@22/bin/node", "/usr/local/opt/node@22/bin/node",
        shutil.which("node", path=ctx.env.get("PATH")), "/opt/homebrew/bin/node", "/usr/local/bin/node"]
    best = None
    for node in dict.fromkeys(c for c in candidates if c and os.access(c, os.X_OK)):
        code, out, _ = ctx.run([node, "--version"], 20)
        m = re.match(r"^v(\d+)\.(\d+)", out.strip()) if code == 0 else None
        if m and (int(m.group(1)), int(m.group(2))) >= (22, 18):
            return Result(cid, PASS, "Node {} at {}".format(out.strip(), ctx.tilde(node)))
        if m:
            best = out.strip()
    if best:
        return Result(cid, FAIL, "Node {} is older than 22.18, which Atlas needs".format(best), "brew install node@22")
    return Result(cid, FAIL, "no Node 22.18 or newer was found", "brew install node@22")


# -- accounts --------------------------------------------------------------------------------------------------------

def find_az(ctx: Ctx) -> Optional[str]:
    found = ctx.env.get("JOSH360_AZ") or shutil.which("az", path=ctx.env.get("PATH"))
    return found or next((p for p in AZ_PLACES if os.access(p, os.X_OK)), None)


@check("accounts", "azure-config")
def azure_config(ctx: Ctx) -> Result:
    from ledger import azure_blob  # the code that will read it, so the doctor and the job agree
    cid = "accounts.azure-config"
    try:
        found = azure_blob.load_config(ctx.state, ctx.env)
    except azure_blob.AzureError as e:
        return Result(cid, FAIL, "the Azure backup settings are wrong: {}".format(str(e)[:150]),
                      'edit ~/.josh-360/state/azure-backup.json to hold only {"account": "...", "container": "..."}')
    if found is None:
        return Result(cid, WARN, "the Azure backup copy is not configured: no account and container are named (JP-150)",
                      'write {"account": "<storage account>", "container": "<container>"} into ~/.josh-360/state/azure-backup.json')
    return Result(cid, PASS, "account and container are set (account {}, container {})".format(*found))


@check("accounts", "az-login")
def az_login(ctx: Ctx) -> Result:
    cid = "accounts.az-login"
    configured = _azure_configured(ctx)
    az = find_az(ctx)
    bad = FAIL if configured else WARN
    if az is None:
        return Result(cid, bad, "the Azure CLI (az) is not installed", "brew install azure-cli, then az login")
    code, _, err = ctx.run([az, "account", "show", "--only-show-errors", "-o", "none"], 40)
    if code == 0:
        return Result(cid, PASS, "az is signed in")
    if code == 124:
        return Result(cid, WARN, "az did not answer within 40 seconds", "run az account show by hand")
    return Result(cid, bad, "az is not signed in" + ("" if configured else " (the backup copy is not set up either)"),
                  "az login")


def _azure_configured(ctx: Ctx) -> bool:
    from ledger import azure_blob
    try:
        return azure_blob.load_config(ctx.state, ctx.env) is not None
    except azure_blob.AzureError:
        return True


@check("accounts", "azure-upload")
def azure_upload(ctx: Ctx) -> Result:
    cid = "accounts.azure-upload"
    if not _azure_configured(ctx):
        return Result(cid, SKIP, "the backup copy is not configured (accounts.azure-config)")
    try:
        data = json.loads((ctx.state / "azure-upload.json").read_text(encoding="utf-8"))
        last = str(data.get("last_success", ""))
    except (OSError, ValueError, AttributeError):
        last = ""
    pending = ctx.state / "azure-redactions-pending.json"
    if not last:
        return Result(cid, FAIL, "no upload has ever succeeded", "az login, then python3 ~/.josh-360/repo/ledger/upload.py; "
                      "read ~/.josh-360/logs/ledger-upload.log")
    try:
        import datetime
        when = datetime.datetime.strptime(last, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
        age = ctx.age_seconds(when.timestamp())
    except ValueError:
        return Result(cid, WARN, "azure-upload.json has a last_success that is not a time", "read ~/.josh-360/logs/ledger-upload.log")
    if pending.is_file():
        return Result(cid, WARN, "a redaction is waiting to reach the uploaded copies (last upload {})".format(ago(age)),
                      "it finishes on the next daily upload once az login works")
    if age > 3 * 86400:
        return Result(cid, FAIL, "the last successful upload was {}".format(ago(age)), "read ~/.josh-360/logs/ledger-upload.log")
    return Result(cid, PASS, "the last successful upload was {}".format(ago(age)))


def jira_email_source(ctx: Ctx) -> str:
    if ctx.env.get("JOSH360_JIRA_EMAIL") or ctx.env.get("ACTION_AGENT_JIRA_EMAIL"):
        return "the environment"
    try:
        if EMAIL.match((ctx.state / "jira-email").read_text(encoding="utf-8").strip()):
            return "~/.josh-360/state/jira-email"
    except OSError:
        pass
    return ""


@check("accounts", "jira-email")
def jira_email(ctx: Ctx) -> Result:
    source = jira_email_source(ctx)
    if source:
        return Result("accounts.jira-email", PASS, "the Jira account email is set (from {})".format(source))
    return Result("accounts.jira-email", FAIL, "no Jira account email is set: ticket links and comment delivery cannot read Jira",
                  "put your Atlassian email on one line in ~/.josh-360/state/jira-email "
                  "(or: doctor --fix --jira-email you@example.com)", "jira-email")


@check("accounts", "jira-token")
def jira_token(ctx: Ctx) -> Result:
    cid = "accounts.jira-token"
    if ctx.env.get("JOSH360_JIRA_TOKEN"):
        return Result(cid, PASS, "a Jira token is in the environment")
    code, _, _ = ctx.run(["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_SERVICE], 15)
    if code == 0:
        return Result(cid, PASS, "the keychain item {} exists (asked about, not read)".format(KEYCHAIN_SERVICE))
    if code in (124, 127):
        return Result(cid, SKIP, "the keychain cannot be asked here (not a Mac)")
    return Result(cid, FAIL, "no Jira token: the keychain has no item {}".format(KEYCHAIN_SERVICE),
                  "add the Atlassian API token to the login keychain as generic password {} (any account name)".format(
                      KEYCHAIN_SERVICE))


@check("accounts", "jira-live")
def jira_live(ctx: Ctx) -> List[Result]:
    """Only with --online: do the credentials actually work against Jira?"""
    if not ctx.online:
        return []
    fetch = ctx.jira_fetch
    if fetch is None:
        from ledger import jira_read
        fetch = jira_read.make_fetch(ctx.env)
    if fetch is None:
        return [Result("accounts.jira-live", SKIP, "no credentials to try (see accounts.jira-email, accounts.jira-token)")]
    who = fetch("/rest/api/3/myself")
    if isinstance(who, dict) and who.get("accountId"):
        return [Result("accounts.jira-live", PASS, "Jira accepted the credentials")]
    return [Result("accounts.jira-live", FAIL, "Jira did not accept the credentials (or did not answer)",
                   "check the email, regenerate the Atlassian API token, and update the keychain item")]


@check("accounts", "claude-cli")
def claude_cli(ctx: Ctx) -> Result:
    cid = "accounts.claude-cli"
    path = shutil.which("claude", path=ctx.env.get("PATH"))
    for cand in ([] if path else [ctx.user_home / ".local" / "bin" / "claude", Path("/opt/homebrew/bin/claude"),
                                   Path("/usr/local/bin/claude")]):
        if os.access(str(cand), os.X_OK):
            path = str(cand)
            break
    if path:
        return Result(cid, PASS, "claude found at {}".format(ctx.tilde(path)))
    return Result(cid, WARN, "the claude command was not found; the summary and debrief jobs cannot call it",
                  "install Claude Code, or make sure ~/.local/bin is on the runner's PATH")


# -- graphs ----------------------------------------------------------------------------------------------------------

def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@check("graphs", "compiled")
def graphs_compiled(ctx: Ctx) -> Result:
    """Each compiled graph records the SHA-256 of every file it came from. The walker refuses a copy that no longer
    matches; this finds that before a run does."""
    cid = "graphs.compiled"
    root = ctx.copy / "graphs"
    flows = sorted((root / "flows").glob("*.yaml"))
    if not flows:
        return Result(cid, FAIL, "no graph files under graphs/flows in the laptop's copy", "python3 ~/.josh-360/repo/laptop/follow.py")
    problems: List[str] = []
    for flow in flows:
        name = flow.stem
        copy = root / "compiled" / (name + ".json")
        if not copy.is_file():
            problems.append("{}: no compiled copy".format(name))
            continue
        try:
            sources = json.loads(copy.read_text(encoding="utf-8"))["sources"]
            stale = [k for k, want in sources.items() if not (root / k).is_file() or _sha(root / k) != want]
        except (OSError, ValueError, KeyError, TypeError):
            problems.append("{}: compiled copy unreadable".format(name))
            continue
        if stale:
            problems.append("{}: out of date ({})".format(name, ", ".join(sorted(stale)[:3])))
    if problems:
        return Result(cid, FAIL, "; ".join(problems),
                      "in a cloud session: python3 graphs/tools/compile_graphs.py, then merge (the laptop cannot compile: it needs PyYAML)")
    return Result(cid, PASS, "{} graphs, each compiled copy matches its source files".format(len(flows)))


@check("graphs", "walker")
def walker_runs(ctx: Ctx) -> Result:
    cid = "graphs.walker"
    walker = ctx.copy / "graphs" / "tools" / "walker.py"
    if not walker.is_file():
        return Result(cid, FAIL, "graphs/tools/walker.py is missing from the laptop's copy", "python3 ~/.josh-360/repo/laptop/follow.py")
    code, _, err = ctx.run([sys.executable, "-B", str(walker), "--help"], 30)
    if code == 0:
        return Result(cid, PASS, "the walker starts on this Python")
    return Result(cid, FAIL, "the walker does not start on {} ({})".format(sys.executable, (err or "no message").strip().splitlines()[-1][:100] if (err or "").strip() else "no message"),
                  "run it with /usr/bin/python3; if it still fails it is a bug to report")
