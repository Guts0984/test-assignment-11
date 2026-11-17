# Courier delivery

City delivery service: senders create deliveries, dispatchers hand them to couriers, couriers work from a
phone (often offline), recipients follow a tracking link and tell the courier a code.

> This README grows block by block. Sections marked _(planned)_ are filled in by later commits.

## Repository layout

| Path               | What                                                                          |
| ------------------ | ----------------------------------------------------------------------------- |
| `apps/api`         | NestJS business API _(planned)_                                               |
| `apps/web`         | Next.js app: sender cabinet, dispatcher, tracking, `/courier` PWA _(planned)_ |
| `apps/sender-stub` | Webhook receiver used in compose and e2e _(planned)_                          |
| `packages/shared`  | Zod schemas, status machine, tariff and money rules, time helpers             |
| `supabase/`        | Config, migrations, RLS, seed _(planned)_                                     |

## Development

```bash
pnpm install
pnpm build        # builds packages/shared (other packages depend on its dist)
pnpm typecheck
pnpm lint
pnpm test
```

Code rules, enforced by ESLint: no `any`, no `@ts-ignore` without a written reason, and no classes outside
NestJS building blocks.

## Money, tariff and rounding

Money is always an integer number of kopecks.

| Part                   | Rule                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base fee               | zone `A` 60 ₴, `B` 80 ₴, `C` 110 ₴                                                                                                                    |
| Weight                 | 1 g – 30 kg. +8 ₴ for every started kilogram above the first: 1000 g costs the base, 1001 g costs base + 8 ₴                                          |
| Cash on delivery (COD) | 0 – 100 000 ₴. Commission = 2 % of the COD amount, minimum 20 ₴. Zero COD has no commission                                                           |
| Rounding               | The commission is rounded **half up to the kopeck**, in integer arithmetic: `floor((cod × 2 + 50) / 100)`. Example: 1000.25 ₴ → 2000.5 kop → 2001 kop |
| Totals                 | `total = fee + commission` is what the sender pays. The recipient separately pays `cod` to the courier                                                |

Only the server computes prices. The sender's form asks the API for a quote on every change.

## Status table

Statuses: `created`, `assigned`, `picked_up`, `delivered`, `failed_attempt`, `returning`, `returned`,
`cancelled`.

| From                  | To               | Who        | Condition                                                             |
| --------------------- | ---------------- | ---------- | --------------------------------------------------------------------- |
| –                     | `created`        | sender     | create                                                                |
| `created`             | `assigned`       | dispatcher | courier has an open shift and fewer than 8 active deliveries          |
| `failed_attempt`      | `assigned`       | dispatcher | not before the next day (Europe/Kyiv midnight)                        |
| `assigned`            | `assigned`       | dispatcher | explicit reassignment to another courier                              |
| `assigned`            | `created`        | system     | not picked up within 45 minutes; the reason is written to the history |
| `created`, `assigned` | `cancelled`      | sender     | own delivery, before pickup                                           |
| `assigned`            | `picked_up`      | courier    | the assigned courier                                                  |
| `picked_up`           | `delivered`      | courier    | correct code, collected cash equals the COD amount                    |
| `picked_up`           | `failed_attempt` | courier    | reason and photo                                                      |
| `failed_attempt`      | `returning`      | system     | after the 3rd failed attempt (in the same transaction)                |
| `returning`           | `returned`       | dispatcher | parcel handed back to the sender                                      |

An offline handover with the correct code is also accepted from `created`, `assigned` and `failed_attempt`
(see the offline conflict table, planned). Terminal statuses: `delivered`, `returned`, `cancelled`.

"Active" for the 8-delivery limit means `assigned` + `picked_up`.

## Decisions

- "Today" and "next day" use the `Europe/Kyiv` time zone, including across daylight-saving changes.
- Webhook retry pauses double from 30 s up to 24 h and then repeat every 24 h; notifications are never dropped.
- Phone numbers are normalised to E.164; local Ukrainian forms (`0671234567`, `380…`) are accepted.
- API error codes live in `packages/shared/src/errors.ts` and are the only place that maps a code to an HTTP status.
