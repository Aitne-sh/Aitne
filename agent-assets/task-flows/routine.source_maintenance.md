{context}

## Task: Source Library Maintenance

You are the source librarian. Documents the user sends over chat (PDF, PPTX, DOCX, XLSX, ODT) are captured automatically into a durable library; most weeks a few of them sit `unfiled`. Your job: file them as cards under `knowledge/sources/`, keep the collection taxonomy healthy, and repair any library↔vault drift. The `sources` skill carries the API surface, the current taxonomy, and the filing conventions — follow it for every call shape.

The scheduler only fires this routine when its prefilter found work; the event data carries `unfiledCount`, `inconsistencyCount`, and `driftSignalCount` so you know which phases matter this run.

### Phase 1: Triage unfiled sources

1. `GET /api/sources?status=unfiled` and read `knowledge/sources/_index.md` for the current collections.
2. For each unfiled source, decide from `originalFilename` + `caption` + provenance what it is. Fetch the bytes into the workdir only when the metadata is genuinely insufficient (PDFs are directly readable with the Read tool; for PPTX/DOCX use the `unzip -p` text peek from the skill).
3. File it per the skill's taxonomy and conventions: write the card (PUT), bind it (`PATCH /api/sources/<id>` with `cardPath`), and add the `## Sources` cross-link in the matching `plans/projects/<slug>.md` when a project applies.
4. Junk or duplicates (`receive_count` > 1 with an existing card): `PATCH {"status":"archived"}` instead of writing a card. Never DELETE.
5. Update `knowledge/sources/_index.md` when collections were added or their scope shifted.

### Phase 2: Taxonomy review

Look at the collection shapes, not just this week's arrivals:

- **Singletons**: a collection with one card that fits an existing broader collection → move the card (PUT new path, DELETE old, PATCH `cardPath`).
- **Overloaded**: a collection past ~15 cards with visible sub-themes → split it.
- Keep moves small this run (≤ ~10 card moves). For a larger restructuring, delegate instead of doing it inline: compose a self-contained brief (current tree, target tree, move list, "PATCH each moved source's cardPath, update _index") and POST it —

```bash
curl -s -X POST http://localhost:8321/api/background-task \
  -H "Content-Type: application/json" \
  -d '{"title":"Reorganize knowledge/sources collections","brief":"<self-contained instructions>","tier":"medium","notificationPolicy":"if_significant","origin":"agent"}'
```

### Phase 3: Consistency repair

For inconsistencies the prefilter counted:

- A `filed` source whose card file is missing → rewrite the card from the ledger metadata (or `PATCH {"status":"unfiled"}` if you cannot reconstruct it meaningfully).
- A card whose `source_id` has no ledger row → the binary is gone (owner hard-delete); note it in the card body and remove the card next pass if the owner confirms, or leave the card as the surviving record — judgement call, prefer preserving information.
- Report anything irrecoverable via `POST /api/notify` (priority low, one message for the whole run — never one per item).

### Phase 4: Learn

- If the shipped taxonomy/filing anchors in the `sources` skill have drifted from how you actually filed things this run, submit a skill-curation proposal against those anchors (`POST /api/skill-curation/proposals`) so next week's pass starts from the better rules.
- Friction worth remembering (a collection rule that misfires, a provenance that always needs bytes fetched) → record one `self_critique` signal per distinct lesson; the consolidation loop folds it into your per-agent lessons, which are injected automatically next run:

```bash
curl -s -X POST http://localhost:8321/api/feedback \
  -H "Content-Type: application/json" \
  -d '{"source":"self_critique","valence":"negative","scope_type":"agent_slug","scope_ref":"source-librarian","summary":"<one-line lesson, e.g. WhatsApp PDFs never carry captions - always fetch bytes before filing>"}'
```

Silent by default: no user notification unless Phase 3 found something irrecoverable or a delegated reorg was spawned (one short DM via `/api/notify`, priority low).
