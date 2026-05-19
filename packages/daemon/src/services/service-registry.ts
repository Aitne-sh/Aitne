/**
 * Mutable service registry — allows services to be initialized or replaced
 * at runtime (e.g., after OAuth completes) without daemon restart.
 *
 * All consumers (routes, context-builder, poller, status) hold a reference
 * to this registry object. Mutating its properties is visible to all.
 */
import type { AppleCalendarService } from "./apple-calendar/index.js";
import type { CalendarService } from "./calendar.js";
import type { GmailService } from "./gmail.js";
import type { ObsidianService } from "./obsidian.js";
import type { NotionService } from "./notion.js";
import type { GitHubService } from "./github.js";
import type { GoogleMapsService } from "./google-maps.js";
import type { MailAccountRegistry } from "./mail/account-registry.js";
import type { JournalMirrorService } from "./journal/writer.js";

export interface ServiceRegistry {
  calendar: CalendarService | null;
  appleCalendar: AppleCalendarService | null;
  gmail: GmailService | null;
  mail: MailAccountRegistry | null;
  obsidian: ObsidianService | null;
  notion: NotionService | null;
  github: GitHubService | null;
  googleMaps: GoogleMapsService | null;
  journal: JournalMirrorService | null;
  /** Error messages from service initialization attempts */
  errors: Record<string, string>;
}

export function createServiceRegistry(): ServiceRegistry {
  return {
    calendar: null,
    appleCalendar: null,
    gmail: null,
    mail: null,
    obsidian: null,
    notion: null,
    github: null,
    googleMaps: null,
    journal: null,
    errors: {},
  };
}
