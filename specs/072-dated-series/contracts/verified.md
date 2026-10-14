# Verified against the real Postgres

**Feature**: `072-dated-series` | **Date**: 2026-10-14

The SQL this plan depends on was **run**, not reasoned about (constitution II), against the project's
own Postgres (`docker-compose.yml`'s `docket-pg`, port 5555, user `docket`). The probe schema was
created, exercised and dropped; nothing in the application schema was touched.

## 1. The expressions the claim predicate needs

```sql
select ('2027-03-14'::date - 3::smallint),
       (('2027-03-14 23:30:00+00'::timestamptz) at time zone 'Pacific/Auckland')::date,
       (case 2 when 2 then 29 when 4 then 30 else 31 end),
       (2028 % 4 = 0 and (2028 % 100 <> 0 or 2028 % 400 = 0)),
       (2100 % 4 = 0 and (2100 % 100 <> 0 or 2100 % 400 = 0));
```

| Expression | Result | What it proves |
|---|---|---|
| `date - smallint` | `2027-03-11` | `next_target_date - s.lead_days` is valid with `lead_days smallint`; no cast is needed in the claim ([worker.md](./worker.md) § 2) |
| `(timestamptz at time zone 'Pacific/Auckland')::date` | `2027-03-15` | the project's **local** date, correctly already the 15th in Auckland at 23:30 UTC on the 14th — the whole basis of **B4** |
| the month/day `CASE` | `29` for February | **B19**'s day cap allows `02-29` and refuses `02-30` |
| the leap expression | `t` for 2028, `f` for 2100 | **B19**'s year-specific `02-29` gate is the full Gregorian rule, not `% 4` |

## 2. The row table's constraints

The DDL in [../data-model.md](../data-model.md) § 3 — the five CHECKs and the identity unique index —
was created verbatim and exercised:

| Insert | Result |
|---|---|
| `03-14` / `Ada Lovelace`, no year | accepted |
| `2027-03-14` / `Ada Lovelace` | accepted — `coalesce(year, 0)` keeps an every-year row distinct from a year-specific one (**B18**) |
| `02-29`, no year | accepted (valid in leap years) |
| `2028-02-29` | accepted |
| `02-30` | refused — the day CHECK |
| `13-01` | refused — the month CHECK |
| `04-31` | refused — the day CHECK |
| `2027-02-29` | refused — the leap CHECK |
| key value `"  "` | refused — the non-blank key CHECK |
| `03-14` / `" ada lovelace "` against the stored `"Ada Lovelace"` | refused — **duplicate key on the identity index**, i.e. A10's case-insensitive, trimmed identity enforced by the database and not by a service |

So FR-012, FR-023's impossible-date and empty-key cases, and A10's identity rule are each a database
fact in this design, provable by the inserts above, before any validator runs.

## 3. Not verified here

- `ALTER TYPE … ADD VALUE` for `'date'` and `'missed'` — the existing migrations already use this
  pattern; the plan requires each in its own statement, unused in the same transaction.
- Drizzle's generation of these CHECKs and the expression index — `pnpm db:generate` followed by a
  clean `pnpm db:check` is a task, not an assumption.
- Everything behavioural (firing, missing, idempotency, the queue floor) is covered by the runnable
  checks in [../quickstart.md](../quickstart.md) and is **not** claimed to work until those run.
