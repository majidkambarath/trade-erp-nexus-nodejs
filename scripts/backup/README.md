# Backups

Every client shares one database, tagged by `companyId`. So an Atlas snapshot is **all of them at once**:
restoring it to put one client's month back would roll the other clients back too. These two scripts take and
put back **one organisation**, which is the thing you actually need the day a client asks.

```bash
npm run backup -- --org gulf-foods            # one client
npm run backup -- --all --out D:/backups      # every client, plus the console's own accounts
npm run backup:restore -- --from D:/backups/2026-10-12T.../gulf-foods --confirm
```

A restore goes into a **database of its own** — point `MONGO_URI` at an empty one. There is no "restore a
copy beside the original": every row keeps its `_id` so the references between them still resolve, and
`Admin.email` is unique across all organisations, so a second copy of the same people cannot sit next to the
first whatever it is called.

The default output directory is `backups/` in this repo, which is gitignored.

## Why the export cannot leak one client into another's backup

Every read runs inside `runWithTenant`, so `utils/tenantPlugin.js` writes the `companyId` filter — the script
does not, and so cannot get it wrong. Asked for one organisation it is incapable of reading another's rows.
That is a stronger promise than a `--query` typed by hand, and it is checked: of 10,947 rows exported from a
database holding four organisations, every single one carried the right tag.

Fields a schema marks `select: false` are asked for by name (read off the schema, not listed), because a
backup without `Admin.password` restores accounts that cannot sign in. The manifest records which were taken.

## What is NOT in it

- **Attachment files.** They are in Cloudinary, not the database (`services/core/attachmentService.js`).
  Cloudinary is durable storage, so they are not at risk the way the old ephemeral disk was, but they are not
  in this dump either. The manifest lists their keys and count so a restore can say what it is missing.
- **Anything written after the dump ran.** This is a point-in-time copy, not continuous.

## Restoring

`import.js` refuses to write into an organisation that already holds anything, because **a restore is not a
merge**: putting rows back on top of the ones that survived would duplicate them and leave the books neither
one thing nor the other. So the real procedure is:

1. Restore into an **empty** database (a new Atlas database on the same cluster is fine) with `--confirm`.
2. Check it there: sign in, open the trial balance, confirm it balances and the figures look right.
3. Only then decide what to do with the live one — which is a conversation with the client, not a script.

A restored copy's `Attachment` rows still name the **source** organisation's Cloudinary assets. Reading them
is fine; deleting a file in the copy would delete the original's, so treat a restored copy as read-only until
you have decided what it is for.

## Rehearse it before you need it

An export nobody has restored is not a backup. Do this once, and after any change to the models:

```bash
npm run backup -- --org <code>
# point MONGO_URI at a throwaway database name, then
npm run backup:restore -- --from backups/<stamp>/<code> --confirm
```

The import prints the row count and refuses if it disagrees with the manifest. Then check the trial balance.

## Scheduling it

There is deliberately **no timer inside the server**. The app runs on an instance whose disk does not survive
a deploy, so a backup written there would be deleted by the next one — which is the very problem backups
exist for. The schedule has to live outside the app. Pick one:

- **Your own machine (simplest, and what to start with).** A daily task that runs the export against the
  production `MONGO_URI` and keeps the output on a disk you control. On Windows:

  ```
  schtasks /Create /TN "Zarvia backup" /SC DAILY /ST 02:00 ^
    /TR "cmd /c cd /d \"C:\path\to\trade ERP node\" && npm run backup -- --all --out D:\backups"
  ```

  It only runs when the machine is on, so check the output directory weekly until you trust it.

- **A scheduled cloud job.** A Render cron job or a GitHub Actions schedule. Both work; both need the
  production `MONGO_URI` as a secret. **A dump holds the clients' whole books, password hashes and two-factor
  secrets**, so if it goes anywhere shared, encrypt it first (`tar` then `openssl enc`, passphrase in the same
  secret store) and keep in mind that losing the passphrase loses the backups.

Whatever you choose: keep more than one copy, keep one of them somewhere Atlas is not, and delete old dumps
on a schedule — they do not stop being client data because they are old.
