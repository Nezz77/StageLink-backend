#!/bin/sh
# Run from repository root. Explicit isolated test infrastructure only.
set -eu
export NODE_ENV=test
export AUTH_JWT_SECRET=0101010101010101010101010101010101010101010101010101010101010101
export AUTH_MAIL_KEY=0202020202020202020202020202020202020202020202020202020202020202
export PAYOUT_DATA_KEY=0303030303030303030303030303030303030303030303030303030303030303
export S3_ENDPOINT=http://127.0.0.1:59091
export S3_BUCKET=stagelink-media-test
export SMTP_HOST=127.0.0.1
export SMTP_PORT=11025
export MAILPIT_API_URL=http://127.0.0.1:18025
export DATABASE_URL='postgresql://stagelink:local-test-only@127.0.0.1:55433/stagelink_test?connect_timeout=3'
export REDIS_URL='redis://127.0.0.1:56380'
docker compose -f infra/compose.test.yml up -d --wait
npm --prefix backend run db:generate
npm --prefix backend run db:migrate
npm --prefix backend run db:migrate
npm --prefix backend run test:integration
# Leave services available for inspection. Stop them with compose down when done.
