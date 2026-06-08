---
schema_version: 1
slug: getting-started/04-first-day
title: Your First Day
id: first-day
category: getting-started
summary: |
  Turn the freshly-installed agent into one that actually helps you —
  teach it about you, connect the tools you use, and describe the work
  you want it to do.
aliases:
  - first day
  - onboarding day 1
  - day one
  - day zero
section: getting-started
tags:
  - core
  - getting-started
  - setup
  - integrations
  - routines
  - memory
status: stable
keywords:
  - first day
  - onboarding
  - import history
  - chatgpt import
  - integrations
  - profile
  - teach the agent
ask_examples:
  - What should I do on my first day?
  - How do I make the agent useful?
  - How do I tell the agent about myself?
  - Can I import my history from ChatGPT?
  - How do I connect an app that isn't on the integrations list?
  - Can I teach the agent a multi-step morning task?
locale: en-US
ui_anchors:
  - /knowledge?tab=upload
  - /knowledge?tab=context-files
  - /connections
  - /connections/mcp
  - /settings/routines
  - /activity
context_files:
  - identity/profile.md
  - state/today.md
  - journal/agent.md
api_endpoints:
  - POST /api/knowledge/import
created: 2026-04-25
updated: 2026-06-07
related:
  - getting-started/02-first-steps
  - getting-started/03-what-can-this-do
  - guides/setup-wizard
  - guides/import-knowledge-file
  - features/routines/morning-routine
  - features/routines/custom-routines
  - features/memory-files/user-profile
  - concepts/delegated-mode
  - concepts/skills
---

# Your First Day

## Goal

Get the agent past cold start. Right after setup it knows almost
nothing about you, sees none of the tools you actually use, and has
no idea what work you want it to do for you. Day one is when you
fix all three.

## Prerequisites

- Setup wizard complete (`/setup`).
- At least one messaging app paired and a DM exchanged.

## The shape of day one

Three things make the difference between an agent that produces a
sparse skeleton and one that actively helps you:

1. **Teach it about you** — who you are, what matters, how to talk
   to you.
2. **Connect the tools you live in** — mail, calendar, notes, the
   apps you check every day.
3. **Show it the work you want done** — described in plain English,
   then promoted to a routine once it works.

Walk down the page in that order. Each step compounds — the agent's
output on step 3 is only as good as how much you put in on steps 1
and 2.

---

## 1. Teach the agent about you

The agent reads
[`identity/profile.md`](../features/memory-files/user-profile.md) and
the rest of the `identity/*.md` Context Files at the start of every
session. The faster those files have real content, the faster every
reply gets useful.

### Quickest path: just DM it

Send 3–5 DMs that read like introductions to a new assistant:

- *"My name is X. I lead Y at Z. I'm currently focused on A and B."*
- *"I work in Asia/Tokyo and I sleep between 1am and 9am — never
  ping me there."*
- *"My partner is K, my closest collaborators are M and N — when you
  see them on my calendar, treat the meeting as 1:1."*
- *"I prefer terse replies in English. Don't summarize what I just
  said back to me."*

The agent appends each fact to the right `identity/*.md` file (work
facts → `identity/work.md`, people → `identity/people.md`, preferences →
`identity/personal.md`, and so on). Identity-class facts (legal name,
primary timezone) are deferred for your explicit confirmation
rather than auto-written.

### Bootstrap from ChatGPT, Gemini, or anywhere else

If you've been using ChatGPT or Gemini for a while, those services
already hold a profile of you. Ask them to dump it as Markdown and
upload the file under **Knowledge → Upload**.

The full recipes — the exact prompt to paste into ChatGPT, the
Google Takeout path for a comprehensive history, the format the
upload accepts — live in
[Import a Knowledge File](../guides/import-knowledge-file.md).

You can run the recipe more than once: a small "work facts only"
file first, verify the result under **Knowledge → Context Files**,
then a separate file for personal facts. Duplicate facts on the
second upload are skipped automatically.

### Verify what landed

Open **Knowledge → Context Files** and skim each `identity/*.md` file.
If a bullet is wrong, edit it directly — the agent reads your edit
on its next turn. The journal entry the import session writes
(`journal/agent.md`) lists everything that was deferred or flagged
as a conflict.

→ [identity/profile.md](../features/memory-files/user-profile.md) ·
[Memory Model](../concepts/memory-model.md)

---

## 2. Connect the tools you actually use

The agent only knows about apps you've connected. There are three
ways in.

### Built-in integrations

Open **Connections** and connect the ones you live in:

| Integration | What it gives the agent |
|---|---|
| [Mail](../features/integrations/mail.md) | Reads and locally searches your inbox (Gmail, Outlook, Yahoo, iCloud, IMAP). Auto-files reading lists, receipts, travel bookings. |
| [Calendar](../features/integrations/calendar.md) | Sees today's and upcoming events. Pre-meeting nudges. |
| [Obsidian](../features/integrations/obsidian.md) | Watches a vault for new notes — references them in the morning plan. |
| [Notion](../features/integrations/notion.md) | Watches selected pages and databases for changes. |
| [Git](../features/integrations/git.md) / [GitHub](../features/integrations/github.md) | Watches local repos and tracked GitHub repos. |

Connect only what you use. Empty integrations are noise — skipping
ones you don't need is the right default.

### Anything else: connectors and MCP

If your important app isn't in the list above — Linear, Asana, a
private CRM, Google Drive, your bank's CSV exporter, anything —
you have two ways to wire it in without waiting for first-party
support.

- **Backend connectors.** Sign into a connector that ships with your
  backend (claude.ai for Claude, ChatGPT for Codex, Google for
  Gemini) and let the agent reach the service through the backend's
  native MCP tools. Same-backend calls go directly to the connector;
  cross-backend calls proxy through the daemon. Flip a built-in
  integration to **delegated** mode under **Connections → Mail /
  Calendar** to use a connector instead of the daemon's own
  credentials. Background:
  [Delegated Mode](../concepts/delegated-mode.md).
- **Custom MCP servers.** Anything that ships an MCP server (and the
  catalog is exploding — Drive, Slack, Linear, Figma, Notion, Jira,
  even your own scripts) can be attached under **Connections →
  MCP**. Once attached, every backend that supports MCP can call its
  tools as if they were built in.

Picking between them: prefer a built-in if it exists, then a
connector if your backend already ships one, then a custom MCP
server.

→ [Skills and MCP](../concepts/skills.md) ·
[Delegated Mode](../concepts/delegated-mode.md)

---

## 3. Describe the work you want done

You don't have to write any code. The fastest way to teach the
agent a new task is to DM it the task in plain English. If the
result is good, ask it to keep doing this on a schedule and you
have a routine.

### Start with one-off requests

DM the agent things you'd send to a competent assistant:

- *"Pull the last week of my Gmail and tell me which threads I owe a
  reply on."*
- *"For tomorrow's meeting with Acme, summarize what we last
  discussed (search my Notion + my Obsidian vault) and any news from
  Acme in the last month."*
- *"Read today's Drive files in
  drive.google.com/drive/folders/<id> and give me a 90-second
  speaker outline for the afternoon presentation."*

The agent will either do it or tell you what's missing — a
connection it needs, a credential, a file it can't reach. Either
way you've just learned what to fix next.

### Promote a working request to a routine

Once a request gives you a result you like, two paths make it
recurring:

- **Scheduled DMs** — *"Every weekday at 9:30 PT, do exactly that
  and message me on WhatsApp."* The agent stores a recurring
  schedule and runs the same prompt at the same cron. Best for
  per-channel reminders and small recurring asks.
- **Custom routines** — heavier, multi-step jobs that should write
  to Markdown memory and DM you with a summary. Add one under
  **Settings → Routines → Add custom routine**, or DM the agent the
  cron + steps and ask it to save the routine. See
  [Custom Routines](../features/routines/custom-routines.md) and
  [Add a Custom Routine](../guides/add-a-custom-routine.md).

### A worked example: a richer morning routine

Suppose you want a morning routine that, every weekday at 7am:

1. Creates a Notion daily-note for today's date and seeds it with a
   TODO list pulled from your open tasks.
2. For every meeting on today's calendar, researches the attendee's
   company online and writes a one-paragraph brief into the same
   Notion note.
3. DMs the brief list to you on WhatsApp.
4. Looks at the Drive folder you keep today's deck in, reads the
   slides, and drafts speaker notes — saved under a `## Speaker
   notes` heading in the same Notion daily note.

Shortest path from zero to that:

1. **Run each step as a one-off DM first.** "Create a Notion page
   for today named …" / "List today's calendar events and research
   each company …" / "Read the slides at … and draft speaker
   notes." This makes the gaps obvious — Notion not connected?
   Calendar not connected? WhatsApp not paired? Drive not reachable
   through a connector or MCP server? Fix them as they show up.
2. **Once each piece works standalone**, open **Settings → Routines
   → Add custom routine**:
   - Slug: `morning-deep-prep`
   - Cron: `0 7 * * 1-5`
   - Backend tier: `high (opus)` — this is a heavy, multi-tool job
   - Max budget (USD): `0.20` (a generous per-execute override; the
     form default is `0.05`)
   - Description: paste the four numbered steps above verbatim.
3. **Watch the next firing in Agent Log** and iterate. The vault file
   at `~/.personal-agent/context/policies/routines/custom/morning-deep-prep.md`
   is a plain Markdown file: edit the `## Checks` body to refine the
   step wording, or the `cron:` field in the YAML frontmatter to
   change the schedule. The watcher picks up changes without a
   restart.

→ [Custom Routines](../features/routines/custom-routines.md) ·
[Add a Custom Routine](../guides/add-a-custom-routine.md)

---

## Verification

By end of day one you should have:

- At least 5–10 facts in `identity/*.md` (DM and/or upload).
- Two or more **Connections** connected and showing recent polls in
  **Activity**.
- One DM whose answer references something only your connected
  apps could have told the agent.
- (Stretch) one custom routine or recurring schedule in **Settings
  → Routines** that you'd be sad to lose.

## If it fails

- Replies never reference anything specific to you → `identity/*.md` is
  still mostly empty. DM more, or run a Knowledge upload.
- A connected integration shows no observations after an hour →
  [Observation Not Detected](../troubleshooting/observation-not-detected.md).
- A blank `state/today.md` after the morning routine →
  [Morning Routine Didn't Run](../troubleshooting/morning-routine-didnt-run.md).
- A Knowledge upload returns `409 setup_incomplete` → finish the
  setup wizard at `/setup` first.

## Related

- [Import a Knowledge File](../guides/import-knowledge-file.md)
- [Morning Routine](../features/routines/morning-routine.md)
- [Custom Routines](../features/routines/custom-routines.md)
- [Add a Custom Routine](../guides/add-a-custom-routine.md)
- [Delegated Mode](../concepts/delegated-mode.md)
- [Skills and MCP](../concepts/skills.md)
- [identity/profile.md](../features/memory-files/user-profile.md)
