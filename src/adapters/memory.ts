import type { Adapter, OnboardingEvent, SessionRecord } from "../types";

/**
 * In-memory adapter. Great for tests and prototyping; state is lost when the
 * process exits. Sessions are stored as JSON strings so callers can never
 * mutate stored records by reference.
 */
export function memoryAdapter(): Adapter {
  const sessions = new Map<string, string>();
  const events: OnboardingEvent[] = [];
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  return {
    createSession(session) {
      sessions.set(session.id, JSON.stringify(session));
    },
    getSession(id) {
      const raw = sessions.get(id);
      return raw ? (JSON.parse(raw) as SessionRecord) : null;
    },
    updateSession(id, session) {
      sessions.set(id, JSON.stringify(session));
    },
    listSessions() {
      return [...sessions.values()]
        .map((raw) => JSON.parse(raw) as SessionRecord)
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    recordEvent(event) {
      events.push(clone(event));
    },
    listEvents(sessionId) {
      return events.filter((e) => e.sessionId === sessionId).map(clone);
    },
  };
}
