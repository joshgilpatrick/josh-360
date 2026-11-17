# Ledger migrations

## Contents

- [How a schema change is made](#how-a-schema-change-is-made)
- [What a migration may do](#what-a-migration-may-do)

`ledger/schema.sql` builds a new ledger at version 1. Every later change is a file here, applied in order by `laptop/install.py` (the ledger step) after a backup of the database.

## How a schema change is made

1. Name the file `NNNN-<short-name>.sql`, where `NNNN` is one more than the newest migration here (the first is `0002`). Check the newest on `main` and in other open pull requests before numbering.
2. Write only SQL. The runner applies the file, the `schema_migrations` row and `PRAGMA user_version` in one transaction; if any statement fails, nothing is applied.
3. Add a test under `tests/` for the new table or column.

## What a migration may do

It only adds: new tables, new columns with a default, new views, new indexes, new codes (`ledger/codes.json`). It never rewrites rows. The runner refuses a file that holds `UPDATE`, `DELETE`, `DROP`, `REPLACE` or `ALTER TABLE ... DROP/RENAME` outside a trigger body.

Every new table needs its two triggers, `<table>_no_update` and `<table>_no_delete`, in the same file, written the way `schema.sql` writes them. A file that creates a table without them is refused.

A change that needs different rows gets a new table and a view that joins the old and the new.
