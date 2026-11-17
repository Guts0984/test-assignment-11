# Plan — City courier delivery (test assignment #11)

The assignment (`test-assignment-11.md`) comes first. Where your instructions conflict with it, I follow the
assignment and say so here (see §0.2).

> **Instructions for whoever implements this (any model, any session):**
> - The plan is approved. **Do not stop for review.** Work through §3 block by block until the project is
>   finished, and commit after each block (never push). Don't stop between blocks to ask for confirmation.
> - Before each block, re-read §0, §2 and §4 of this file and the matching part of the assignment.
> - **Tests exist to find bugs, not to fill a coverage number.** See §4. A block isn't done until its tests have
>   been run against the real thing (a real DB, a real HTTP server, a real browser) and they pass. If a test was
>   red and you changed the test instead of the code, explain why in the commit message.
> - **README and every user-visible text in English.** The only other locale is `uk` (Ukrainian, required by
>   the assignment). No Russian anywhere: not in the README, the UI, seed data, error messages or comments.

---

## 0. Ground rules

### 0.1 Rules I follow throughout

| Rule | How I enforce it |
| --- | --- |
| Frontend uses **Feature-Sliced Design** | `apps/web/src/{app,pages,widgets,features,entities,shared}`; `steiger` (the FSD linter) runs in `lint` and CI |
| **Classes only in NestJS** (modules, controllers, services, guards, filters, pipes) | ESLint `no-restricted-syntax: ClassDeclaration/ClassExpression` for `apps/web`, `packages/*` and the stub. Domain logic in `api` is pure functions in `apps/api/src/domain/**`, which also bans classes. Nest classes stay thin and call those functions |
| No `any`, no `@ts-ignore` unless a comment explains it | `@typescript-eslint/no-explicit-any: error`, `ban-ts-comment: allow-with-description`, `strict` + `noUncheckedIndexedAccess` |
| One commit = one finished, tested block | §3. I commit and do not push |
| `.env.example` lists every variable; `api` reads them through Zod | `apps/api/src/config/env.ts`: one `z.object`, parsed once at boot. Defaults only for non-secret values. A missing secret stops boot with a readable error |
| Tests try to break things | A real HTTP server and a real Postgres, run concurrently and with hostile input (§4) |
| No secrets in code | Only `.env`. The local Supabase demo keys go in `.env.example` because they are public defaults of the CLI |

### 0.2 Where your instructions conflict with the assignment (the assignment wins)

| You said | Assignment says | Decision |
| --- | --- | --- |
| Blocks like "nginx, redis" | No Redis, brokers or external services | **No Redis.** Rate limiting runs in the `api` process (§2.6); the job queue and webhook outbox live in Postgres |
| nginx block | Compose = `api`, `web`, stub | **No nginx.** The browser calls `api` directly with CORS, so `api` sees the real client IP and doesn't need to trust `X-Forwarded-For`. That shuts the XFF-spoofing class of bypass. (Can be added later as a separate block if you want it.) |
| Each block ships its own Dockerfile | The database is `supabase start` (CLI containers) | The DB block has no Dockerfile. Its "infra" is `supabase/config.toml`, migrations and seed, which the CLI applies on start. `api`, `web` and `stub` each have a Dockerfile |

---

## 1. Repository layout

```
.
├─ apps/
│  ├─ api/                NestJS + Drizzle, Swagger on /docs, Dockerfile
│  ├─ web/                Next.js 15 App Router, React 19, FSD, PWA for /courier, Dockerfile
│  └─ sender-stub/        tiny functional node:http app: receives webhooks, UI, ok/error/hang switch, Dockerfile
├─ packages/
│  ├─ shared/             Zod schemas, types, pure domain functions (tariff, status machine, money, errors)
│  └─ db/                 Drizzle schema (mirrors SQL migrations), client factory, DB test helpers
├─ supabase/
│  ├─ config.toml         auth (signup disabled, rate limits), storage, realtime, pg_cron
│  ├─ migrations/*.sql    source of truth for the schema, RLS, triggers, cron, bucket
│  └─ seed.sql            3 senders, 2 dispatchers, 30 couriers, 50 000 deliveries / 90 days
├─ e2e/                   Playwright
├─ docker-compose.yml     api, web, sender-stub (joins the Supabase CLI docker network)
├─ .env.example
├─ .github/workflows/ci.yml
├─ plan.md
└─ README.md
```

Tooling: pnpm workspaces + Turborepo, TypeScript 5 strict, ESLint flat config, Prettier, Vitest (workspace),
Playwright, Node 22 LTS in Docker. The Supabase CLI is a root `devDependency`, so `pnpm supabase start` works
without a global install. The README also documents the plain `supabase start` from the assignment.

---

## 2. Architecture and decisions

### 2.1 Who does what

| Concern | `api` (NestJS + Drizzle, direct Postgres connection) | Supabase |
| --- | --- | --- |
| Create, cancel, assign, courier actions, shifts, unblock, reports, tracking, photo upload, webhooks | ✅ transactions + `SELECT … FOR UPDATE` | — |
| Login (email + password) | verifies JWT only (JWKS from GoTrue, HS256 secret as fallback) | ✅ GoTrue, signup **disabled** |
| Role | read from `app_metadata.role` only, never `user_metadata` (users can edit `user_metadata`) | set by seed / admin |
| Reads for the UI | REST endpoints | RLS-protected `select` from the browser is allowed (board/list reads), **never writes** |
| Live updates | — | Realtime `postgres_changes` (RLS-filtered) + Broadcast for tracking |
| Photos | upload through `api` (validates, deterministic path, service role) | private bucket `delivery-photos`, signed URLs |
| Background jobs | webhook worker (needs HTTP and the HMAC secret) | `pg_cron`: 45-min pickup timeout |
| Last line of defence | — | constraints and triggers enforce the status machine, ≤ 8 active, one active assignment, gapless numbers |

**Defence in depth:** `api` does the locking and business checks. The DB *also* rejects illegal states, so a
bug in `api` cannot break an invariant. Both layers get their own tests.

### 2.2 Data model (main tables, schema `public`)

- `profiles(user_id pk → auth.users, role, full_name, phone)`
- `senders(user_id pk, company, webhook_url, webhook_secret)`, `couriers(user_id pk, …)`
- `deliveries(id uuid, number bigint unique, sender_id, status, courier_id null, recipient_name,
  recipient_phone (E.164), address jsonb {city, street, house, apt, note}, zone, weight_g, cod_kop,
  fee_kop, cod_commission_kop, total_kop, attempt_no, next_attempt_at, assigned_at, picked_up_at,
  delivered_at, cod_collected_kop, delivered_shift_id, handover_blocked, wrong_code_streak,
  created_at, updated_at, version)`
- `delivery_secrets(delivery_id pk, recipient_code, tracking_token, tracking_channel)`: separate table so
  couriers **cannot** read the code via RLS. Senders can read their own rows; couriers have no policy
- `delivery_number_counter(id=1, value)`: gapless numbering (§2.4)
- `idempotency_keys(sender_id, key, request_hash, delivery_id, created_at)`, unique `(sender_id, key)`
- `assignments(id, delivery_id, courier_id, assigned_by, assigned_at, ended_at, end_reason)`: partial unique
  index `(delivery_id) where ended_at is null` means one active courier per delivery at the DB level.
  Couriers see their own rows, including ended ones, so Realtime can tell courier B "removed from you"
- `delivery_events(id, delivery_id, type, from_status, to_status, actor_id, actor_role, device_time,
  server_time, payload jsonb)`: the history
- `courier_actions(client_action_id uuid, courier_id, delivery_id, type, device_time, received_at,
  result 'applied'|'rejected', reject_code, reject_message, response jsonb)`, pk `(courier_id, client_action_id)`
- `photos(id uuid client-generated, delivery_id, courier_id, kind 'handover'|'failed', storage_path, sha256,
  size, created_at)`, pk on `id`, so a retry never makes a second file
- `shifts(id, courier_id, opened_at, closed_at, closed_by, expected_cash_kop, handed_cash_kop,
  discrepancy_kop)`, partial unique: one open shift per courier
- `cash_adjustments(shift_id, delivery_id, amount_kop, reason)` for late offline deliveries after the shift closed
- `notifications(id uuid stable, delivery_id, sender_id, seq per delivery, event, payload, status
  'pending'|'delivered', attempts, next_attempt_at, last_error, delivered_at)` = outbox
- `notification_attempts(notification_id, attempted_at, http_status, error, duration_ms, manual)`

### 2.3 Status machine (enforced in `packages/shared` and by a DB trigger)

| From | To | Who | Condition |
| --- | --- | --- | --- |
| — | `created` | sender | create |
| `created` | `assigned` | dispatcher | courier has an open shift, < 8 active |
| `failed_attempt` | `assigned` | dispatcher | `next_attempt_at <= now` (next day, Europe/Kyiv) |
| `assigned` | `assigned` (another courier) | dispatcher | explicit `reassign: true`; plain assign → `ALREADY_ASSIGNED` |
| `assigned` | `created` | system | not picked up within 45 min (`pg_cron`), reason in history |
| `created`, `assigned` | `cancelled` | sender | own delivery, before pickup |
| `assigned` | `picked_up` | assigned courier | |
| `picked_up` | `delivered` | courier | correct code, `cod_collected == cod_kop`, photo |
| `created`/`assigned`/`picked_up`/`failed_attempt` held by someone else | `delivered` | courier who was assigned it and whose assignment was not ended by cancellation | **invariant 8**: offline handover with a correct code always counts |
| `picked_up` | `failed_attempt` | courier | reason + photo; attempt 1–2 |
| `picked_up` | `failed_attempt` → `returning` | courier → system | 3rd failure: two events, two notifications, same transaction |
| `returning` | `returned` | dispatcher | parcel handed back to the sender |

"Active" for the 8-limit means `assigned + picked_up`. Closing a shift is blocked while the courier has
`assigned` or `picked_up` deliveries.

### 2.4 How each invariant is met (and tested)

| # | Mechanism |
| --- | --- |
| 1 Idempotency | One transaction: `INSERT idempotency_keys … ON CONFLICT DO NOTHING`. A concurrent duplicate blocks on the unique index until the first commits, then reads the row. Same `request_hash` (sha256 of canonical JSON) → same delivery (`200`); different hash → `409 IDEMPOTENCY_KEY_REUSED`. Keys are scoped per sender |
| 2 Gapless numbers | `UPDATE delivery_number_counter SET value = value + 1 RETURNING value` inside the creating transaction. A rollback returns the number. Serialises creates, which is fine at this scale. Test: 50 parallel creates, plus some forced to fail midway → still `1..N` with no holes |
| 3 One courier | Lock the delivery row (`FOR UPDATE`) → check status → lock the courier's shift row → check count. Lock order is always delivery → courier (no deadlocks). Backstop: partial unique index on `assignments` |
| 4 ≤ 8 active | Courier row lock serialises assigns to one courier. Backstop: a constraint trigger counts active deliveries under the same lock |
| 5 Cancel vs pickup | Both lock the delivery row; the second sees the new status and is rejected (`ALREADY_PICKED_UP` / `CANCELLED`). Everyone reads the same row, and Realtime emits that one final state |
| 6 Code brute force | Code check under the delivery row lock: if `handover_blocked` → reject without checking; else compare, and on mismatch `wrong_code_streak++`, block at 5. 20 parallel wrong attempts → exactly 5 compared, 15 `HANDOVER_BLOCKED`. The streak resets on success. Constant-time compare |
| 7 Action applied once | `courier_actions` pk `(courier_id, client_action_id)`. Each action runs in its own transaction that inserts the action row first; a duplicate (even a parallel one) waits on the pk and then returns the **stored** result. Batch order follows device sequence |
| 8 Offline handover wins | See the transition table; the action carries its device time. Courier B gets the `assignments` row update (`end_reason = 'delivered_by_other'`) over Realtime and in the next sync response |
| 9 Rejections visible | Stored server-side in `courier_actions` and on the device in IndexedDB. Courier UI lists rejected actions with a translated reason; `GET /courier/actions?result=rejected` restores them after a reinstall |
| 10 Webhooks | §2.5 |
| 11 Cash | `expected = Σ cod_collected_kop` of deliveries with `delivered_shift_id = shift`. Close stores expected, handed and discrepancy in one transaction. A late offline delivery after close goes to `cash_adjustments`, so the report shows it and nothing is lost |
| 12 Permissions | `api` guards (role + ownership in the SQL `WHERE`, so another user's resource returns **404**, not 403, and existence doesn't leak) **and** RLS on every table. Storage policies: select for the sender of the delivery and for dispatchers; no insert/update/delete for `authenticated`. Signed URLs live 5 min |
| 13 Tracking | Token = 128 random bits, base64url (22 chars). Not guessable, and the tracking endpoint is rate-limited per IP. The page gets a projection only: status, attempt, courier first name + last initial, amount due, code, city + street, **no house/apartment, phone masked**. Realtime for tracking = Broadcast from a DB trigger to topic `tracking:<tracking_channel>` (a separate random value) with the same safe projection. `anon` has no RLS access to any table |
| 14 Photos | The device generates a `photo_id`. `PUT /courier/photos/:photoId` is idempotent: path `deliveries/<deliveryId>/<photoId>.jpg`; if the row exists with the same sha256 it returns `200`, if the sha256 differs it returns `409`. Magic bytes checked (JPEG/PNG/WebP), ≤ 5 MB. Actions reference `photo_id`, so the photo is uploaded before the action that uses it |
| 15 4xx not 5xx | Every input goes through Zod (`strict()`, no unknown keys). A global filter maps Zod errors, Postgres `22P02/23505/23514/40P01` etc. to 4xx/409. Uniform error body: `{ error: { code, message, details?, requestId } }`. Fuzz tests (fast-check) hit every route with garbage and assert `status < 500` |

### 2.5 Sender notifications (webhooks)

- A trigger on `delivery_events` inserts a `notifications` row in the **same transaction** as the status change
  (transactional outbox, so changes made by the `pg_cron` jobs notify too). `seq` increases per delivery.
- The `api` worker (interval loop, `FOR UPDATE SKIP LOCKED`, safe with several replicas) picks only the
  **head** of each delivery's queue: the lowest-`seq` pending notification when no earlier one is still
  pending. `delivered` therefore never goes out before `picked_up` has been acknowledged.
- Request: `POST webhook_url`, JSON body, headers `Webhook-Id` (stable notification id),
  `Webhook-Timestamp`, `Webhook-Signature: v1=<hex HMAC-SHA256(secret, id.timestamp.body)>`. 2xx = delivered.
  Timeout 10 s. The `hang` mode of the stub is covered by the timeout.
- Retries: `delay = min(30 s · 2^(attempt−1), 24 h)` ± 20 % jitter. **Decision:** retry indefinitely, with the
  pause capped at 24 h, and never drop. The sender sees attempts in the log and can resend any notification
  manually (same id, logged as manual, does not change ordering).
- SSRF: webhook URLs that resolve to private or loopback ranges are refused, unless the host is in
  `WEBHOOK_ALLOWED_PRIVATE_HOSTS` (default `sender-stub`, so the compose stub works).
- All time comes from an injected `Clock` (`api`), and SQL job functions take `p_now`. Tests move time forward
  instead of sleeping.
- The seed marks historic notifications as `delivered`, so starting up doesn't flood the stub with 150k webhooks.

### 2.6 Rate limiting and abuse resistance (no Redis)

- In-process token buckets (single `api` instance; documented). Keys: **per IP** (socket address,
  `TRUST_PROXY=false` by default) and **per user** (JWT `sub`). Buckets are stored in a bounded LRU, so an
  attacker rotating identities cannot exhaust memory.
- Stricter buckets for sensitive routes: tracking lookup, code verification, delivery creation, photo upload.
- **Fairness:** a global concurrency gate with per-IP fair share. One IP can hold at most N in-flight requests;
  above that it gets `429` immediately, before it takes a DB pool slot. Other clients keep their latency.
- HTTP hardening: body limit 256 KB JSON / 5 MB photo, `headersTimeout`, `requestTimeout`, keep-alive limits
  (slowloris), `statement_timeout` on the pool, `helmet`, CORS allowlist, max batch 100 actions, max page size 100.
- GoTrue: signup off, and its own login rate limits configured in `config.toml`.

### 2.7 Money, tariff, rounding

- Integers in kopecks everywhere (`bigint` in DB, `number` in TS, guarded by `Number.isSafeInteger`).
- `fee = base(zone) + 800 × max(0, ceil(weight_g / 1000) − 1)`; base A 6000, B 8000, C 11000. Weight 1..30 000 g.
- COD commission (only when `cod > 0`) = `max(2000, round_half_up(cod × 2 / 100))`, computed in integers as
  `floor((cod × 2 + 50) / 100)`. **Decision:** round half up to the kopeck. COD limit 0..10 000 000 kop
  (100 000 ₴); documented.
- `total = fee + commission` (paid by the sender); the recipient pays `cod`.
- The web form recalculates the price live by calling `POST /deliveries/quote`, so the server owns the number.
  The shared pure function exists for the server and for tests; the browser shows only server quotes.

### 2.8 Courier PWA (`/courier`)

- Serwist (service worker for Next) precaches the app shell, so it opens offline.
- IndexedDB (`idb`): stores `outbox` (actions with seq, device time, status), `photos` (Blob + sha256),
  `rejected`, `cache` (today's deliveries).
- Sync engine = pure functions (`planSync(state) → steps`, `applyResults(state, results) → state`) plus a thin
  IO shell. Triggers: `online` event, app start, a 15 s interval while pending, and Background Sync where
  supported. Order: upload photos (idempotent PUT) → `POST /courier/actions/batch` → store per-action results.
- Badge: "3 actions waiting", list of rejected ones with reasons. Everything survives reload and reboot
  (IndexedDB, persistent storage requested).
- The code cannot be checked offline (the device never gets it), so a wrong code shows up as a rejection after
  sync. Documented.

### 2.9 Offline conflict table (goes to README, extended while building)

| Offline action | Server state at sync | Result |
| --- | --- | --- |
| Pick up | still assigned to me | applied |
| Pick up | released to queue by the 45-min job, not reassigned | applied (re-assigned to me) if I have < 8 active, else rejected `LIMIT_REACHED` |
| Pick up | reassigned to another courier | rejected `REASSIGNED` |
| Pick up | cancelled | rejected `CANCELLED`, dispatcher sees an incident |
| Deliver, correct code | assigned to someone else / back in queue | **applied** (invariant 8), other courier's assignment ended |
| Deliver, correct code | cancelled | rejected `CANCELLED` (cancel is only possible before a server-known pickup; incident for dispatcher) |
| Deliver | handover blocked | rejected `HANDOVER_BLOCKED`, resend allowed after unblock |
| Deliver, wrong code | any | rejected `WRONG_CODE`, counts toward the 5-streak |
| Deliver, COD mismatch | any | rejected `COD_MISMATCH` (does not count as a code attempt) |
| Failed attempt | reassigned / cancelled / already delivered | rejected with that reason |
| Any action | already applied (same client id) | stored result returned, nothing re-applied |
| Deliver | my shift was closed meanwhile | applied; cash goes to `cash_adjustments` of that shift |

### 2.10 Web (FSD) and UX

- Next `app/` (routing only, thin) at the app root; FSD in `src/`. An empty root `pages/` stops Next from
  treating `src/pages` as the Pages Router.
- Slices, for example: entities `delivery`, `courier`, `shift`, `notification`; features `create-delivery`,
  `cancel-delivery`, `assign-delivery`, `close-shift`, `unblock-handover`, `courier-sync`, `delivery-filters`;
  widgets `dispatch-board`, `delivery-table`, `report`, `tracking-card`, `courier-queue`; pages `sender/*`,
  `dispatcher/*`, `track/[token]`, `courier/*`, `login`.
- Data: TanStack Query; Realtime events invalidate or patch the cache. Browser data goes to `api` (CORS) with
  the user's JWT. Server components don't proxy `api`, so the per-IP rate limit stays meaningful.
- next-intl `uk`/`en` without a locale prefix (cookie), so URLs stay `/courier` and `/track/…`. ICU plurals
  ("3 доставки", "5 доставок"), `Intl.NumberFormat('uk-UA', UAH)` → `1 234,50 ₴`, dates in Europe/Kyiv.
- Forms: React Hook Form + Zod from `packages/shared`, errors under fields, server 4xx `details` mapped to
  fields. Keyboard: focus order, visible focus, Enter submits, a keyboard-operable assign dialog (no drag-only).
- Filters, period and pagination in the URL (`useSearchParams` + `router.push`), so "Back" works.

### 2.11 Performance (board and report < 300 ms on the seed)

Indexes (final list in README): `deliveries(status, zone, next_attempt_at)` partial for the queue,
`(courier_id) where status in ('assigned','picked_up')`, `(sender_id, created_at desc)`,
`(sender_id, recipient_phone)`, `(delivered_at)`, `delivery_events(delivery_id, server_time)`,
`delivery_events(type, server_time)`, `notifications(status, next_attempt_at)`,
`notifications(delivery_id, seq)`. The report is a single SQL aggregate per metric over the period. Tests
assert p95 < 300 ms over 20 runs on the full 50k seed.

---

## 3. Blocks = commits (7)

Each commit is finished on its own: code, migrations or Dockerfile where relevant, tests, the README section,
and CI green at that commit. `git init` happens at commit 1.

### Commit 1: `chore: monorepo foundation + shared domain`
- pnpm + Turborepo, tsconfig base, ESLint (no-any, no-classes-outside-nest, FSD later), Prettier, Vitest workspace.
- `.env.example` with **every** variable for all blocks, each commented (later commits only add to it if
  something unexpected comes up).
- `packages/shared`: Zod schemas (create delivery, quote, courier action batch, filters, errors), status
  machine table + `canTransition()`, tariff + commission, money formatting helpers, error codes.
- Tests: tariff boundary table (1 g, 1000 g, 1001 g, 30 000 g, 30 001 g, every zone), property tests
  (fast-check: fee monotonic in weight, commission ≥ 2000, integer only), exhaustive transition matrix
  8×8×roles, schema fuzz (garbage never throws, only `safeParse` failures).
- CI: install, typecheck, lint, unit tests.

### Commit 2: `feat(db): supabase schema, RLS, jobs, seed`
- `supabase/config.toml`, migrations (types, tables, constraints, indexes, triggers: status guard,
  ≤ 8 backstop, history → outbox, tracking broadcast, `updated_at`/`version`), RLS on every table, storage
  bucket + policies, `pg_cron` job `release_stale_assignments(p_now)`, seed (auth users with bcrypt passwords,
  identities, 50k deliveries / events / shifts, fast `generate_series`).
- `packages/db`: Drizzle schema, client factory, test helpers (create users through the admin API, sign in, get JWT).
- Tests on a real local Supabase:
  - constraints: illegal transitions, a second active assignment, a 9th active, negative money, bad zone → rejected by the DB;
  - RLS matrix: every role × every table × select/insert/update/delete with `anon` and user JWT.
    Another sender's delivery, another courier's list, `delivery_secrets` from a courier, `anon` everything → empty or denied;
  - privilege escalation: `updateUser({ data: { role: 'dispatcher' } })` changes nothing; signup is refused;
  - Realtime: courier B subscribed to `deliveries`/`assignments` gets **nothing** for A's changes (with a positive control);
    `anon` gets nothing from `postgres_changes`; the tracking broadcast payload has no address or phone;
  - Storage: another user's photo → denied; no `authenticated` upload; public URL doesn't work;
  - job: `release_stale_assignments(now() + 46 min)` releases and writes the reason, `+44 min` does not;
  - seed integrity (counts, every status present, numbers gapless) and query performance (board and report p95 < 300 ms).
- CI: `supabase start`, db tests.

### Commit 3: `feat(api): NestJS business API`
- `env.ts` (Zod), Drizzle pool, JWT guard (JWKS + HS256 fallback, `alg` pinned, `exp`/`aud`/`iss` checked),
  roles guard, Zod pipe, error filter, request id, Swagger `/docs`, helmet, CORS, rate limiting and fairness
  gate (§2.6), `Clock` provider, Dockerfile (multi-stage, non-root).
- Modules: deliveries (quote, create, list/search, card, cancel, history, photo signed URLs), dispatch (board,
  assign/reassign, unblock, return), shifts (open, close + cash), courier (today, batch actions, photo upload,
  rejected list), reports, tracking (public).
- Tests (a real server on a random port, a real DB):
  - invariant suites 1–9, 11–15, each a concurrency test (`Promise.all` of 10/20/50 real HTTP requests),
    repeated N times to catch flakiness;
  - **attacker suite:** JWT `alg:none`, wrong signature, expired, another issuer, a role in `user_metadata`;
    IDOR on every `:id` route; mass assignment (`price`, `status`, `sender_id` in the body → 400); SQL
    injection strings in search; `__proto__` / deep nesting / 10 MB body / wrong content type; path traversal
    in photo id; fake image (bad magic bytes); tracking token enumeration;
  - **flood suite:** an attacker on `127.0.0.2` floods (thousands of req/s, plus slowloris sockets) while the
    victim on `127.0.0.3` must keep succeeding with p95 under budget. On Linux the whole `127/8` is local, so
    these are real distinct source IPs without trusting headers. Spoofed `X-Forwarded-For` doesn't change the
    bucket. Many-identity rotation doesn't grow memory past the LRU bound;
  - fuzz: fast-check generated bodies, query and path params for every route → never 5xx, always the uniform error shape.

### Commit 4: `feat(notifications): webhook outbox worker + sender stub`
- Worker (pure planning functions + Nest service shell), HMAC signing, backoff, per-delivery ordering, manual
  resend, attempts log endpoints, SSRF guard.
- `apps/sender-stub`: functional `node:http`, verifies signatures, shows received notifications (list
  page + SSE), switch `ok | error | hang`, Dockerfile.
- Tests: ordering under failures (stub fails `picked_up` 3× → `delivered` waits), stub `hang` → timeout →
  retry, backoff schedule with a fake clock up to the 24 h cap, "down for 10 min then up" with a fake clock →
  all arrive in order, exactly-once-ish (duplicates only with the same `Webhook-Id`), signature verification,
  two worker instances in parallel → no double send, SSRF (`127.0.0.1`, `169.254.169.254`, `db` host) refused.

### Commit 5: `feat(web): sender cabinet, dispatcher, tracking (FSD)`
- Next.js 15 + React 19, `@supabase/ssr` auth, TanStack Query, Realtime hooks, next-intl `uk`/`en`, Tailwind,
  RHF + Zod, steiger, Dockerfile (standalone output).
- Pages: login; sender list (filters in URL), create (live quote), card (history, photos, cancel),
  notifications log + resend, webhook settings; dispatcher board (zones, couriers `5/8`, shift status, live),
  assign with clear refusal messages, unblock, close shift (expected cash → handed → discrepancy), report
  (period in URL); tracking `/track/[token]` (no login, live).
- Tests: Vitest + Testing Library for features (form errors per field, plural/money formatting in both
  locales, URL ↔ filter round trip), an a11y check (axe) on main pages, a **build-output scan for the service
  role key** (fails if it is in any client bundle).

### Commit 6: `feat(courier): offline-first PWA`
- `/courier`: open shift, today's list in order, pick up, deliver (code, cash, photo), failed attempt (reason,
  photo), returning, pending counter, rejected list; 360 px layout.
- Serwist SW, IndexedDB stores, sync engine.
- Tests: sync engine as pure functions (property tests: random interleavings of online/offline/duplicate
  sends/partial failures → every action ends `applied` or `rejected`, never lost, never sent as two different
  ids); IndexedDB persistence across "reload" (`fake-indexeddb` + reopen); photo dedup on retry.

### Commit 7: `chore: docker compose, e2e, README`
- `docker-compose.yml` (api, web, sender-stub on the Supabase network; healthchecks), final `README.md` with
  every section the assignment requires.
- Playwright: (1) create → assign → pick up → deliver → tracking updates by itself; (2) courier offline does
  two actions → back online → both applied; (3) stub down then up → notifications arrive in order; plus the
  acceptance checks that are browser-level (board live update, URL state + Back, reload with a pending queue,
  keyboard-only sender and dispatcher flow).
- CI: build images, `supabase start`, `docker compose up`, run e2e.

---

## 4. Testing philosophy (applies to every block)

- No mocks of Postgres, Supabase, or HTTP in integration tests. Mocks only for time (`Clock`, `p_now`) and in
  pure unit tests.
- Concurrency tests use real parallel connections. Each race test runs many rounds so it fails reliably when
  the lock is missing. I check this by temporarily removing the lock and confirming the test goes red.
- Every invariant from the assignment has at least one named test (`invariant-06 code brute force …`), and the
  README maps invariant → test file.
- Attack tests act like a real malicious user: real sockets, real tokens obtained by login, distinct source IPs.

### 4.1 Test as a suspicious QA engineer, not a coverage generator

The question each test answers is "where is this broken?", not "does this code run?". Rules:

- **Assert outcomes, not calls.** Check the actual DB rows, HTTP status *and* body, the rendered text, the URL,
  and what *another* user sees afterwards. "Returned 200" alone is not an assertion.
- **API tests cover every route**, each with: the happy path; every validation boundary (min, max, ±1, empty,
  wrong type, extra keys, unicode, huge input); every role (no token, wrong role, the right role but another
  owner); every illegal status transition; duplicates and retries; concurrency where state changes; the error
  shape. After a rejected request, verify that **nothing changed** in the DB (no partial writes, no event, no
  notification).
- **E2E tests drive the real UI like a user, through every piece of it:**
  - Login: correct credentials, wrong password, empty fields, each role lands on its own area. A role can't
    open another role's pages by typing the URL. Logout really clears the session (Back after logout doesn't
    show data).
  - Every form: each field's error appears next to that field and goes away once fixed. Submit is blocked while
    invalid, and double-click doesn't double-submit. Server errors show up in the UI. The live quote updates as
    you type and matches the API.
  - Keyboard: the whole sender and dispatcher flow with Tab, Shift+Tab, Enter, Space and Esc only (no mouse).
    Focus is visible and lands somewhere sensible after dialogs open and close. Any shortcut produces exactly
    the result it promises: check the resulting state, not just that something happened.
  - URL state: filters, period and pagination survive reload, and Back/Forward restores the previous state.
  - Realtime: a second browser context (another role) sees the change without reload.
  - i18n: switch `uk` ↔ `en` and check money, dates and plurals (1, 2, 5, 11, 21, 22, 25) in both.
    Check that no raw message keys or untranslated strings show.
  - Courier at 360 px: no horizontal scroll, buttons reachable. Offline (`context.setOffline`) → actions queue →
    reload → queue still there → online → applied once. Rejected actions show their reason.
  - Watch the browser console: any uncaught error or React warning fails the test.
- **Each race test proves it can fail.** While writing it, break the lock or constraint, see the test go red,
  then restore it.
- **When a test finds a bug, fix the code**, keep the test, and add the case to the README invariant → test map
  if it is an invariant.

---

## 5. Things I decided (README "decisions" will list them all)

- Kyiv time (`Europe/Kyiv`) for "today" and "next day".
- The code is 6 digits, fixed per delivery, shown on the tracking page.
- The tracking page shows city + street, never house, apartment or phone (masked `+380 ●● ●●● ●● 67`).
- Cancellation is allowed from `created` and `assigned` only.
- `failed_attempt` puts the parcel back at the depot (no courier); the dispatcher assigns it again the next day.
- `returning → returned` is set by the dispatcher.
- Webhooks retry forever, with the pause capped at 24 h, and are never dropped.
- Senders don't self-register (signup off); users come from the seed.
- Seed passwords: one shared demo password per role, listed in README.

## 6. Resolved questions

1. README language: **English**. UI locales: `en` + `uk` only. No Russian anywhere.
2. nginx / a reverse proxy: **not included** (§0.2).
3. Commits: the 7 blocks of §3.
4. Implementation runs without stopping for review (see the top of this file).
