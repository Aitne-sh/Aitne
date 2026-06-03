---
kind: reference
name: receipts-api
description: /api/receipts reference — list / filter, download, save-to-external-Obsidian-vault, reclassify, and summary endpoints for Gmail-observer-flagged attachments.
---

# `/api/receipts` reference

The daemon's Gmail observer scans travel-booking emails for PDF /
image attachments and can retain previously detected generic
documents. Attachment metadata is stored in the `receipts` SQLite
table. Actual files are downloaded on demand and saved to the user's
**external Obsidian vault** (NOT the primary management vault — see
the `## Receipts` section of the parent skill for the vault-routing
warning).

## GET /api/receipts

```bash
# All receipts
curl -s "http://localhost:8321/api/receipts?limit=50"

# Unsaved receipts only
curl -s "http://localhost:8321/api/receipts?saved=false"

# Filter by category
curl -s "http://localhost:8321/api/receipts?category=document"
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `category` | string | — | document, travel |
| `saved` | boolean | — | true = saved to Obsidian, false = not yet saved |
| `limit` | number | 50 | Max results (1–200) |

Response:

```json
{
  "receipts": [
    {
      "id": 1,
      "providerMsgId": "18f...",
      "accountId": "...",
      "attachmentId": "ANGj...",
      "filename": "receipt.pdf",
      "mimeType": "application/pdf",
      "sizeBytes": 45000,
      "category": "document",
      "obsidianPath": null,
      "savedAt": null,
      "createdAt": "2026-04-12T10:00:00Z"
    }
  ],
  "total": 1
}
```

`accountId` identifies the source mail account; `POST /receipts/:id/download`
uses it to resolve the provider.

## GET /api/receipts/summary

```bash
curl -s "http://localhost:8321/api/receipts/summary"
```

Returns counts: `{ total, saved, unsaved, byCategory: [{ category, count }] }`.

## POST /api/receipts/:id/download

```bash
curl -s -X POST "http://localhost:8321/api/receipts/1/download" -o receipt.pdf
```

Binary stream of the original attachment.

## PATCH /api/receipts/:id

```bash
# Mark as saved to external Obsidian vault
curl -s -X PATCH "http://localhost:8321/api/receipts/1" \
  -H "Content-Type: application/json" \
  -d '{"obsidianPath": "receipts/2026/04/amazon-receipt.pdf"}'

# Reclassify a receipt
curl -s -X PATCH "http://localhost:8321/api/receipts/1" \
  -H "Content-Type: application/json" \
  -d '{"category": "travel"}'
```

## External-vault save convention

Save receipts to `receipts/YYYY/MM/<merchant>-<date>.<ext>` inside
the external Obsidian vault.

Example: `receipts/2026/04/amazon-2026-04-12.pdf`.
