#!/usr/bin/env bash
set -euo pipefail

# Run inside the dedicated PostgreSQL test container after migrations and tests finish.
if [[ ${POSTGRES_DB:-} != stagelink_test || ${POSTGRES_USER:-} != stagelink ]]; then
  printf '%s\n' 'This drill requires the StageLink PostgreSQL test container.' >&2
  exit 1
fi

connection=(--host=/var/run/postgresql --username=stagelink --no-password)
source_db=stagelink_test
umask 077
workdir=$(mktemp -d /tmp/stagelink-postgres-restore.XXXXXXXX)
restore_db="stagelink_restore_${workdir##*.}_test"
created=false

cleanup() {
  local result=$?
  trap - EXIT
  if [[ $created == true ]] && ! dropdb "${connection[@]}" --maintenance-db=postgres "$restore_db"; then
    printf '%s\n' 'Could not remove the scratch restore database.' >&2
    result=1
  fi
  rm -f -- "$workdir/archive.dump" "$workdir/source.snapshot" "$workdir/restore.snapshot" || result=1
  rmdir -- "$workdir" || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

snapshot() {
  psql "${connection[@]}" --dbname="$1" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';

SELECT format(
  $query$SELECT %L, count(*), md5(coalesce(string_agg(fingerprint, '' ORDER BY fingerprint), ''))
    FROM (SELECT md5(to_jsonb(entry)::text) AS fingerprint FROM %I.%I AS entry) AS rows$query$,
  'table:' || tablename, schemaname, tablename)
FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
\gexec

SELECT format('SELECT %L, last_value, is_called FROM %I.%I',
  'sequence:' || sequencename, schemaname, sequencename)
FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename
\gexec

SELECT 'constraint', tbl.relname, con.conname, con.convalidated, pg_get_constraintdef(con.oid)
FROM pg_constraint AS con
JOIN pg_class AS tbl ON tbl.oid = con.conrelid
JOIN pg_namespace AS ns ON ns.oid = tbl.relnamespace
WHERE ns.nspname = 'public' ORDER BY tbl.relname, con.conname;

SELECT 'index', tablename, indexname, indexdef
FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname;

COMMIT;
SQL
}

migrations=$(psql "${connection[@]}" --dbname="$source_db" -XAtq -v ON_ERROR_STOP=1 \
  -c 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')
if [[ $migrations -eq 0 ]]; then
  printf '%s\n' 'Run the StageLink migrations before the restore drill.' >&2
  exit 1
fi

snapshot "$source_db" > "$workdir/source.snapshot"
pg_dump "${connection[@]}" --dbname="$source_db" --format=custom --file="$workdir/archive.dump"
createdb "${connection[@]}" --maintenance-db=postgres --template=template0 "$restore_db"
created=true
pg_restore "${connection[@]}" --dbname="$restore_db" --single-transaction --no-owner --no-privileges "$workdir/archive.dump"
snapshot "$restore_db" > "$workdir/restore.snapshot"

if ! cmp -s "$workdir/source.snapshot" "$workdir/restore.snapshot"; then
  printf '%s\n' 'The restored PostgreSQL data or schema checks differ from the source.' >&2
  exit 1
fi
printf '%s\n' 'PostgreSQL restore matched table contents, sequences, constraints and indexes.'
