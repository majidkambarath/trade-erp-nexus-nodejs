# Backups and disaster recovery

How the books are protected against loss, how they are put back, and the record that the putting back has been
practised. Scripts: `scripts/backup/` (their README has the details of each). Retention: Settings > Business rules >
Record keeping (5 years after the tax period, 15 for real estate); nothing in the application deletes business records.

## Targets

| | Target | What makes it true |
| --- | --- | --- |
| **RPO** (most data that can be lost) | 24 hours | the daily backup below |
| **RTO** (longest the books can be unavailable after a loss) | 4 hours | the restore procedure below, rehearsed by the drill |

These are the targets for the current hosting (Render web service, MongoDB Atlas shared cluster). A shared Atlas
tier has no point-in-time recovery of its own; the daily export is the backup.

## What is backed up

- **Every organisation's database records**, one directory per organisation, as `scripts/backup/export.js --all`
  writes them: every collection, the hidden fields included (a restore without password hashes cannot be signed
  into), the console's own accounts, a manifest with the row count per collection and **a SHA-256 checksum of every
  file**.
- **Not in it: attachment files** (scanned invoices, KYC documents). They are in Cloudinary, which keeps them
  durably; the manifest lists their keys and how many there are. Copy them separately if Cloudinary itself is
  in scope.

## The schedule

`.github/workflows/backup.yml` runs every day at 02:30 Dubai time (and on demand from the Actions tab). It
exports every organisation, compresses and **encrypts** the result (AES-256, passphrase in a repository secret),
and keeps it as a workflow artifact for 35 days.

**It does nothing until these repository secrets are set**: `MONGO_URI` (production, read access is enough) and
`BACKUP_PASSPHRASE`. Keep the passphrase somewhere other than GitHub: without it no backup can be opened.

Also keep a **monthly copy outside GitHub and outside Atlas** (download the artifact; it is already encrypted). A
backup kept only beside what it protects is one failure from gone. Old copies are client data: delete them on a
schedule once they are past the retention period.

## Restoring

1. Download the artifact and decrypt it:
   `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in backup.tar.gz.enc -out backup.tar.gz -pass env:BACKUP_PASSPHRASE`
   then `tar -xzf backup.tar.gz`.
2. Restore the organisation into an **empty** database:
   `node scripts/backup/import.js --from backup/<stamp>/<org> --confirm --db <new database name>`.
   It checks every file against its checksum first and refuses a changed or missing one, refuses to write into a
   database that already holds the organisation (a restore is not a merge), and refuses at the end if the row
   count differs from the manifest.
3. Point a test deployment at that database, sign in and check the trial balance and the VAT return for the last
   period.
4. Only then decide what to do with the live database. That is a conversation with the client, not a script.

A restored copy's attachment rows name the source's files: treat a restored copy as read-only until decided.

## The drill (practise it)

`npm run backup:drill -- --org <code>` exports one organisation, restores it into a throwaway database, compares
every collection row for row and every account's debits and credits, proves the restored ledger balances, then
drops the throwaway database. It prints a line for the table below. Run it:

- once a quarter;
- after any change to the models;
- after any change to the hosting or the Atlas cluster.

Run against the live database it only reads; rows written while it runs show as differences, so run it when nobody
is working. A drill that fails means the backup cannot be trusted until it passes.

### Drill log

| Date | Organisation | What was checked | Ledger (debits / credits) | Result | Took |
| --- | --- | --- | --- | --- | --- |
| 2026-11-27 | test organisation (throwaway database) | every collection, files checked against their checksums | balanced | passed (automated test `backupDrill.test.js`) | ~1 min |

The first drill against production is owed: it needs someone with the production `MONGO_URI` to run
`npm run backup:drill -- --org <code>` for each client and add the line here.

## When something is lost

| What happened | What to do |
| --- | --- |
| A record was deleted by mistake | Audit log > Deleted records keeps it whole; an approved document is never deleted (it is cancelled and kept). Nothing to restore. |
| A wrong change was saved | Audit log shows each field's old value. Change it back, or correct the document with a credit note. |
| The application is down (Render) | Redeploy the last good version from Render's dashboard; the data is in Atlas and unaffected. |
| The database is lost or corrupted | Restore each organisation from the latest backup into a new database (above), point the service at it, and tell each client what period after the backup must be re-entered. |
| A backup will not open | Check the passphrase; try the previous day's; if none open, run an export by hand immediately and fix the schedule. |
