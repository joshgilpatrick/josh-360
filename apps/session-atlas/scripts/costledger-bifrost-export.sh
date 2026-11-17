#!/bin/zsh
# Read-only weekly aggregates for one informational comparison; run manually once, never schedule.
# Usage: scripts/costledger-bifrost-export.sh <weeks-back> <output.json>
# The Postgres password is fetched into an environment variable and never printed.
set -eu
WEEKS="${1:?weeks back (integer, 0 = current week only)}"
OUT="${2:?output file}"
case "$WEEKS" in (*[!0-9]*|'') echo "weeks must be a non-negative integer" >&2; exit 2;; esac
PGPASSWORD="$(az keyvault secret show --vault-name eventus-apps --name bifrost-logs-pg16-eventus-apps-usage-reader-password --query value -o tsv)"
export PGPASSWORD
CONN="host=bifrost-logs-pg16.postgres.database.azure.com dbname=bifrost user=usage_reader sslmode=require"
psql "$CONN" -X -At -v ON_ERROR_STOP=1 -v weeks="$WEEKS" > "$OUT" <<'SQL'
select coalesce(json_agg(r order by r."week", r."virtualKey", r."model"), '[]'::json) from (
  select to_char(date_trunc('week', timestamp at time zone 'UTC'), 'YYYY-MM-DD') as "week",
         virtual_key_name as "virtualKey",
         model as "model",
         coalesce(sum(cost), 0)::float8 as "costUsd",
         count(*)::int as "requests",
         (count(*) filter (where status <> 'success'))::int as "failures",
         coalesce(sum(prompt_tokens), 0)::float8 as "promptTokens",
         coalesce(sum(completion_tokens), 0)::float8 as "outputTokens"
  from logs
  where virtual_key_name in ('claude-code-cli', 'opencode', 'pi')
    and timestamp >= (date_trunc('week', now() at time zone 'UTC') - make_interval(weeks => :weeks)) at time zone 'UTC'
  group by 1, 2, 3
) r;
SQL
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('rows:', len(d))" "$OUT"
