# JP-160 proof: jobs.yaml reads as standard YAML

## Contents

- [Scenarios](#scenarios)
- [Commands run](#commands-run)

## Scenarios

| Scenario (from the ticket) | Tag | Proof |
| --- | --- | --- |
| `yaml.safe_load(open('jobs.yaml'))` succeeds, and the parsed jobs match what `laptop/common.load_jobs` returns | @auto | `tests/test_check_jobs_yaml.py`: `test_safe_load_reads_the_real_file`, `test_both_readers_give_the_same_jobs` (every key of every job, and the `load_jobs` result) |
| The strict reader still accepts the file, and reads quoted text the way YAML does | @auto | `test_both_readers_give_the_same_jobs`; `StrictReaderQuotesTest` (double quotes hold ": ", `''` in single quotes is one quote, anything YAML would read differently is refused); the existing `tests/test_install.py` `JobsFileTest` |
| A check in `scripts/check.py` keeps it that way | @auto | check 17, `jobs_yaml_problems`; `CheckTest` (an unquoted ": ", a value YAML reads as another type such as `yes` or `12`, and a file the laptop's reader refuses each fail it) |

## Commands run

Cloud session, 18 November 2026, Python 3.13 with PyYAML 6.0.3.

Before (the file on `main`):

```text
$ git show origin/main:jobs.yaml | python3 -c "import sys,yaml; yaml.safe_load(sys.stdin)"
yaml.scanner.ScannerError: mapping values are not allowed here
  in "<stdin>", line 48, column 231
```

After:

```text
$ python3 -c "import yaml; yaml.safe_load(open('jobs.yaml'))"; echo exit $?
exit 0

$ python3 -m unittest tests.test_check_jobs_yaml
Ran 12 tests
OK

$ python3 laptop/run_jobs.py --list | wc -l
17

$ python3 scripts/check.py
OK
check.py: ok (0 problem(s))
```

The new tests were also run against `main`'s `jobs.yaml` and `laptop/common.py`: 8 failures and 2 errors, so they test the change and not just the comparison. Nothing here runs on the laptop, and no laptop step is owed: the laptop's next `follow` reads the quoted description with the same reader the tests use.
