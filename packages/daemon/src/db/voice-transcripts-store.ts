import type Database from "better-sqlite3";

/**
 * Persistence helpers for `voice_transcripts` — local-Whisper transcripts
 * keyed 1:1 to `chat_attachments.id`. The cache lets a re-dispatch of the
 * same turn (or a Phase-9 hourly check that revisits an old voice
 * message) reuse a transcription instead of re-running inference.
 *
 * See `docs/design/appendices/voice-transcription.md`.
 */

export interface VoiceTranscriptRow {
  attachmentId: string;
  model: string;
  language: string | null;
  durationSec: number | null;
  transcript: string;
  createdAt: string;
}

interface DbRow {
  attachment_id: string;
  model: string;
  language: string | null;
  duration_sec: number | null;
  transcript: string;
  created_at: string;
}

function mapRow(row: DbRow): VoiceTranscriptRow {
  return {
    attachmentId: row.attachment_id,
    model: row.model,
    language: row.language,
    durationSec: row.duration_sec,
    transcript: row.transcript,
    createdAt: row.created_at,
  };
}

export function getVoiceTranscript(
  db: Database.Database,
  attachmentId: string,
): VoiceTranscriptRow | null {
  const row = db
    .prepare(
      `SELECT attachment_id, model, language, duration_sec, transcript, created_at
         FROM voice_transcripts
         WHERE attachment_id = ?`,
    )
    .get(attachmentId) as DbRow | undefined;
  return row ? mapRow(row) : null;
}

export interface SaveVoiceTranscriptInput {
  attachmentId: string;
  model: string;
  language: string | null;
  durationSec: number | null;
  transcript: string;
}

export function saveVoiceTranscript(
  db: Database.Database,
  input: SaveVoiceTranscriptInput,
): VoiceTranscriptRow {
  db.prepare(
    `INSERT INTO voice_transcripts (attachment_id, model, language, duration_sec, transcript)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(attachment_id) DO UPDATE SET
       model = excluded.model,
       language = excluded.language,
       duration_sec = excluded.duration_sec,
       transcript = excluded.transcript,
       created_at = datetime('now')`,
  ).run(
    input.attachmentId,
    input.model,
    input.language,
    input.durationSec,
    input.transcript,
  );

  // Read back to surface the canonical created_at timestamp the caller
  // can stash in logs / responses without doing arithmetic on a string
  // it didn't write.
  const row = getVoiceTranscript(db, input.attachmentId);
  if (!row) {
    throw new Error(
      `voice_transcripts row missing immediately after insert (attachment_id=${input.attachmentId})`,
    );
  }
  return row;
}

export function deleteVoiceTranscript(
  db: Database.Database,
  attachmentId: string,
): boolean {
  const result = db
    .prepare(`DELETE FROM voice_transcripts WHERE attachment_id = ?`)
    .run(attachmentId);
  return result.changes > 0;
}
