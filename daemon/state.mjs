// Session state tracking: turns agent hook events into a list of sessions.
//
// States: a = needs attention, w = working, d = done (waiting for the next
// prompt), i = idle (session open, nothing asked yet or gone stale).
//
// Each session also carries running totals for the detail view: time spent
// working, tokens used, files changed and tool calls made.

import path from 'node:path';

const WORKING_STALE_MS = 2 * 60 * 60 * 1000; // a "working" session with no events for 2h is treated as idle
const SESSION_EXPIRE_MS = 12 * 60 * 60 * 1000; // sessions never closed cleanly are dropped after 12h
const MAX_WIRE_SESSIONS = 12;
const MAX_NAME_LENGTH = 16;
const STATE_ORDER = { a: 0, w: 1, d: 2, i: 3 };

const TURN_START_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest']);
const TURN_END_EVENTS = new Set(['Stop', 'Interrupt', 'agent-turn-complete']);
const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Codex edits files by sending a patch whose header lines name each file.
const PATCH_FILE_PATTERN = /\*\*\* (?:Update|Add|Delete) File: ([^\n\\"]+)/g;

export class SessionStore {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.sessions = new Map(); // key -> session
  }

  // Apply one hook payload. Returns true if anything visible changed.
  apply(agent, event) {
    const id = event.session_id || event.sessionId || event.thread_id || event.conversation_id;
    const type = event.hook_event_name || event.event || event.type;
    if (!id || !type) return false;

    const key = `${agent}:${id}`;
    if (type === 'SessionEnd') return this.sessions.delete(key);

    const next = nextState(type, event, this.sessions.get(key)?.state);
    if (!next) return false;

    const now = this.now();
    let session = this.sessions.get(key);
    const isNew = !session;
    if (isNew) {
      session = {
        key,
        agent,
        id,
        name: sessionName(event),
        state: next,
        updatedAt: now,
        startedAt: now,
        transcriptPath: null,
        turnStartedAt: null,
        workMs: 0,
        tokens: -1,
        tools: 0,
        files: new Set(),
      };
      this.sessions.set(key, session);
    }

    const before = statsKey(session);
    const changed = isNew || session.state !== next;
    session.state = next;
    session.updatedAt = now;
    // Keep the first name: the agent's working directory can wander into subfolders.
    if (event.cwd && session.name === 'session') session.name = sessionName(event);
    if (event.transcript_path) session.transcriptPath = event.transcript_path;
    this.trackStats(session, type, event, now);
    return changed || before !== statsKey(session);
  }

  trackStats(session, type, event, now) {
    if (TURN_START_EVENTS.has(type) && session.turnStartedAt === null) session.turnStartedAt = now;
    if (TURN_END_EVENTS.has(type) && session.turnStartedAt !== null) {
      session.workMs += now - session.turnStartedAt;
      session.turnStartedAt = null;
    }
    if (type !== 'PostToolUse') return;
    session.tools++;
    const input = event.tool_input;
    if (FILE_EDIT_TOOLS.has(event.tool_name)) {
      const file = input?.file_path || input?.notebook_path;
      if (file) session.files.add(file);
    } else if (input) {
      const text = typeof input === 'string' ? input : JSON.stringify(input);
      for (const match of text.matchAll(PATCH_FILE_PATTERN)) session.files.add(match[1].trim());
    }
  }

  // Record a token total read from the session's transcript. Returns true if it changed.
  setTokens(key, tokens) {
    const session = this.sessions.get(key);
    if (!session || !Number.isFinite(tokens) || session.tokens === tokens) return false;
    session.tokens = tokens;
    return true;
  }

  get(key) {
    return this.sessions.get(key);
  }

  // Demote or drop sessions that have gone quiet. Returns true if anything changed.
  sweep() {
    const now = this.now();
    let changed = false;
    for (const [key, s] of this.sessions) {
      const age = now - s.updatedAt;
      if (age > SESSION_EXPIRE_MS) {
        this.sessions.delete(key);
        changed = true;
      } else if (s.state === 'w' && age > WORKING_STALE_MS) {
        s.state = 'i';
        s.turnStartedAt = null;
        changed = true;
      }
    }
    return changed;
  }

  // Sessions sorted most-urgent first, then oldest first so positions stay stable.
  list() {
    return [...this.sessions.values()].sort(
      (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.startedAt - b.startedAt,
    );
  }

  // Seconds spent working, including the turn in progress.
  workSeconds(session) {
    const running = session.turnStartedAt === null ? 0 : this.now() - session.turnStartedAt;
    return Math.round((session.workMs + running) / 1000);
  }

  // Compact form for the device:
  //   [[agent, state, name, workSeconds, tokens, filesChanged, toolCalls], ...]
  // tokens is -1 until the first turn finishes.
  wire() {
    return this.list()
      .slice(0, MAX_WIRE_SESSIONS)
      .map((x) => [
        x.agent === 'codex' ? 'x' : 'c',
        x.state,
        asciiName(x.name),
        this.workSeconds(x),
        x.tokens,
        x.files.size,
        x.tools,
      ]);
  }

  // Plain objects for /state (Sets do not survive JSON).
  describe() {
    return this.list().map((x) => ({ ...x, files: [...x.files], workSeconds: this.workSeconds(x) }));
  }
}

const statsKey = (s) => `${s.tools}:${s.files.size}:${s.turnStartedAt === null}`;

function nextState(type, event, current) {
  switch (type) {
    case 'SessionStart':
      return current || 'i';
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'SubagentStart':
    case 'SubagentStop':
    case 'PreCompact':
    case 'PostCompact':
      return 'w';
    case 'PermissionRequest':
      return 'a';
    case 'PermissionDenied':
      return 'w';
    case 'Notification': {
      const kind = event.notification_type || '';
      if (kind === 'permission_prompt' || kind === 'elicitation_dialog') return 'a';
      if (kind === 'idle_prompt') return current === 'a' ? 'a' : 'd';
      return null;
    }
    case 'Stop':
    case 'Interrupt':
    case 'agent-turn-complete':
      return 'd';
    default:
      return null;
  }
}

function sessionName(event) {
  return event.cwd ? path.basename(event.cwd) : 'session';
}

// The device font only covers ASCII.
function asciiName(name) {
  const clean = String(name).replace(/[^\x20-\x7e]/g, '?');
  return clean.length > MAX_NAME_LENGTH ? clean.slice(0, MAX_NAME_LENGTH - 1) + '~' : clean;
}
