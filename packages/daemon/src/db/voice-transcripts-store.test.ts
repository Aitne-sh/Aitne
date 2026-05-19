import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  deleteVoiceTranscript,
  getVoiceTranscript,
  saveVoiceTranscript,
} from "./voice-transcripts-store.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function seedAttachment(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO chat_attachments
       (id, direction, provenance, path, original_filename, safe_filename, mime_type, size_bytes)
     VALUES (?, 'inbound', 'user_telegram', ?, ?, ?, 'audio/ogg', ?)`,
  ).run(id, `/tmp/${id}/voice.ogg`, "voice.ogg", "voice.ogg", 1024);
}

describe("voice-transcripts-store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
    seedAttachment(db, "att-1");
  });

  it("getVoiceTranscript returns null when no row exists", () => {
    expect(getVoiceTranscript(db, "att-1")).toBeNull();
  });

  it("saveVoiceTranscript persists the row and reads back", () => {
    const saved = saveVoiceTranscript(db, {
      attachmentId: "att-1",
      model: "Xenova/whisper-small",
      language: "ja",
      durationSec: 4.2,
      transcript: "こんにちは",
    });
    expect(saved.attachmentId).toBe("att-1");
    expect(saved.model).toBe("Xenova/whisper-small");
    expect(saved.language).toBe("ja");
    expect(saved.durationSec).toBeCloseTo(4.2);
    expect(saved.transcript).toBe("こんにちは");
    expect(saved.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}/);

    const read = getVoiceTranscript(db, "att-1");
    expect(read).toEqual(saved);
  });

  it("saveVoiceTranscript upserts on conflicting attachment_id", () => {
    saveVoiceTranscript(db, {
      attachmentId: "att-1",
      model: "Xenova/whisper-tiny",
      language: null,
      durationSec: null,
      transcript: "first",
    });
    const updated = saveVoiceTranscript(db, {
      attachmentId: "att-1",
      model: "Xenova/whisper-small",
      language: "en",
      durationSec: 2.0,
      transcript: "second",
    });
    expect(updated.transcript).toBe("second");
    expect(updated.model).toBe("Xenova/whisper-small");
    expect(updated.language).toBe("en");

    const read = getVoiceTranscript(db, "att-1");
    expect(read?.transcript).toBe("second");
  });

  it("preserves null language / durationSec round-trip", () => {
    saveVoiceTranscript(db, {
      attachmentId: "att-1",
      model: "Xenova/whisper-small",
      language: null,
      durationSec: null,
      transcript: "no metadata",
    });
    const read = getVoiceTranscript(db, "att-1");
    expect(read?.language).toBeNull();
    expect(read?.durationSec).toBeNull();
  });

  it("deleteVoiceTranscript returns true on hit, false on miss", () => {
    saveVoiceTranscript(db, {
      attachmentId: "att-1",
      model: "Xenova/whisper-small",
      language: "ja",
      durationSec: 1.5,
      transcript: "hello",
    });
    expect(deleteVoiceTranscript(db, "att-1")).toBe(true);
    expect(getVoiceTranscript(db, "att-1")).toBeNull();
    expect(deleteVoiceTranscript(db, "att-1")).toBe(false);
  });

  it("throws if the row vanishes between INSERT and the read-back", () => {
    // Defensive guard at saveVoiceTranscript's tail — the INSERT just
    // succeeded but a concurrent DELETE could in theory empty the row
    // before the read-back. Simulate that by hooking db.prepare so the
    // first SELECT after the INSERT returns no row. The throw guarantees
    // the caller never gets back a "successfully saved" without a DTO.
    const realPrepare = db.prepare.bind(db);
    let insertCount = 0;
    db.prepare = ((sql: string) => {
      const stmt = realPrepare(sql);
      // Detect the post-insert read-back (the SELECT that follows the
      // INSERT...ON CONFLICT statement). Replace its `.get` with a
      // function that returns undefined so the row appears to have
      // vanished.
      if (
        sql.startsWith("SELECT attachment_id, model, language") &&
        insertCount === 1
      ) {
        return {
          ...stmt,
          get: () => undefined,
        } as unknown as ReturnType<typeof realPrepare>;
      }
      if (sql.startsWith("INSERT INTO voice_transcripts")) {
        insertCount += 1;
      }
      return stmt;
    }) as typeof db.prepare;

    expect(() =>
      saveVoiceTranscript(db, {
        attachmentId: "att-1",
        model: "Xenova/whisper-small",
        language: "ja",
        durationSec: 1,
        transcript: "vanished",
      }),
    ).toThrow(/row missing immediately after insert/);
  });

  it("cascades when chat_attachments row is deleted", () => {
    saveVoiceTranscript(db, {
      attachmentId: "att-1",
      model: "Xenova/whisper-small",
      language: "ja",
      durationSec: 2.0,
      transcript: "to be cascaded",
    });
    db.prepare("PRAGMA foreign_keys = ON").run();
    db.prepare("DELETE FROM chat_attachments WHERE id = ?").run("att-1");
    expect(getVoiceTranscript(db, "att-1")).toBeNull();
  });
});
