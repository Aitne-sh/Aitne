---
schema_version: 1
slug: guides/import-knowledge-file
title: Import a Knowledge File
id: import-knowledge-file
aliases:
  - import history
  - import chatgpt
  - import gemini
  - knowledge import
category: guides
summary: |
  Upload a Markdown or text file of personal facts so the agent folds
  it into your user/*.md Context Files. Includes step-by-step recipes
  for exporting your existing profile out of ChatGPT and Gemini.
section: import-knowledge-file
tags:
  - guide
  - knowledge
  - import
  - chatgpt
  - gemini
  - memory
status: stable
ask_examples:
  - How do I upload a profile file from ChatGPT?
  - How do I export my Gemini conversation history?
  - How do I bring facts from another AI into Aitne?
  - What format does the Knowledge upload accept?
locale: en-US
created: 2026-04-28
updated: 2026-04-28
ui_anchors:
  - /knowledge
keywords:
  - import
  - chatgpt history
  - gemini history
  - json import
  - knowledge
related:
  - concepts/memory-model
  - features/memory-files/user-profile
  - getting-started/04-first-day
---

# Import a Knowledge File

## Goal

Bring a single Markdown (`.md`, `.markdown`) or plain-text (`.txt`)
file you wrote elsewhere — a hand-written profile, an Obsidian or
Notion export, or a summary you produced in ChatGPT / Gemini — into
Aitne's `user/*.md` Context Files. The agent reads the file once and
appends each fact verbatim into the right topic file. Existing bullets
are never overwritten; identity-class facts are deferred for your
explicit confirmation.

## Prerequisites

- Initial setup is complete (`policies/management.md` saved). Pre-setup
  imports are rejected with `409 setup_incomplete` because the
  `user/*.md` skeleton has not been seeded yet.
- At least one backend (Claude, Codex, or Gemini CLI) is authenticated
  with a CLI binary on `PATH`.
- The file is at most **64 KB after UTF-8 encoding** (Japanese / non-
  ASCII characters take 3 bytes each — ≈ 21 K Japanese characters).
- The file does not contain private keys, API tokens, or credentials.
  The route rejects these at upload time and never persists them.

## Where the facts land

| Class of fact | Target Context File |
|---|---|
| Identity (legal name, primary timezone, primary language, DOB, primary email/phone) | **Deferred for confirmation** — surfaced in the closing journal entry; never auto-written. |
| Relationships (family, partners, close friends) | `identity/people.md` |
| Work, employer, role, colleagues | `identity/work.md` |
| Skills, expertise, languages spoken | `identity/expertise.md` |
| Lifestyle, hobbies, preferences, health | `identity/personal.md` |
| Goals, aspirations, current focus | `identity/goals.md` |
| Anything else | `identity/profile.md` under `## Misc` |

Conflicts (a source bullet that contradicts an existing bullet) land in
a `## Pending Conflicts` section on the affected file with the upload
date inline, so you can resolve them later without losing data.

## Steps — uploading the file

1. Open `/knowledge?tab=upload` (Knowledge → Upload tab).
2. Click **Choose file** and select your `.md` / `.markdown` / `.txt`
   file.
3. Pick the **Source** that matches where the file came from
   (`Wrote it myself`, `Exported from Obsidian`, `Exported from
   Notion`, or `Other`). The label is recorded in the journal entry
   the import session writes when it finishes.
4. Pick the **Execution agent**. The dropdown lists only backends that
   are enabled, authenticated, have their CLI binary on `PATH`, and
   have at least one model available. Pick `Use default routing` to
   let the daemon's main backend run it.
5. Click **Import**. The form returns immediately with a 202 + trace id
   — the heavy-tier session runs in the background.
6. Watch progress under the linked **Activity** view (filtered by the
   trace id) and review the resulting bullets under
   `/knowledge?tab=context-files` once the run finishes.

## Verification

- A `knowledge_import_started` row appears in the Activity feed within
  a second of clicking Import.
- A `knowledge.import` row with a cost / duration follows once the
  session completes (typically 30 s to 2 min depending on file size
  and backend).
- The agent appends a single `## YYYY-MM-DD knowledge import` block to
  `journal/agent.md` summarising the run — counts of facts written /
  skipped, pending conflicts, and identity-class facts awaiting
  confirmation.
- Open each affected `user/*.md` file under Context Files. New bullets
  should be verbatim copies of lines in your source file.

## If It Fails

- **`415 unsupported_extension`** — the file is not `.md`,
  `.markdown`, or `.txt`. Convert PDFs / DOCX / HTML to plain
  Markdown first.
- **`413 file_too_large`** — exceed 64 KB. Split the file into
  smaller chunks and upload each separately.
- **`400 secret_shape_detected`** — the route found content shaped
  like a private key or token. Remove the offending lines and re-
  upload.
- **`409 setup_incomplete`** — finish the setup wizard first
  (`/setup`).
- **`No authenticated backends`** in the Execution agent dropdown —
  set up a backend under Connections → Backends, then return.

---

# Recipe: Export your profile from ChatGPT

OpenAI does not ship a one-click "export as Markdown" button, but the
following two paths produce a file that uploads cleanly.

## Recommended: ask ChatGPT to write it for you (≈ 2 min)

Works against ChatGPT's *Memory* feature — the model already holds a
list of personal facts about you. This procedure asks it to dump them
in the exact format the upload expects.

1. Open <https://chatgpt.com> and start a **new conversation**. (Use
   a model with Memory enabled — GPT-4o, GPT-5, etc.)
2. Send the prompt below verbatim:

   ```
   Output a Markdown summary of every personal fact you know about me
   from our past conversations and from your saved memory.

   Use only these H2 headings, in this order:

   ## Identity
   ## People
   ## Work
   ## Expertise
   ## Personal
   ## Goals
   ## Misc

   Rules:
   - One bullet per fact, prefixed with "- ".
   - Verbatim and concise. Do not paraphrase or embellish.
   - Skip any fact you are not certain about.
   - Do not invent or infer beyond what I explicitly told you.
   - Omit any credentials, API keys, passwords, or tokens.
   - If a section has no facts, keep the heading and leave the body empty.

   Output only the Markdown. No preamble, no explanation, no closing
   remarks.
   ```

3. Copy the entire response (no surrounding ChatGPT chrome) into a new
   file `chatgpt-profile.md`.
4. Skim the file before upload. Delete any line you don't want
   imported — the upload writes facts verbatim.
5. Upload via Knowledge → Upload, with **Source** = `Other`.

## Comprehensive: official Data Export → convert (≈ 30 min, large)

Use this when you want to seed Aitne with the *complete* history.
Output is bulky and requires manual filtering.

1. In ChatGPT, click your account avatar → **Settings** → **Data
   controls** → **Export data** → **Export**. Confirm via the email
   OpenAI sends; the email's download link expires after 24 h.
2. Download the resulting `.zip` (typically 1–50 MB) and unzip. Key
   files inside:
   - `conversations.json` — every chat as JSON, turn-by-turn.
   - `chat.html` — a browseable HTML view.
   - `user.json`, `message_feedback.json`, `model_comparisons.json` —
     metadata, not useful for import.
3. The export is JSON, not Markdown. Convert it manually: open
   `chat.html` in a browser, search/skim for personal facts, paste
   them into a new `chatgpt-export.md` under the same H2 headings as
   above. Discard verbose model responses and code snippets — only
   keep facts *you* told ChatGPT.
4. Cap the result at 64 KB. If larger, split into multiple files and
   upload one at a time.
5. Upload via Knowledge → Upload, with **Source** = `Other`.

## Bonus: copy your saved memory list

ChatGPT's Memory page exposes the structured fact list directly.

1. **Settings** → **Personalization** → **Memory** → **Manage**.
2. The list shows each saved memory as a separate row.
3. Copy the rows into a new file under `## Misc` (or split into the
   right H2 headings yourself), one bullet per row.
4. Upload as `chatgpt-memory.md`.

---

# Recipe: Export your profile from Gemini

Google Gemini's options mirror ChatGPT's at a high level — no native
Markdown export, but the in-conversation prompt method works the same
way, and Google Takeout produces a comprehensive archive.

## Recommended: ask Gemini to write it for you (≈ 2 min)

1. Open <https://gemini.google.com> and start a **new conversation**.
   The model uses **Saved info** (the Gemini equivalent of ChatGPT's
   Memory) plus past-conversation context if you have it enabled
   (Settings → **Activity** → conversations are saved).
2. Send the same prompt as the ChatGPT recipe — it works as written
   against Gemini.
3. Copy the response into `gemini-profile.md`, skim, and upload via
   Knowledge → Upload with **Source** = `Other`.

## Comprehensive: Google Takeout (≈ 1 hr, archive may take longer)

1. Visit <https://takeout.google.com>.
2. **Deselect all**, then check **Gemini Apps Activity** (and
   optionally **My Activity** for older Bard / Gemini sessions).
3. Click **Next step**, choose `.zip` and a delivery method, then
   **Create export**. Google emails a download link when the archive
   is ready (minutes to hours depending on volume).
4. Unzip the archive. Inside `Gemini Apps Activity/`, look for
   `MyActivity.html` (browseable) and `MyActivity.json` (structured).
5. Same conversion procedure as the ChatGPT comprehensive recipe:
   open the HTML, harvest the personal facts you told Gemini, paste
   them under the right H2 headings, save as `gemini-export.md`,
   keep under 64 KB, upload.

## Bonus: copy your Saved info list

1. Open Gemini → click your avatar / settings → **Saved info**.
2. Copy each saved row into a new `gemini-saved-info.md` under the
   right H2 heading, one bullet per row.
3. Upload as above.

---

## Tips that apply to both services

- **One round per topic file.** If your file has a lot of work facts
  but few personal facts, you can upload a "work-only" file first,
  verify the result in Context Files, then upload a separate file
  for personal facts. This is easier to review than one large mixed
  upload.
- **Edit before you upload.** The agent writes verbatim. Anything in
  the file *will* land in `user/*.md` (after dedup and identity-class
  deferral). Trim aggressively.
- **Identity is special.** Even if your file says
  `- Name: <Your Name>`, the agent will *not* write it to
  `identity/profile.md`. It surfaces in the journal entry instead, where
  you can confirm and accept it via the dashboard.
- **Conflicts are flagged, not merged.** If your file contradicts an
  existing bullet, the agent appends the new bullet to a
  `## Pending Conflicts` section on the same file rather than
  overwriting. Reconcile manually under Context Files.
- **Multiple uploads are fine.** Each session is independent, so you
  can run the same recipe against ChatGPT and Gemini and upload both
  files. Duplicate facts are skipped on the second run.

## Related

- [Memory Model](../concepts/memory-model.md)
- [user/profile.md](../features/memory-files/user-profile.md)
- [First Day](../getting-started/04-first-day.md)
