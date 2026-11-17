# JP-150 proof: copy the ledger's daily backups to Azure blob storage

## Contents

- [Scenarios](#scenarios)
- [What still needs the laptop](#what-still-needs-the-laptop)

## Scenarios

The container in every test is a made-up folder behind the same four calls as the real client (`tests/azure_fake.py`), and the Azure CLI is replaced by a recording stand-in. No test reaches Azure, and every ledger row is made up. The tests are in `tests/test_ledger_upload.py`; `01-upload-tests.txt` is their run.

| Scenario | Proof | Test |
| --- | --- | --- |
| A new backup is uploaded | `01-upload-tests.txt` | `Sync.test_a_new_backup_is_uploaded` (also: not uploaded twice, replaced when the size differs, only dated `ledger-*.db.gz` names go up, the container keeps 14 daily and 8 weekly) |
| A failed upload is reported, not hidden | `01-upload-tests.txt` | `Job.test_a_failed_upload_is_reported_and_the_local_backup_kept`, `Job.test_a_failure_keeps_the_time_of_the_last_success`, `Sync.test_nothing_is_removed_when_the_container_cannot_be_listed` |
| A redaction reaches the uploaded copies | `01-upload-tests.txt` | `Redaction.test_a_redaction_reaches_the_uploaded_copies`, `Redaction.test_a_remote_only_copy_is_redacted_too`, `RedactCommand.test_the_command_also_rewrites_the_uploaded_copies` (also: an unreachable container or an unreadable copy keeps the redaction owed, a redaction queued while an upload run is working is not lost, and the queue holds where, never what) |
| No secret is stored | `01-upload-tests.txt` | `Config.test_a_file_holding_a_secret_is_refused`, `AzCli.test_every_call_signs_in_as_josh_and_carries_no_key`, `AzCli.test_a_key_in_the_environment_is_not_passed_on` |
| The laptop uploads a real backup (`@manual`) | see below | after the merge |
| The suite still passes | `02-suite.txt` | `python3 scripts/check.py` |

## What still needs the laptop

Two things only Josh can do, because the sign-in is his own identity and the container is his. Nothing else needs him.

1. Choose the storage account and container for the copies (a container in an account he owns), make sure his Azure user can write blobs there (the Storage Blob Data Contributor role on that container), and run `az login` on the laptop once.
2. Write the two names (not secrets) into `~/.josh-360/state/azure-backup.json`:

   ```json
   {"account": "<storage account name>", "container": "<container name>"}
   ```

   The job refuses a file that holds anything else. `JOSH360_AZURE_ACCOUNT` and `JOSH360_AZURE_CONTAINER` in the job's environment do the same.

Merging installs the job on the laptop (JP-105). Until step 2 is done, `python3 laptop/status.py show` lists `reports/ledger-upload.json` with `"status": "not-configured"`. After it, and after the next daily run, the report should say `"status": "ok"` with a `last_success` time and the names uploaded. If it says `failed`, its `error` line is the first line of what `az` said (usually a missing `az login` or a missing role); the local backups are untouched and the next daily run catches up every missing copy.
