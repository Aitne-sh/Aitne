---
doc_type: reference
doc_status: active
project: personal-agent
area: docs-system
owner: aitne
created: 2026-04-17
updated: 2026-04-17
tags:
  - "project/personal-agent"
  - "doc/reference"
  - "area/docs-system"
  - "state/active"
aliases:
  - "spec example"
related:
  - "../_schema.md"
  - "../_templates/spec.md"
  - "./index-example.md"
  - "./adr-example.md"
---
# Example spec — Observation ingestion

## Summary

Normalize inbound observations into a single queue so routines can read a stable shape.

## Purpose

Keep ingestion rules separate from downstream routine logic.

## Scope

- Queue write path
- Validation rules
- Storage contract

## Non-goals

- UI design
- Scheduling policy

## Constraints

- The storage record must be append-safe.
- Input sources may arrive out of order.

## Design

A source adapter validates the payload, stamps the normalized metadata, and writes the record to the observation store.

## Interfaces / data model / API

- `ObservationInput`
- `recordObservation()`
- `getPendingObservations()`

## Risks

- Duplicate writes from retried sources
- Inconsistent source-specific identifiers

## Implementation notes

Prefer idempotent writes keyed by source and source reference.

## Related documents

- [Documentation schema](../_schema.md)
- [Spec template](../_templates/spec.md)
- [Index example](./index-example.md)
- [ADR example](./adr-example.md)
