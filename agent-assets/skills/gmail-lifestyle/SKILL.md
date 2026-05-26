---
name: gmail-lifestyle
description: Load when the user mentions receipts / expenses / flights / hotels / trains / a booking — Gmail-observer-derived travel bookings and receipt save-to-external-vault both live here.
allowed-tools:
  - Bash(curl *)
  - Read
---

# Gmail Lifestyle — travel bookings, receipts

This skill merges two closely-related surfaces that both depend on
data the daemon's **Gmail observer** has scanned: travel bookings and
receipt attachments saved into the user's external Obsidian vault.

It is conditionally loaded — see the manifest predicate
`gmailLifestyleActive(db)` / `gmailLifestyleActiveForDm(db, msg)`
in `packages/daemon/src/core/skills-manifest.ts`. Routines load it
when there is fresh-or-pending data; DM events also load it on
trigger phrases (`receipt`, `expense`, `flight`, `train`, plus the
user's primary-language equivalents — the predicate handles both the
structured triggers and the message-text triggers).

Output language: Policy C for user-facing summaries — see
`<output_language_policy>`. Path patterns and external API field
names stay verbatim.

---

## Travel bookings

The daemon's Gmail observer detects booking confirmation emails from
airlines, hotels, OTAs, restaurant reservation platforms, and rail
services. Data is stored in the `travel_bookings` SQLite table.

### When to use

- **Morning routine** — surface upcoming travel / bookings within the
  next 7 days inside today.md `## Travel & Reservations`.
- **Evening review** — report newly detected bookings (today's
  `createdAt`).
- **User asks about trips / reservations** — query bookings and
  summarize.
- **Pre-trip reminders** — surface upcoming travel the day before
  departure.

### Workflow

1. Fetch upcoming bookings from `/api/travel-bookings/upcoming`.
2. For morning routine, highlight bookings within the next 7 days.
3. For evening review, check for newly detected bookings (today's
   `createdAt`).

### API

Full `/api/travel-bookings` reference (GET filter + upcoming +
PATCH status) is in the dedicated reference below.

{{> ref:travel-bookings-api }}

### Formatting

Morning routine — today.md:

```
## Travel & Reservations
Upcoming flight: United to SFO (May 15) — confirmation ABC123
Hotel: Marriott SF (May 15-17) — confirmation XYZ789
Restaurant: OpenTable reservation tonight 19:00
```

Omit the section when no upcoming bookings within 7 days.

Evening review:

```
## New Bookings Detected
- United flight: May 15, confirmation ABC123, $350
```

Booking type display names: flight → Flight, hotel → Hotel,
restaurant → Restaurant, train → Train, bus → Bus, other →
Reservation.

---

## Receipts

The daemon's Gmail observer scans travel-booking emails for PDF /
image attachments and can retain previously detected generic
documents. Attachment metadata is stored in the `receipts` SQLite
table. Actual files are downloaded on demand and can be saved to the
user's **external Obsidian vault**.

### Primary vault vs external vault — read first

> **WARNING — do not confuse vaults.** Receipts save into the
> **external** Obsidian vault (user's personal knowledge base reached
> via `/api/obsidian/*`), **not** the primary management store
> reached via `/api/context/*`. The agent's own state files
> (`state/today.md`, `plans/roadmap.md`, `projects/*`, `user/*`, `rules/*`,
> `routines/*`, `agent/*`) live in the primary store and must
> **never** receive receipt attachments. See the
> `external-services` skill's obsidian reference for the external
> vault's full CRUD surface.

`receipts.obsidianPath` is a path **inside the external vault**.

### When to use

- **User asks about receipts** — list detected receipts, check save
  status.
- **Tax preparation season** — generate annual receipt list, save
  unsaved receipts.
- **Monthly / yearly review** — report on receipt-collection
  completeness.

### Workflow

1. Fetch the receipt list from `/api/receipts`.
2. To save a receipt to the external Obsidian vault:
   a. Download via `POST /api/receipts/:id/download` (binary stream).
   b. Save to the vault via `POST /api/obsidian/notes` (see the
      `external-services` obsidian reference for path conventions).
   c. Update the receipt record with the vault-relative path via
      `PATCH /api/receipts/:id` `{"obsidianPath": "..."}`.
3. For tax preparation, filter by date range and category.

### API

Full `/api/receipts` reference (GET filter + summary + download +
PATCH) plus the external-vault save convention
(`receipts/YYYY/MM/<merchant>-<date>.<ext>`) is in the dedicated
reference below.

{{> ref:receipts-api }}

---

## When NOT to act

- If the predicate gates above are false (no fresh bookings, no
  unsaved receipts, no trigger phrase), this skill is not loaded —
  the manifest layer handles that decision. If you see this body
  anyway, it means the predicate matched something concrete; do not
  guess that the user wants travel / commute / receipt work without
  evidence in the conversation or the DB.
- Do not write receipts to `/api/context/*` — that targets the
  primary management vault. See the §"Primary vault vs external
  vault" warning above.
- Bulk receipt operations (save-all, reclassify-all) need explicit
  user confirmation; surface the count and criteria first.
