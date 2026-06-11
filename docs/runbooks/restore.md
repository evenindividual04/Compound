# Database restore runbook

Backups: nightly encrypted `pg_dump` custom-format archives in Cloudflare R2 under
`backups/fin-YYYY-MM-DD.dump.age`, encrypted to the `age` public key whose
**private key lives only in the password manager** (entry: "fin backup age key").
Neon's free-tier PITR (~6h) is a convenience, not a backup — these archives are.

## Restore procedure

```bash
# 1. fetch the archive (rclone configured with the same R2 credentials as CI)
rclone copy R2:<bucket>/backups/fin-2026-07-01.dump.age .

# 2. decrypt (paste the age private key when prompted, or use -i keyfile)
age -d -o fin-2026-07-01.dump fin-2026-07-01.dump.age

# 3. restore into a FRESH database/branch — never straight over production
#    (Neon: create a new branch or database first and restore there)
pg_restore --no-owner --no-privileges -d "$TARGET_DATABASE_URL" fin-2026-07-01.dump

# 4. sanity-check the restored data before switching anything over
psql "$TARGET_DATABASE_URL" -c "SELECT count(*) FROM entries;"
psql "$TARGET_DATABASE_URL" -c "SELECT count(*) FROM ledger_anomalies WHERE resolved_at IS NULL;"
```

Then point the app's `DATABASE_URL` at the restored database (Vercel env var) and
run a manual invariant check: `curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/invariants`.

## Test-restore log

A restore MUST be tested once right after first deploy (Phase 1 acceptance) and
re-tested after any major schema change. Record each test here:

| Date | Archive | Target | Result |
| ---- | ------- | ------ | ------ |
| (first test pending — required before Phase 1 is accepted) | | | |

## Before destructive migrations

Create a Neon branch first: `neon branches create --name pre-<migration-name>`.
That branch is the instant rollback path; the nightly archive is the disaster path.
