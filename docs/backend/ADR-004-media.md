# ADR 004 — Durable private media and publication

Date: 2026-11-03. Scope: P04, using the report's AWS S3 storage choice, NestJS/Prisma/PostgreSQL, the Node worker and the existing React/Vite frontend.

## Storage and upload lifecycle

`MediaStore` uses the AWS SDK v3. Production uses the normal AWS credential chain, a configured private bucket/region and server-side AES256 encryption on writes. Production configuration rejects the local adapter. No live AWS credentials or bucket were configured or tested in this checkpoint.

Development/test use pinned Adobe S3Mock 5.2.3, bound only to loopback plus the internal Compose network. Development bytes live in a named Docker volume. This emulator is explicitly not a production security boundary: its S3 authentication/signatures are not validated. The application therefore enforces ownership and read capabilities itself, and never gives browsers the emulator endpoint or S3 keys. Production still needs IAM, public-access blocking, storage lifecycle/backups and deployment review.

An authenticated, verified account initiates an upload with a server-owned UUID, purpose, bounded size/MIME, filename and SHA-256. Strict bodies reject caller-supplied ownership/status. Limits are 8 MiB for JPEG/PNG/WebP, 20 MiB for MP3/WAV and 40 MiB for MP4/WebM. Avatar, equipment and evidence purposes require images. Upload intents are limited to 30/hour and the account library to 100 non-purged assets / 500 MiB reserved bytes.

The browser uploads binary bytes through the API under Bearer/Origin/CSRF checks. This bounded proxy is an intentional v1 choice rather than an unrestricted browser-to-S3 PUT. It allows one upload claim, exact byte/hash verification, two concurrent uploads per API process and a 30-second receive deadline. Nginx streams request bodies to avoid unnecessary quarantine copies. A distributed concurrency limit is future scaling work; PostgreSQL account quotas remain transactional across API instances.

States are pending → uploading → staged → uploaded → processing → ready or rejected. Staged bytes remain quarantined until explicit finalization commits the durable queue transition. Repeated finalization is safe. Finalization/retry scheduling use the database clock, so small app/database clock differences cannot hide an immediately finalized job. Failed/expired intents cannot overwrite another object. Keys use UUIDs, never supplied filenames.

## Processing and recovery

The existing Node worker scans media rows independently from its BullMQ/outbox and mail scanners. The asset row is the durable processing job: an atomic PostgreSQL claim uses `FOR UPDATE SKIP LOCKED`, a lease UUID, three-minute expiry and bounded attempts. This avoids a second authoritative job state or a Redis delivery gap for this small queue. Restart reclaims an expired lease; an interrupted fifth attempt becomes rejected rather than remaining stuck. Storage errors retry with bounded backoff. Deterministic derivative keys and guarded completion make retries idempotent.

Sharp decodes image bytes, limits input to 16 million pixels and one frame, applies orientation and produces WebP display/thumbnail derivatives without embedded EXIF metadata. FFprobe/FFmpeg receive a fixed demuxer and `file,pipe` protocols only, with bounded subprocess time/output, CPU thread counts and dimensions. Input audio/video may be at most ten minutes. The worker creates an actual preview of up to thirty seconds, measured preview duration, video poster and audio waveform derived from decoded samples. No claimed duration, waveform or fallback performance is fabricated.

Validation/re-encoding is not an antivirus guarantee. Executable/archive/SVG and PDF uploads are not accepted. Document handling and any extra evidence formats must be added when their owning verification/chat/support phases become live. Production worker isolation/resource limits and malware policy remain deployment work.

## Ownership, access and retention

Only ready, processed variants can be read. Quarantine originals are never exposed by an API route. Read URLs are application-signed, purpose-specific capabilities lasting sixty seconds. Private capabilities bind a current SQL session/account; logout, disabled accounts and role changes are rechecked at each read. These JWTs cannot act as account access tokens. Public capabilities bind the exact approved portfolio revision and approved provider, so edits/removal withdraw access immediately.

The API rechecks owner/approved-reference authorization on every download. A media-review administrator can read only files actually waiting in that review queue, not an arbitrary user's library. GETs and capability issuance are rate limited; at most four derivative downloads buffer concurrently per API process. Responses disable caching, sniffing and referrer transmission. API logs contain server request ID/method/status/duration; Nginx's custom format uses `$uri`, excluding capability query strings.

A current avatar or portfolio placement blocks deletion. `AssetHold` and the internal `holdAsset()` helper support future authorized business evidence: the owning booking/KYC/support module must authorize its own record and create the hold in the same transaction. There is no client endpoint to invent a hold or attach a file to an arbitrary booking. Referenced/held files cannot be removed or purged. Removed files become inaccessible immediately and unreferenced bytes are cleaned after 24 hours. Abandoned intents expire after an hour. Cleanup uses exact known object keys and retains a database tombstone. Asset/user foreign keys restrict orphan-producing account deletion. Final account erasure, legal retention and evidence release workflows belong to their later phases.

## Portfolio and UI

The API account workspace now includes Media library. Avatar binding, owned library, artist portfolio, renter storefront gallery, captions, transcripts/descriptions, featured items and allowlisted YouTube/Vimeo links persist in PostgreSQL. A link is normalized to an exact approved embed host/video ID; the server never fetches its arbitrary URL, and the external player loads only after Play. Actual uploaded previews use native media controls.

Portfolio mutations use expected revisions, preserve ownership and return edits to private draft. Only a verified provider can submit. Content review requires an administrator with a recent login, a reason and the exact pending revision; self-review is denied. An approved provider profile is additionally required for public media. This is content publication, separate from KYC. A new account has no fake media. Future catalog listings (P05), booking/chat attachments (P10), reviews, verification/support and inspections will bind this storage foundation when those features become live; their old demo UIs are not described as converted here.

The authenticated client also now prevents an old-account 401 from replaying a mutation under a newly signed-in account. Binary uploads use the same account-change guard and do not blindly retry interrupted network writes.

## Validation and references

See `media-validation.json`, `figma-media-mapping.json` and checkpoint screenshots. Real integration covers image re-encoding, MIME/hash mismatches, owner isolation, native bytes, audio/video derivatives, duplicate claims, restart/expired leases/final-attempt recovery, storage failure retry, capability expiry/revocation, public revision withdrawal and held/reference deletion. Browser playback reached an actual 30-second duration. Browser publication approval was not automated; approval mutations were tested through isolated HTTP integration.

Primary implementation references: [AWS SDK v3](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/getting-started-nodejs.html), [S3Mock configuration and limitations](https://github.com/adobe/S3Mock#configuration), [Sharp constructor bounds](https://sharp.pixelplumbing.com/api-constructor/), [Sharp output metadata behavior](https://sharp.pixelplumbing.com/api-output/) and [FFmpeg options](https://ffmpeg.org/ffmpeg-all.html).
