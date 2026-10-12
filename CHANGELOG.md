# Changelog

## 1.2.0.0 — 12 October 2026

The release that makes it safe to put two paying clients on one deployment. No new customer-facing feature:
it closes the defects that only appear once there is real money and a second organisation.

### Fixed

- **Attachments survive a deploy.** They were written to the server's own disk, which Render wipes on every
  deploy and restart, while the database rows stayed — so a client saw a document in the list and got an error
  on clicking it. They now go to Cloudinary, raw and **private**: the plain address answers 401, and only a
  60-second signed address opens it, fetched on the server and piped so the download keeps its organisation
  check and headers. Existing rows record `storage: "disk"` and are still read from where they are.
- **Production no longer runs under a file watcher.** `npm start` was `nodemon server.js`, and nodemon was a
  production dependency. `start` is `node server.js`, `dev` is the watcher, and moving nodemon to
  devDependencies took three high-severity advisories out of what production installs (5 → 2).
- **The developer console shows the figure the limits are enforced on.** It counted a client's monthly
  documents over UTC's month and included the go-live opening invoices, while the enforcer uses the
  organisation's own month and excludes them — so a client just loaded looked nearly out of documents.
- **A limit no longer offers room a feature gate refuses.** The standard plan printed `branches: 3` but does
  not include `multiBranch`, and the feature is checked first, so all three were unreachable.
- **The dev-server addresses are no longer trusted in production.** With `SameSite=None` cookies, a page on
  someone's own machine could call the live API with their session.

### Also fixed, after a security review of the release

- **The backup's `--as` flag could not do what it claimed** and is gone. It rewrote `companyId` but every row
  kept its `_id`, so restoring a copy beside the original — its only purpose — collided on every row and on
  the globally unique `Admin.email`. Minting new ids would mean rewriting every reference between them, and a
  restore that gets one wrong is worse than none. A restore goes into a database of its own.
- **The export dropped every field a schema hides** — nine of them, `Admin.password` and the two-factor
  secrets among them. Row counts matched, so the first proof passed: the restore produced the right number of
  accounts, none of which could sign in. The paths are read off each schema now.
- `insertMany` on restore is ordered, so a row that will not go in stops the restore instead of leaving gaps.

The review found nothing exploitable. Three of the fixes above are themselves security fixes.

### Added

- **Per-organisation backup and restore** — `npm run backup -- --org <code>` and `npm run backup:restore`.
  One shared database means an Atlas snapshot is every client at once; these take and return one. Every read
  runs inside the tenant scope, so the plugin writes the filter and the script cannot read another
  organisation's rows. See `scripts/backup/README.md`, including how to schedule it and why that cannot live
  inside the server.
- **A start-up warning when no mail provider is set**, because `SYSTEM_MAIL_PROVIDER` defaults to sending
  nothing: "forgot my password" answers the person normally and no mail leaves the building.

### Settings

`ATTACHMENT_STORAGE` (`disk` | `cloudinary`; unset follows whether Cloudinary is configured) is new. The
Cloudinary credentials are now needed before the first upload, and `SECRET_BOX_KEY` must be set **before**
anyone enrols two-factor or their recovery codes become unreadable. No database migration.
