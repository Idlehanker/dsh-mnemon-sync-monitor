/**
 * Live activity for the settings page.
 *
 * WHY A HUB AND NOT A POLLER
 * The page used to fetch /state exactly once, on mount, and never again - so the
 * coverage bar was a snapshot that could not move while you watched it. The
 * obvious repair (a setInterval that re-fetches) is the wrong one: it re-walks
 * the vault and re-reads every note on a fixed cadence whether or not anything
 * happened, and it keeps doing that while the tab sits open and idle.
 *
 * This module inverts that. The producer already knows the exact moment
 * something changed - the watcher fired, a pass started, one note finished - so
 * it publishes an event, and every open page receives it in the same tick. With
 * no page open there are no listeners and publishing costs an array push.
 *
 * Two event kinds, one subscription:
 *   state    - the whole current status (phase, current file, counters). Sent
 *              once on subscribe, then after every meaningful mutation. The
 *              page always holds one authoritative object instead of applying
 *              deltas and drifting.
 *   activity - one human-readable line for the log ("pass started",
 *              "foo.md -> 3 insights"). Kept in a bounded ring.
 *
 * @module dsh-mnemon-sync-monitor/events
 */

/** The state object every subscriber receives. Never null, never partial. */
function emptyState() {
  return {
    phase: 'idle',
    running: false,
    reason: undefined,
    startedAt: undefined,
    finishedAt: undefined,
    nextRunAt: undefined,
    current: undefined,
    budget: { planned: 0, done: 0, failed: 0 },
    insights: { proposed: 0, persisted: 0 },
    coverage: undefined,
    // How many notes may distil at once. Declared here so the shape is stable
    // from the first frame: the Settings picker reads it off this object, and an
    // absent key would render as "unknown" until the first pass started.
    concurrency: undefined,
    lastError: undefined,
  };
}

export class ActivityHub {
  /**
   * @param {object} [options] Hub settings.
   * @param {number} [options.historyLimit] Activity lines kept for a new subscriber.
   */
  constructor(options = {}) {
    this.historyLimit = options.historyLimit ?? 80;
    /** @type {Array<object>} Bounded ring of activity lines. */
    this.history = [];
    /** @type {Set<(event: object) => void>} Live subscribers. */
    this.listeners = new Set();
    this.seq = 0;
    this.state = emptyState();
  }

  /**
   * Subscribe to every subsequent event.
   *
   * The callback is invoked synchronously from publish(), so a slow subscriber
   * would slow the producer. The only subscriber here is an HTTP response
   * write, which is fine; anything heavier belongs behind a queue.
   *
   * @param {(event: object) => void} listener Callback.
   * @returns {() => void} Unsubscribe.
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** How many pages are currently attached. Zero means publishing is nearly free. */
  get subscriberCount() {
    return this.listeners.size;
  }

  /**
   * Everything a freshly connected subscriber needs to render immediately,
   * without waiting for the next mutation.
   * @returns {{seq: number, state: object, recent: object[]}}
   */
  snapshot() {
    return { seq: this.seq, state: this.state, recent: this.history.slice(-40) };
  }

  /**
   * Replace fields of the current state and notify subscribers.
   *
   * A full snapshot is sent rather than a patch: the page is a single reducer
   * over one object, so a dropped or reordered event cannot leave it showing a
   * mix of two states.
   *
   * @param {object} patch Fields to merge.
   * @returns {object} The published event.
   */
  setState(patch) {
    this.state = { ...this.state, ...patch };
    // The event MUST carry the state: the page renders `event.state`, so a
    // state frame without it renders nothing. Caught by test/live-loop.e2e.mjs,
    // which asserts the phase transitions actually arrive.
    return this.publish({ kind: 'state', state: this.state }, { record: false });
  }

  /**
   * Append one activity line.
   *
   * @param {string} message Human-readable, already localised by the caller.
   * @param {object} [data] Optional structured detail for the page.
   * @returns {object} The published event.
   */
  note(message, data) {
    return this.publish({ kind: 'activity', message, data }, { record: true });
  }

  /**
   * Publish an event to every subscriber.
   *
   * @param {object} body Event body (kind + payload).
   * @param {object} [options] Behaviour flags.
   * @param {boolean} [options.record] Keep this event in the replay ring.
   * @returns {object} The event that was sent.
   */
  publish(body, options = {}) {
    this.seq += 1;
    const event = { seq: this.seq, at: new Date().toISOString(), ...body };
    if (options.record === true) {
      this.history.push(event);
      if (this.history.length > this.historyLimit) {
        this.history.splice(0, this.history.length - this.historyLimit);
      }
    }
    if (this.listeners.size === 0) return event;
    // Copy before iterating: a listener that unsubscribes during delivery must
    // not corrupt the Set being walked.
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // One broken page must never break the watcher or another page.
        this.listeners.delete(listener);
      }
    }
    return event;
  }

  /** Reset to the idle shape, keeping the sequence number monotonic. */
  reset() {
    this.state = emptyState();
    return this.publish({ kind: 'state', state: this.state }, { record: false });
  }
}

/**
 * Write one Server-Sent Event frame.
 *
 * Frames are newline-delimited and terminated by a blank line. The payload is
 * JSON-encoded onto a single line so a message containing a newline cannot
 * truncate the frame.
 *
 * @param {import('node:http').ServerResponse} res Response.
 * @param {string} name Event name.
 * @param {object} payload Event body.
 * @returns {boolean} Whether the write was accepted.
 */
export function writeEvent(res, name, payload) {
  if (res.writableEnded === true || res.destroyed === true) return false;
  try {
    res.write('event: ' + name + '\n' + 'data: ' + JSON.stringify(payload) + '\n\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Attach one HTTP response to the hub as a subscriber.
 *
 * WHY THE KEEPALIVE IS NOT A REFRESH
 * An idle SSE connection is closed by intermediary proxies and by some HTTP
 * servers after a quiet period. The keepalive below writes an SSE COMMENT
 * (a line starting with a colon), which every EventSource implementation
 * discards without dispatching an event: it cannot cause a re-render, it
 * carries no state, and it is a handful of bytes. It exists only so the socket
 * is not considered dead. Set keepAliveMs to 0 to disable it.
 *
 * @param {object} params Wiring.
 * @param {ActivityHub} params.hub The hub to subscribe to.
 * @param {import('node:http').IncomingMessage} params.req Request.
 * @param {import('node:http').ServerResponse} params.res Response.
 * @param {number} [params.keepAliveMs] Comment interval; 0 disables.
 * @returns {() => void} Detach.
 */
export function attachEventStream({ hub, req, res, keepAliveMs = 25_000 }) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    // no-transform stops a proxy from buffering or gzipping the stream, either
    // of which would hold events until the connection closed.
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // nginx and friends buffer proxied responses by default; this opts out.
    'x-accel-buffering': 'no',
  });
  // Send headers immediately: a browser does not fire 'open' until the first
  // byte arrives, and the page shows the connection state.
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (event) => { writeEvent(res, event.kind === 'activity' ? 'activity' : 'state', event); };
  const detach = hub.subscribe(send);

  // Hand the new subscriber the current picture at once, so opening the page
  // during a long pass shows the pass that is already running.
  const snapshot = hub.snapshot();
  writeEvent(res, 'hello', { ...snapshot, subscribers: hub.subscriberCount });

  let timer;
  if (keepAliveMs > 0) {
    timer = setInterval(() => {
      if (res.writableEnded === true || res.destroyed === true) return;
      try { res.write(': keepalive\n\n'); } catch { /* closed under us */ }
    }, keepAliveMs);
    // Never hold the process open just for a keepalive comment.
    timer.unref?.();
  }

  const close = () => {
    if (timer !== undefined) clearInterval(timer);
    detach();
  };
  req.on('close', close);
  req.on('error', close);
  res.on('close', close);
  return close;
}
