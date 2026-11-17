# Local Cost Ledger

The cost ledger is a local SQLite database and CLI for importing message-level token usage from Claude Code, OpenCode, and Pi, assigning explicit prices, and reporting computed costs. Since JP-111 its tables live in `~/.josh-360/state/cache.db`, beside the artifact catalog, and josh-360's ledger (`ledger/costs.py`) copies cost, ticket links and titles from them into `ledger.db`. Atlas's background service schedules the imports through the costledger CLI. Nothing in Atlas shows cost any more; the ledger is where cost is read.

## Run it

```bash
npm run costledger -- <command> [flags]
```

Node.js `>=22.18` is required. The default database is `~/.josh-360/state/cache.db` (resolved under the current home directory). The database file is created with mode `0600`; its directory is created with mode `0700`. Pass `--db PATH` to any command to use a different database.

When inspecting the database with SQLite, open it normally:

```bash
sqlite3 ~/.josh-360/state/cache.db
```

Do not pass `-readonly`: the ledger uses SQLite WAL mode.

## Commands

The CLI accepts these commands and flags:

```text
usage: costledger <command> [flags]
  import     [--claude-dir P] [--pi-dir P] [--opencode-db P] [--migrate-identity] [--db P] [--json]   (a value of "none" skips a source; --migrate-identity upgrades an existing ledger, back it up first)
  report     --by repo|branch|worktree|tool|model|subagent|day|session [--from ISO] [--to ISO] [--db P] [--json]
  unpriced   [--from ISO] [--to ISO] [--db P] [--json]
  reprice    [--db P] [--json]
  price add  --model M --class C --usd N --effective-from ISO [--min N] [--note T] [--db P]
  model add  --model M --vendor V [--db P]   (registers a new model; then "price add" its rates and "reprice")
  alias add  --alias A --model M [--note T] [--db P]   (another spelling of a known model; then "reprice")
  reconcile  --bifrost-file P [--db P] [--json]
  logged-cost [--from ISO] [--to ISO] [--db P] [--json]
  trace      --id SOURCE_MESSAGE_ID [--db P] [--json]
  session    --tool claude-code|opencode|pi --id SESSION_ID [--from ISO] [--to ISO] [--db P] [--json]
  jira-link  --issue KEY --tool claude-code|opencode|pi --session SESSION_ID [--db P]   (records that a session worked on a Jira issue; not for issue creation)
  jira-cost  --issue KEY [--db P] [--json]   (cost of every session linked to the issue)
```

- `import` scans the default sources `~/.claude/projects`, `~/.pi/agent/sessions`, and `~/.local/share/opencode/opencode.db`. Use a source flag with `none` to skip that source.
- `report` groups the current priced ledger by the selected dimension. `--by session` reports session roots and their families; it is the session-oriented report dimension in addition to the regular dimensions shown above.
- `unpriced` groups messages with missing prices or model-name mappings.
- `model add` registers a model name and vendor in this ledger. `alias add` maps another spelling to a model already registered here.
- `price add` adds one model/token-class price row. Valid classes are `input`, `output`, `cache_read`, `cache_write_5m`, and `cache_write_1h`; `--usd` is USD per million tokens. `--min` is the minimum prompt-token count for a tier and defaults to `0`.
- `reprice` starts a new pricing run for the imported messages and writes a cost row only for messages whose result changed; it prints how many rows it wrote.
- `reconcile` compares ledger results with a Bifrost JSON file. The file must be an array of rows with `week`, `virtualKey`, `model`, `costUsd`, `requests`, `failures`, `promptTokens`, and `outputTokens` fields.
- `logged-cost` compares tool-reported cost with computed cost. `trace` shows the ledger row(s), pricing status, and price rows used for a source message ID.
- `session` shows one session tree for the selected tool and session ID.
- `jira-link` records that a session worked on an existing Jira issue, and `jira-cost` reports what that issue cost. See [Jira ticket cost](#jira-ticket-cost).

`--from` is inclusive and `--to` is exclusive. A date/time without a UTC marker or offset is interpreted as UTC.

## Normal workflow

1. Import the available sources, then report:

   ```bash
   npm run costledger -- import
   npm run costledger -- report --by model
   ```

   Other report dimensions include `repo`, `branch`, `worktree`, `tool`, `subagent`, `day`, and `session`.

2. Find names or token classes that still need pricing:

   ```bash
   npm run costledger -- unpriced
   ```

3. For `missing_alias`, either register a genuinely new model with `model add`, or add an alias only when that name should use the exact same prices as an existing model. Add any missing token-class prices with `price add`.

4. Recompute costs after adding models, aliases, or prices:

   ```bash
   npm run costledger -- reprice
   npm run costledger -- report --by model
   ```

`price add`, `model add`, and `alias add` update the ledger but do not themselves reprice messages. `import` also runs pricing after ingesting sources.

## Hourly refresh

Atlas's existing background service starts a cost-ledger import when the service starts, then once every 3,600 seconds while Atlas is running. The runner starts the normal costledger CLI in a child process, so transcript scanning does not block Atlas's server loop. Each import scans the configured Claude Code and Pi directories plus the default OpenCode database, then reprices changed messages. No separate scheduler or LaunchAgent is needed; import summaries and errors are written to `~/.josh-360/atlas/atlas.log`.

Atlas's macOS LaunchAgent manages the service and restarts it if it exits. A service restart triggers an immediate import; macOS sleep or logout can delay work until Atlas runs again. Claude Code may delete old transcripts, so keep Atlas running if older messages need to be retained. Manual imports remain available with `npm run costledger -- import`.

## How pricing works

Each pricing run is retained in the ledger, but a run writes a cost row only for a message whose result differs from that message's most recent row (a new message, or a change in its model, cost, price rows used, or status). Commands that report computed costs read each message's most recent cost row through the `latest_message_costs` view; after changing prices or mappings, run `reprice` to make the new rules visible in reports. Earlier cost rows are not overwritten, so you can still see what an earlier run said. A run that changes nothing writes no cost rows.

Prices are selected for the canonical model, token class, message timestamp, and prompt-token tier. The prompt count used for tier selection is the sum of input, cache-read, and cache-write tokens. To add a tier that applies above 272,000 prompt tokens, use `--min 272001`; the tier boundary is inclusive. For example, the seeded long-prompt tiers use that minimum.

When a new price replaces an open price row for the same model, token class, and `--min` tier, its `--effective-from` date must be strictly later than the current row's effective date. The prior row is closed at the new effective date. Date/time values without an offset are treated as UTC.

The `unpriced` statuses mean:

- `missing_alias`: the imported model name does not resolve to a registered model or alias.
- `missing_price`: the model resolves, but at least one token class with usage has no price row matching that message's date and prompt tier.

An alias causes the imported spelling to use the target model's complete price schedule; the CLI does not compare the two schedules. Check all token classes and tiers before aliasing, and only alias names that are truly priced identically. The seed contains distinct `claude-fable-5` and `claude-fable-5-1` model entries. Their cache-read rates differ, so do not alias one to the other.

Prices added through the CLI are stored only in the ledger; they do not edit `src/costledger/seed/price-seed.json`. A ledger rebuilt from scratch gets the seed prices during import, but not the CLI-added prices. Reapply those `price add` commands or update the seed separately if a rebuild must include them.

## Import behavior and database identity

Claude Code and Pi JSONL files are parsed before their rows, scan mark, and Claude spawn metadata are committed together in a per-file transaction. A failed file is not marked scanned, so a later import can retry it; unchanged files (same path, size, and modification time) are skipped. OpenCode is different: its database is read again on each import, and its imported message batch is committed as a transaction.


Atlas imports automatically at service start and hourly while its background service is running; manual imports are also supported. Claude Code may delete old transcripts, and the ledger can only keep what it has already imported, so keep Atlas running if older transcripts need to be retained. Cost rows grow only with real changes: a new message, or a price, alias or model change that alters a result. An import that finds nothing new writes none. Ledgers created before this change hold one full set of cost rows per earlier run (about 27 MB per run at 385,000 messages); those older repeated rows are harmless and can be removed separately.

An existing database with the old message-identity schema is refused untouched by ordinary commands: the CLI closes it before applying WAL settings or schema changes. Identity migration is available only through `import --migrate-identity`, and that flag requires an explicit `--db PATH`. Back up the database first; for example, use `import --migrate-identity --db /path/to/ledger.db` on the intended file.

## Session hierarchy

- `report --by session` lists session roots. A root's family includes its own calls and calls in its directed descendants. `session --tool claude-code|opencode|pi --id SESSION_ID` shows the selected session tree and each node's own and family costs.
- Claude Code family cost includes linked descendant subagents. When one Claude call is copied into more than one session transcript, the ledger keeps one canonical call; copies are represented as holders rather than extra priced calls.
- For OpenCode, `parent_id` defines the cost-parent link when present. `fork_session_id` is used as a parent only when `parent_id` is absent.
- Pi sessions are flat; the importer does not create Pi parent/child edges.
- Claude shared-history links between sessions are informational. They are not parent links and their costs are never added to a session family.

## Session names and PR links

Every import also records the human-friendly names a session carries, so a session can be found by keyword without knowing its ID. Two tables hold them; neither is a cost table.

`session_labels` has one row per `(tool, source_session_id, kind)`; `kind` is one of:

| kind | Source |
|---|---|
| `custom_title` | Claude Code `custom-title` (a name you set, for example with `/rename`); Pi `session_info` name (set with `/name`) |
| `ai_title` | Claude Code `ai-title` (auto-generated) |
| `agent_name` | Claude Code `agent-name` |
| `tool_title` | OpenCode session title; its "New session - ..." and "Child session - ..." placeholders are skipped |

`session_pr_links` has one row per `(tool, source_session_id, url)` with `repository` and `number`, from Claude Code `pr-link` records.

- When a session's name changes, the stored value is replaced; the last name in the transcript wins. Earlier names are not kept.
- Gaps are normal. A tool without a given kind, a transcript without the record, or a transcript Claude Code has since deleted simply has no row. Nothing is guessed or filled in.
- Claude Code and Pi files are read once and again only when they change (tracked in `label_scans`, separate from the cost scan, so transcripts imported before this table existed are covered on the first run). OpenCode is re-read each import. A first run over about 14 GB of Claude transcripts took about 30 seconds; an unchanged re-run takes well under a second.
- Subagent transcripts carry no names, so no labels are stored for them.
- Pi has no names in the existing data yet; rows appear once a Pi session is named.

Find a session by repo and keyword (open the ledger normally; do not pass `-readonly`):

```sql
SELECT DISTINCT l.tool, l.source_session_id, l.kind, l.value
FROM session_labels l
JOIN messages m ON m.tool = l.tool AND m.source_session_id = l.source_session_id
JOIN repos r ON r.repo_key = m.repo_key
WHERE r.display_name = 'claude-360' AND l.value LIKE '%ledger%';
```

## Recent parent sessions view

`session_overview_45d` is a ledger view with one row per parent session that had any activity in the last 45 days, newest first. Query it with plain `sqlite3` (do not pass `-readonly`):

```sql
SELECT last_active_at, title, jira_tickets, branch, folder, pr_links, tool, cost_usd
FROM session_overview_45d;
```

| Column | Meaning |
|---|---|
| `tool`, `session_id` | The tool and the session's ID |
| `title` | `custom_title` when present; otherwise `tool_title`; otherwise `ai_title` |
| `jira_tickets` | Tickets from `jira_session_links`, comma-separated |
| `branch`, `folder` | The most recent known value, preferring the parent session's own calls over its subagents' |
| `pr_links` | Pull request URLs from `session_pr_links`, comma-separated |
| `cost_usd` | Whole-family cost: the session plus every subagent and child session, over the session's whole life (not only the last 45 days) |
| `unpriced_messages` | Calls with no price yet; when above zero, `cost_usd` is only the known part |
| `first_active_at`, `last_active_at` | Earliest and latest call across the family |

- A parent session is one no other session spawned. Claude subagents and OpenCode child sessions are never rows; their cost is in the parent's `cost_usd`.
- A session is included when any call in its family falls in the last 45 days, so a long-running session appears even if it started earlier.
- Unknown cost is `NULL`, never zero. Empty titles, tickets and PRs are `NULL`, not empty text.
- `cost_usd` matches `report --by session` for the same sessions (a test checks this, and so did a run against a copy of the live ledger).
- Many tiny background sessions from tools such as claude-mem run in `~/.claude-mem/observer-sessions`; they are real sessions and are included. Filter them out with `WHERE folder NOT LIKE '%/.claude-mem/%'`.
- The view is created or refreshed whenever the ledger is opened by the costledger CLI, including Atlas's hourly import. It reads the ledger live, so it is always current and stores nothing.

## Jira ticket cost

The `jira_session_links` table records which sessions worked on which Jira issue, so an issue's cost can be reported from the ledger. One row per `(issue_key, tool, source_session_id)`; `action` is always `worked`, and recording the same pair again keeps one row. `issue_key` must look like `AD-123`. Sessions that only created an issue are not linked. The `using-jira` skill says when a session records a link.

- `jira-cost` sums the latest cost of every message held by a linked session, counting each message once even if two linked sessions hold it. It also prints the number of unpriced messages; when that is above zero the total is incomplete.
- The cost is for each linked session as a whole, not only the time spent on the ticket. A session linked to two issues counts toward both, so ticket totals can add up to more than the ledger's total spend.
- Links start empty and are recorded only from the time a session logs them; earlier work is not backfilled.
