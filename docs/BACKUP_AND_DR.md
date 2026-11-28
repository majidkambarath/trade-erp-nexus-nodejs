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

`.github/workflows/backup.yml` runs every day at 02:30 Dubai time (and on demand: Actions > backup > Run
workflow). It runs **one job per Atlas cluster**, exports every organisation on it, compresses and **encrypts** the
result (AES-256), keeps it as a workflow artifact for 35 days, and copies it off-site to **Backblaze B2**. The run's
summary lists the rows per organisation and the file's SHA-256.

| Cluster (matrix entry) | Who is on it | Secret with its connection string |
| --- | --- | --- |
| `shared` | brivox-production, abc, al-manara-garage, al-khaleej-frozen, the demos | `MONGO_URI` |
| `golden-arrow` | golden-arrow | `MONGO_URI_GOLDEN_ARROW` |

A new client on its own cluster: add a line to the workflow's matrix and its secret.

**Repository secrets** (Settings > Secrets and variables > Actions):

- the connection strings above. Make each with a database user that can only read: in Atlas, Database Access >
  Add new database user, role **Only read any database**, a long generated password. The export only reads (it
  creates no collections and builds no indexes), so it needs nothing more. GitHub's machines have no fixed
  address, so the cluster's Network Access must allow `0.0.0.0/0`. The read-only user and its password are then
  the protection.
- `BACKUP_PASSPHRASE`: a long random passphrase. **Keep a copy in a password manager.** Without it no backup can be
  opened, and GitHub never shows a secret again.
- `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET`, `B2_ENDPOINT` (all four or none): the off-site copy, below.

**A missing connection string or passphrase FAILS the run** (red, naming the secret). GitHub emails a failed
scheduled run to whoever last edited the schedule, so check that email. With no `B2_*` secrets the run passes with
a warning and keeps the copy in GitHub only.

**Off-site copy (Backblaze B2).** A backup kept only beside what it protects is one failure from gone, so every
copy also goes to a private B2 bucket:

- `daily/<cluster>/<YYYY-MM-DD>.tar.gz.enc`, every run;
- `monthly/<cluster>/<YYYY-MM>.tar.gz.enc` on the 1st (Dubai date). If that run failed, run the workflow by hand
  with **monthly** ticked.

Setting it up, once:

1. Create a **private** bucket (Buckets > Create a bucket, files private).
2. Under the bucket's Lifecycle Settings, add custom rules. Prefix `daily/`: hide after 35 days, delete 1 day after
   hiding. Prefix `monthly/`: hide after 365 days, delete 1 day after hiding. Old copies are client data, and these
   rules are what deletes them.
3. Create an application key (Application Keys > Add a new application key): allow access to **that bucket
   only**, type of access **Write Only**. A leaked key can then add files but never delete the backups; the
   lifecycle rules do the deleting.
4. Put its keyID in `B2_KEY_ID`, its applicationKey in `B2_APP_KEY`, the bucket name in `B2_BUCKET`, and the
   bucket's S3 endpoint (shown on the bucket, for example `s3.eu-central-003.backblazeb2.com`) in `B2_ENDPOINT`.
5. Run the workflow by hand and check that a file appears under `daily/` for each cluster.

The whole shared cluster was about 200 KB encrypted on 28 Nov 2026, so B2's free 10 GB lasts for years.

## Restoring

1. Download the copy (the run's artifact, or the file from B2) and decrypt it:
   `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in backup-<cluster>-<day>.tar.gz.enc -out backup.tar.gz -pass env:BACKUP_PASSPHRASE`
   then `tar -xzf backup.tar.gz`. A wrong passphrase answers `bad decrypt`.
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
| 2026-11-27 | brivox-production (live, shared cluster) | 729 rows, 37 files checked against their checksums | 54,799.59 / 54,799.59 | passed | 125 s |
| 2026-11-27 | golden-arrow (live, its own cluster, via `.env.golden-arrow`) | 226 rows, 29 files checked against their checksums | 0 / 0 (no ledger entries yet) | passed | 135 s |
| 2026-11-28 | brivox-production (live, shared cluster), the nightly job's path | export with no `.env` (as on GitHub), encrypted and decrypted with the workflow's `openssl` lines (byte-identical), restored into a throwaway database: 732 of 732 rows; collection counts unchanged on both clusters (the export wrote nothing) | 54,799.59 / 54,799.59 | passed | ~2 min |

The first drill against production was run on 27 Nov 2026 for both live clients (above). Next: once a quarter.
A client on its own cluster is drilled with that cluster's env file loaded (its `MONGO_URI` must win over `.env`).

## When something is lost

| What happened | What to do |
| --- | --- |
| A record was deleted by mistake | Audit log > Deleted records keeps it whole; an approved document is never deleted (it is cancelled and kept). Nothing to restore. |
| A wrong change was saved | Audit log shows each field's old value. Change it back, or correct the document with a credit note. |
| The application is down (Render) | Redeploy the last good version from Render's dashboard; the data is in Atlas and unaffected. |
| The database is lost or corrupted | Restore each organisation from the latest backup into a new database (above), point the service at it, and tell each client what period after the backup must be re-entered. |
| A backup will not open | Check the passphrase; try the previous day's; if none open, run an export by hand immediately and fix the schedule. |
