/**
 * Shared serialization for the SQL-backed adapters. Sessions and events are
 * stored as JSON-text blobs, so the wire format (and the row→record mapping)
 * lives here once rather than being duplicated per driver. The SQL statements
 * themselves stay in each adapter because placeholder syntax differs ($1 vs ?).
 */
import type { OnboardingEvent, SessionRecord } from "../types";

export interface SessionRow {
  data: string;
}

export interface EventRow {
  id: string;
  session_id: string;
  type: string;
  step_id: string | null;
  data: string;
  /** sqlite returns a number; Postgres BIGINT comes back as a string. */
  at: string | number;
}

export const serializeSession = (session: SessionRecord): string => JSON.stringify(session);

export const parseSessionRow = (row: SessionRow): SessionRecord => JSON.parse(row.data) as SessionRecord;

export const serializeEventData = (event: OnboardingEvent): string => JSON.stringify(event.data ?? null);

export function rowToEvent(row: EventRow): OnboardingEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type as OnboardingEvent["type"],
    stepId: row.step_id ?? undefined,
    data: JSON.parse(row.data) as unknown,
    at: Number(row.at),
  };
}
