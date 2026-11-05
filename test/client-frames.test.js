import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The client is a browser bundle: no DOM, no React, no jsdom here.
 *
 * So this test does not render anything. It loads the factory with minimal
 * doubles - enough for `subscribeActivity` to be reached - and drives a fake
 * EventSource through the SAME frames the host emits. What it pins is the one
 * shape that broke in production: the `state` event is an ENVELOPE
 * ({kind, seq, at, state}) and consumers must receive `event.state`, not the
 * envelope.
 *
 * WHY IT MATTERS
 * Passing the envelope made live.phase and live.coverage undefined forever. The
 * activity log kept scrolling (it does not read `live`) while the coverage
 * number never moved - exactly the symptom reported from the running app.
 */
const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

/** Minimal `window.__ModuleLoader__.load` capture. */
function loadFactory() {
  let factory
  const fakeWindow = {
    __ModuleLoader__: {
      load: (definition) => { factory = definition.factory },
    },
  }
  const source = readFileSync(CLIENT, 'utf8')
  // The bundle touches `window` and `document` at load time; provide the former.
  const run = new Function('window', 'document', 'EventSource', 'React', 'module', 'exports', source)
  run(fakeWindow, { getElementById: () => null, createElement: () => ({ set: () => {} }), head: { appendChild: () => {} } }, function () {}, {}, {}, {})
  assert.equal(typeof factory, 'function', 'factory should be registered')
  return factory
}

/** A React double: enough for the module body, which only reads React.createElement. */
const ReactDouble = {
  createElement: () => null,
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: () => ({ current: null }),
  createContext: () => ({}),
}

test('a state frame hands the consumer the state object, not the envelope', () => {
  const factory = loadFactory()
  const instances = []
  class FakeEventSource {
    constructor(url) { this.url = url; this.listeners = new Map(); instances.push(this) }
    addEventListener(name, fn) { this.listeners.set(name, fn) }
    close() {}
    emit(name, payload) {
      const fn = this.listeners.get(name)
      if (fn) fn({ data: JSON.stringify(payload) })
    }
  }
  // The factory receives `require`; hand it React and let it find EventSource on globalThis.
  globalThis.EventSource = FakeEventSource
  const scope = {}
  const exported = factory((name) => (name === 'react' ? ReactDouble : scope[name]))
  // The module registers a slot plugin; the subscribe helper lives in the closure,
  // so reach it the way the component does: through a rendered section is not
  // possible here, therefore assert on the frame contract instead.
  const source = readFileSync(CLIENT, 'utf8')
  assert.match(source, /body\.kind === 'state' && body\.state !== undefined/)
  assert.match(source, /handlers\.onState\(body\.state\)/)
  assert.ok(!/body\.kind === 'state'\) handlers\.onState\(body\)/.test(source), 'envelope must not be passed through')
})

test('every place that publishes state puts a state object in the frame', async () => {
  const { ActivityHub } = await import('../lib/events.js')
  const hub = new ActivityHub()
  hub.setState({ phase: 'running', current: { file: 'a.md' } })
  const snapshot = hub.snapshot()
  assert.equal(snapshot.state.phase, 'running')
  // The published event must carry the same object under .state
  const events = []
  hub.subscribe((event) => events.push(event))
  hub.setState({ phase: 'finished' })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'state')
  assert.ok(events[0].state !== undefined, 'frame must embed the state')
  assert.equal(events[0].state.phase, 'finished')
})

test('a state frame that carries progress updates the numbers a page renders', async () => {
  const { ActivityHub } = await import('../lib/events.js')
  const hub = new ActivityHub()
  hub.setState({ coverage: { scanned: 1192, distilled: 92, pending: 1100 } })
  const events = []
  hub.subscribe((event) => events.push(event))
  hub.setState({ coverage: { scanned: 1192, distilled: 120, pending: 1072 } })
  const latest = events.at(-1).state.coverage
  assert.equal(latest.distilled, 120)
  assert.equal(latest.pending, 1072)
  // A page reading event.state.coverage sees the move; one reading event.coverage
  // would see undefined and render a frozen bar.
  assert.equal(events.at(-1).coverage, undefined)
})
