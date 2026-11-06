/* dsh-mnemon-sync-monitor — client half.
 *
 * Settings page for the watched knowledge-base roots, plus the distillation
 * controls. Two visual groups:
 *   1. 知识库监听 — the roots manager (list, add, rescan) and the config paths.
 *   2. 语义蒸馏   — the live on/off Switch and the model picker.
 *
 * Hand-written CommonJS factory registered into the browser module loader: no
 * bundler, no JSX. The page never reads or writes the config file itself; it
 * talks to the Host route mounted by the host half (/mnemon-sync-monitor), which
 * owns the trust fence and the write.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mnemon-sync-monitor',
  factory: function mnemonSyncMonitorFactory(require) {
    const React = require('react')
    const h = React.createElement

    const ROUTE = '/mnemon-sync-monitor'
    const SECTION_ID = 'mnemon-sync-monitor'

    /** Call the management route. */
    async function api(path, init) {
      const response = await fetch(ROUTE + path, {
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      const text = await response.text()
      let body
      try { body = text === '' ? {} : JSON.parse(text) } catch { body = { message: text } }
      if (!response.ok) {
        const error = new Error(body && body.message ? body.message : ('HTTP ' + response.status))
        error.code = body && body.code
        error.status = response.status
        throw error
      }
      return body
    }

    /**
     * Subscribe to the Host's activity stream.
     *
     * WHY AN EVENTSOURCE AND NOT A TIMER
     * This page used to read /state once, on mount, and never again: the numbers
     * could not move while you watched them. Re-fetching on an interval is the
     * obvious fix and the wrong one - it re-walks the vault on a fixed cadence
     * whether or not anything changed, and keeps doing it while the tab is idle.
     *
     * The Host already knows the exact moment something happens (a pass starts,
     * a note finishes, the switch flips) and pushes it here. Idle cost is one
     * open socket and occasionally a keepalive comment that EventSource
     * discards without firing an event.
     *
     * @param {object} handlers Callbacks.
     * @param {(snapshot: object) => void} handlers.onHello Initial snapshot.
     * @param {(state: object) => void} handlers.onState State replacement.
     * @param {(line: object) => void} handlers.onActivity One log line.
     * @param {(open: boolean) => void} handlers.onConnection Connection state.
     * @returns {() => void} Unsubscribe.
     */
    function subscribeActivity(handlers) {
      let closed = false
      let source
      try {
        source = new EventSource(ROUTE + '/events')
      } catch (openError) {
        handlers.onConnection(false)
        return () => {}
      }

      const parse = (event) => {
        try { return JSON.parse(event.data) } catch { return null }
      }
      source.addEventListener('hello', (event) => {
        const body = parse(event)
        if (body === null) return
        handlers.onConnection(true)
        if (body.state) handlers.onState(body.state)
        if (Array.isArray(body.recent) && body.recent.length > 0) handlers.onHistory(body.recent)
      })
      source.addEventListener('state', (event) => {
        const body = parse(event)
        // Hand over `body.state`, NOT `body`. The frame is an envelope
        // ({kind, seq, at, state}); passing the envelope made every consumer read
        // live.phase / live.coverage as undefined, so the activity log scrolled
        // while the coverage number never moved. The hello branch below always
        // unwrapped correctly, which is why a fresh page load looked right and
        // only subsequent updates were lost.
        if (body !== null && body.kind === 'state' && body.state !== undefined) handlers.onState(body.state)
      })
      source.addEventListener('activity', (event) => {
        const body = parse(event)
        if (body !== null && body.kind === 'activity') handlers.onActivity(body)
      })
      source.onopen = () => handlers.onConnection(true)
      // EventSource reconnects by itself with the server's retry interval. Do
      // NOT fall back to polling here: a closed stream is reported as offline,
      // and the reconnect re-sends a fresh 'hello' snapshot, which is all the
      // resynchronisation this page needs.
      source.onerror = () => {
        if (!closed) handlers.onConnection(false)
      }

      return () => {
        closed = true
        try { source.close() } catch { /* already closed */ }
      }
    }

    // Design tokens from the Host theme. Every value has a fallback so the page
    // still renders sensibly if a token is renamed upstream.
    const C = {
      card: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, transparent))',
      stroke: 'var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2, rgba(128,128,128,0.24)))',
      strokeSoft: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.18))',
      text: 'var(--dsw-alias-label-primary, inherit)',
      text2: 'var(--dsw-alias-label-secondary, inherit)',
      text3: 'var(--dsw-alias-label-tertiary, inherit)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.10))',
      // Inset controls (inputs, the picker trigger): the same fill DSH uses for
      // its own inset fields. Light #f9fafb, dark #353638 — legible in both.
      inset: 'var(--dsw-alias-bg-module-platform, rgba(128,128,128,0.16))',
      // Raised surfaces (the picker popover): a layer above the card.
      raised: 'var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2, transparent))',
      platform: 'var(--dsw-alias-bg-module-platform, rgba(128,128,128,0.16))',
      accent: 'var(--dsw-static-blue-500, #3b82f6)',
      accentText: 'var(--dsw-static-deepseek-400, #7aaaff)',
      accentSoft: 'var(--dsw-static-blue-500-a12, rgba(59,130,246,0.14))',
      success: 'var(--dsw-alias-state-success-primary, #22c55e)',
      danger: 'var(--dsw-alias-state-error-primary, #ef4444)',
      radius: 'var(--dsw-radius-lg, 12px)',
      radiusSm: 'var(--dsw-radius-md, 8px)',
      shadow: 'var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,0.18))',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    }

    /**
     * Install the keyframes the live panel uses, once per document.
     *
     * Inline styles cannot express @keyframes, so the one animation the page
     * needs (the pulsing dot while a pass runs) is injected as a style element.
     * Guarded by id so repeated mounts do not stack stylesheets.
     */
    function ensureKeyframes() {
      if (typeof document === 'undefined') return
      const id = 'dsh-mnemon-sync-monitor-keyframes'
      if (document.getElementById(id) !== null) return
      const style = document.createElement('style')
      style.id = id
      style.textContent = '@keyframes dsh-mnemon-pulse {'
        + '0%,100% { opacity: 1; transform: scale(1); }'
        + '50% { opacity: 0.55; transform: scale(0.82); }'
        + '}'
      document.head.appendChild(style)
    }

    const font = (size, weight, lineHeight) => ({
      fontSize: size, fontWeight: weight || 400, lineHeight: lineHeight || '20px',
      color: C.text, fontFamily: 'inherit',
    })

    /** A labelled card used for both groups. */
    function Card(props) {
      return h('section', {
        style: {
          display: 'flex', flexDirection: 'column', gap: 14,
          padding: '16px 18px 18px',
          background: C.card,
          border: '1px solid ' + (props.accent ? C.accent : C.stroke),
          borderLeft: props.accent ? '3px solid ' + C.accent : '1px solid ' + C.stroke,
          borderRadius: C.radius,
          boxShadow: props.accent ? '0 0 0 1px ' + C.accentSoft + ' inset' : 'none',
        },
      }, props.children)
    }

    /** Group header: dot + title + optional meta on the right. */
    function GroupHead(props) {
      return h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      },
        h('span', {
          'aria-hidden': true,
          style: {
            width: 8, height: 8, borderRadius: 99, flex: '0 0 auto',
            background: props.accent ? C.accent : C.text3,
            boxShadow: props.accent ? '0 0 0 4px ' + C.accentSoft : 'none',
          },
        }),
        h('h3', { style: { ...font(15, 600, '22px'), margin: 0 } }, props.title),
        props.meta === undefined ? null : h('span', {
          style: { ...font(12, 400, '18px'), color: C.text3 },
        }, props.meta),
        h('span', { style: { flex: 1 } }),
        props.right === undefined ? null : props.right,
      )
    }

    /** A pill. Tone: neutral | success | muted | accent. */
    function Pill(props) {
      const tone = props.tone || 'neutral'
      const map = {
        neutral: { fg: C.text2, bg: C.platform, bd: C.strokeSoft },
        success: { fg: C.success, bg: 'transparent', bd: C.success },
        muted: { fg: C.text3, bg: 'transparent', bd: C.strokeSoft },
        accent: { fg: C.accentText, bg: C.accentSoft, bd: 'transparent' },
        danger: { fg: C.danger, bg: 'transparent', bd: C.danger },
      }
      const t = map[tone] || map.neutral
      return h('span', {
        title: props.title,
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 5,
          fontSize: 11, lineHeight: '18px', padding: '1px 8px', borderRadius: 99,
          color: t.fg, background: t.bg, border: '1px solid ' + t.bd,
          whiteSpace: 'nowrap',
        },
      }, props.children)
    }

    /** Ghost / primary / danger button. Inline styles cannot express :hover, so
     *  the hover tint is tracked in component state. */
    function Button(props) {
      const [hover, setHover] = React.useState(false)
      const variant = props.variant || 'ghost'
      const base = {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        padding: '7px 14px', fontSize: 13, lineHeight: '20px', borderRadius: C.radiusSm,
        cursor: props.disabled ? 'not-allowed' : 'pointer',
        opacity: props.disabled ? 0.5 : 1,
        transition: 'background 140ms ease, border-color 140ms ease, color 140ms ease',
        fontFamily: 'inherit', whiteSpace: 'nowrap',
      }
      const styles = {
        ghost: {
          border: '1px solid ' + C.strokeSoft,
          background: hover && !props.disabled ? C.hover : 'transparent',
          color: C.text,
        },
        primary: {
          border: '1px solid ' + C.accent,
          background: hover && !props.disabled ? 'rgba(59,130,246,0.18)' : C.accentSoft,
          color: C.accentText,
        },
        subtle: {
          border: '1px solid transparent',
          background: hover && !props.disabled ? C.hover : 'transparent',
          color: C.text2,
        },
        danger: {
          border: '1px solid transparent',
          background: hover && !props.disabled ? 'var(--dsw-alias-interactive-bg-hover-danger, rgba(239,68,68,0.14))' : 'transparent',
          color: C.danger,
        },
      }
      return h('button', {
        type: 'button',
        title: props.title,
        disabled: props.disabled,
        onClick: props.onClick,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: { ...base, ...(styles[variant] || styles.ghost), ...(props.style || {}) },
      }, props.children)
    }

    /** The distillation Switch. A real switch, not a checkbox: role=switch, the
     *  thumb slides, and the control refuses clicks while a write is in flight. */
    function Switch(props) {
      const checked = props.checked === true
      const disabled = props.disabled === true
      const [hover, setHover] = React.useState(false)
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': props.label,
        title: props.title,
        disabled,
        onClick: () => { if (!disabled) props.onChange(!checked) },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          position: 'relative', width: 44, height: 24, flex: '0 0 auto',
          padding: 0, borderRadius: 999, border: 'none',
          cursor: disabled ? 'not-allowed' : 'pointer',
          background: checked ? C.accent : C.platform,
          boxShadow: checked
            ? '0 0 0 3px ' + C.accentSoft
            : 'inset 0 0 0 1px ' + (hover && !disabled ? C.stroke : C.strokeSoft),
          transition: 'background 180ms ease, box-shadow 180ms ease',
          opacity: disabled ? 0.55 : 1,
        },
      },
        h('span', {
          'aria-hidden': true,
          style: {
            position: 'absolute', top: 3, left: checked ? 23 : 3,
            width: 18, height: 18, borderRadius: '50%',
            background: 'var(--dsw-alias-switch-thumb, #fff)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.28)',
            transition: 'left 180ms cubic-bezier(0.4, 0, 0.2, 1)',
          },
        }),
      )
    }

    /** Chevron used by the picker trigger. */
    function Chevron(props) {
      return h('svg', {
        width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true,
        style: { flex: '0 0 auto', transform: props.open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms ease', opacity: 0.65 },
      }, h('path', {
        d: 'M2.5 4.5 L6 8 L9.5 4.5',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    function CheckMark() {
      return h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true, style: { flex: '0 0 auto', color: C.accent } },
        h('path', {
          d: 'M2 6.4 L4.6 9 L10 3.2',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      )
    }

    /** A downward chevron. `collapsed` turns it into the tree's closed state
     *  (pointing right); otherwise it points down, as an open node should. */
    function TreeToggle(props) {
      return h('svg', {
        width: 10, height: 10, viewBox: '0 0 12 12', 'aria-hidden': true,
        style: {
          flex: '0 0 auto', opacity: 0.7,
          transform: props.collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
          transition: 'transform 160ms ease',
        },
      }, h('path', {
        d: 'M2.5 4.5 L6 8 L9.5 4.5',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    /**
     * A provider node — the PARENT of a group of models.
     *
     * It is deliberately not selectable: a provider is a namespace, not a
     * choice. Clicking it collapses or expands its children, the way a tree node
     * behaves, and the model count tells the reader what is inside while it is
     * closed.
     */
    function ProviderHeader(props) {
      const [hover, setHover] = React.useState(false)
      const collapsed = props.collapsed === true
      return h('button', {
        type: 'button',
        'aria-expanded': !collapsed,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onClick: props.onToggle,
        title: (collapsed ? '展开 ' : '收起 ') + props.providerName,
        style: {
          display: 'flex', alignItems: 'center', gap: 7, width: '100%',
          textAlign: 'left', padding: '6px 8px', marginTop: 2,
          border: 'none', borderRadius: C.radiusSm, cursor: 'pointer',
          background: hover ? C.hover : 'transparent',
          color: C.text2, fontFamily: 'inherit',
        },
      },
        h(TreeToggle, { collapsed }),
        h('span', {
          style: {
            flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, lineHeight: '18px',
            color: C.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
        }, props.providerName),
        h(Pill, { tone: 'muted' }, String(props.count)),
      )
    }

    /** One model — a CHILD row of a provider node. The short rail on the left
     *  is what makes the parent/child relation visible at a glance. */
    function ModelItem(props) {
      const [hover, setHover] = React.useState(false)
      const selected = props.selected === true
      const rail = props.rail !== false
      return h('button', {
        type: 'button',
        role: 'option',
        'aria-selected': selected,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onClick: props.onPick,
        style: {
          display: 'flex', alignItems: 'center', gap: 8,
          width: '100%', textAlign: 'left', padding: '7px 9px',
          border: 'none', borderRadius: C.radiusSm, cursor: 'pointer',
          background: selected ? C.accentSoft : (hover ? C.hover : 'transparent'),
          color: C.text, fontFamily: 'inherit',
        },
      },
        rail
          ? h('span', {
              'aria-hidden': true,
              style: {
                flex: '0 0 auto', width: 1, height: 16, borderRadius: 1,
                background: selected ? C.accent : C.strokeSoft,
                marginLeft: 4, marginRight: 6,
              },
            })
          : null,
        h('span', { style: { display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 } },
          h('span', {
            style: { ...font(13, selected ? 600 : 400, '18px'),
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, props.title),
          props.subtitle === undefined ? null : h('span', {
            style: { fontSize: 11, lineHeight: '16px', color: C.text3, fontFamily: C.mono,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, props.subtitle),
        ),
        props.chip === undefined ? null : h(Pill, { tone: 'muted' }, props.chip),
        selected ? h(CheckMark, null) : h('span', { style: { width: 12, flex: '0 0 auto' } }),
      )
    }

    /** Nearest ancestor that actually scrolls, so the popover can be measured
     *  against the pane it lives in instead of the whole window. */
    function findScroller(element) {
      if (!element || typeof element.parentElement === 'undefined') return null
      if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return null
      let node = element.parentElement
      while (node && node.nodeType === 1) {
        const style = window.getComputedStyle(node)
        if (style && /(auto|scroll|overlay)/.test(style.overflowY || '')) return node
        node = node.parentElement
      }
      return null
    }

    /**
     * The model picker.
     *
     * A native <select> was the source of the invisible-text bug: the browser
     * paints the option list with its own background, so the popup rendered white
     * text on a white panel and the models were unreadable. This is a button plus
     * a DOM listbox, so both the trigger and the list use the page's own theme
     * tokens and stay legible in light and dark mode.
     */
    function ModelPicker(props) {
      const models = props.models || []
      const selectedModel = props.selectedModel
      const pendingModel = props.pendingModel
      const busy = props.busy === true
      const [open, setOpen] = React.useState(false)
      const [query, setQuery] = React.useState('')
      // Which provider nodes are collapsed. Empty = everything expanded, so a
      // fresh open shows the full tree rather than hiding models by default.
      const [collapsed, setCollapsed] = React.useState({})
      // Where the popover goes. 'down' is the natural fit; 'up' is used when the
      // trigger sits near the bottom of the pane and there is no room below.
      const [placement, setPlacement] = React.useState('down')
      const [maxHeight, setMaxHeight] = React.useState(320)
      const rootRef = React.useRef(null)
      const anchorRef = React.useRef(null)
      const triggerRef = React.useRef(null)
      const searchRef = React.useRef(null)

      const currentValue = selectedModel === null
        ? ''
        : JSON.stringify([selectedModel.provider, selectedModel.model])
      const dirty = pendingModel !== currentValue

      const currentTitle = pendingModel === ''
        ? '跟随页面默认'
        : (function () {
            const picked = models.find((m) => m.value === pendingModel)
            if (picked) return picked.name
            const pair = selectedModel
            return pair === null ? '跟随页面默认' : pair.model
          })()
      const currentSub = pendingModel === ''
        ? '推荐 · 使用页面当前默认模型'
        : (function () {
            const picked = models.find((m) => m.value === pendingModel)
            return picked ? picked.providerName + ' · ' + picked.model : pendingModel
          })()

      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        if (searchRef.current) {
          try { searchRef.current.focus() } catch (focusError) { /* ignore */ }
        }
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      // Decide which way the popover opens, and how tall it may get.
      //
      // The distillation group sits at the bottom of the settings pane, so the
      // space below the trigger is usually smaller than the list. Measuring the
      // real gaps beats a fixed direction: the popover opens upward whenever
      // the room below cannot hold it, and is capped so it never runs off the
      // top either.
      React.useEffect(() => {
        if (!open) return undefined
        const measure = () => {
          const trigger = triggerRef.current
          if (!trigger || typeof trigger.getBoundingClientRect !== 'function') return
          // Measure the trigger itself — the anchor wraps only the trigger, so its
          // rect is the one the popover must clear.
          const rect = trigger.getBoundingClientRect()
          const viewportHeight = (typeof window !== 'undefined' && window.innerHeight) || 800
          const scroller = findScroller(trigger)
          const bounds = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: viewportHeight }
          const below = bounds.bottom - rect.bottom
          const above = rect.top - bounds.top
          const GAP = 6
          const MIN_USABLE = 220
          const preferredMax = 340
          // Below wins only when it can show a useful amount; otherwise flip up.
          const roomBelow = below - GAP
          const roomAbove = above - GAP
          let nextPlacement = 'down'
          if (roomBelow < MIN_USABLE && roomAbove > roomBelow) nextPlacement = 'up'
          const room = Math.max(nextPlacement === 'up' ? roomAbove : roomBelow, 120)
          setPlacement(nextPlacement)
          setMaxHeight(Math.min(preferredMax, room))
        }
        measure()
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('resize', measure)
          const scroller = findScroller(triggerRef.current)
          if (scroller) scroller.addEventListener('scroll', measure, { passive: true })
          return () => {
            window.removeEventListener('resize', measure)
            if (scroller) scroller.removeEventListener('scroll', measure)
          }
        }
        return undefined
      }, [open])

      const needle = query.trim().toLowerCase()
      const matches = needle === ''
        ? models
        : models.filter((m) => (m.name + ' ' + m.model + ' ' + m.providerName).toLowerCase().indexOf(needle) !== -1)

      // Provider = PARENT node, its models = CHILDREN. The parent order follows
      // the catalog (ctx.llm.listProviders) so it matches the composer's own
      // picker rather than an incidental sort.
      const groups = []
      const index = new Map()
      for (const m of matches) {
        if (!index.has(m.provider)) {
          const group = { provider: m.provider, providerName: m.providerName, items: [] }
          index.set(m.provider, group)
          groups.push(group)
        }
        index.get(m.provider).items.push(m)
      }

      const pick = (value) => {
        props.onPick(value)
        setOpen(false)
        setQuery('')
      }

      return h('div', { ref: rootRef, style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('span', { style: { ...font(13, 500, '20px'), color: C.text2, flex: '0 0 auto' } }, '蒸馏模型'),
          h('span', { style: { flex: 1 } }),
          h(Button, { variant: 'subtle', disabled: busy, onClick: props.onRefresh, title: '重新拉取可用模型（provider 变化后使用）' }, '刷新列表'),
        ),

        // The trigger and its popover share ONE positioned anchor, so the popover
        // is measured against the trigger rather than against the whole column.
        // Without this an upward flip cleared the trigger and covered everything
        // above it.
        h('div', { ref: anchorRef, style: { position: 'relative' } },
          h('button', {
            type: 'button',
            ref: triggerRef,
            disabled: busy || models.length === 0,
            onClick: () => setOpen((previous) => !previous),
            'aria-haspopup': 'listbox',
            'aria-expanded': open,
            style: {
              display: 'flex', alignItems: 'center', gap: 10, width: '100%',
              padding: '10px 12px', textAlign: 'left',
              border: '1px solid ' + (open ? C.accent : C.strokeSoft),
              borderRadius: C.radiusSm,
              background: C.inset,
              color: C.text, fontFamily: 'inherit',
              cursor: busy || models.length === 0 ? 'not-allowed' : 'pointer',
              opacity: busy || models.length === 0 ? 0.6 : 1,
              boxShadow: open ? '0 0 0 3px ' + C.accentSoft : 'none',
              transition: 'border-color 140ms ease, box-shadow 140ms ease',
            },
          },
            h('span', {
              'aria-hidden': true,
              style: {
                width: 24, height: 24, borderRadius: 7, background: C.accentSoft,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                color: C.accentText, fontSize: 11, fontWeight: 700, flex: '0 0 auto',
              },
            }, 'M'),
            h('span', { style: { display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 } },
              h('span', { style: { ...font(13, 500, '18px'), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, currentTitle),
              h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.text3, fontFamily: C.mono,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, currentSub),
            ),
            dirty ? h(Pill, { tone: 'accent' }, '未应用') : null,
            h(Chevron, { open }),
          ),

          open
            ? h('div', {
                role: 'listbox',
                style: {
                  position: 'absolute', left: 0, right: 0, zIndex: 40,
                  // Opens away from the nearest edge: upward when the trigger sits
                  // low in the pane, downward when there is room below.
                  ...(placement === 'up'
                    ? { bottom: '100%', marginBottom: 6 }
                    : { top: '100%', marginTop: 6 }),
                  padding: 6,
                  background: C.raised,
                  border: '1px solid ' + C.stroke,
                  borderRadius: C.radius,
                  boxShadow: C.shadow,
                  display: 'flex', flexDirection: 'column', gap: 2,
                  maxHeight: maxHeight, overflowY: 'auto',
                },
              },
                models.length > 8
                  ? h('input', {
                      ref: searchRef,
                      value: query,
                      placeholder: '搜索模型…',
                      onChange: (event) => setQuery(event.target.value),
                      style: {
                        position: 'sticky', top: 0, zIndex: 1,
                        margin: '0 0 4px', padding: '6px 9px', fontSize: 12,
                        borderRadius: C.radiusSm, border: '1px solid ' + C.strokeSoft,
                        background: C.inset, color: C.text, fontFamily: 'inherit', outline: 'none',
                      },
                    })
                  : null,
                // The sentinel choice, not tied to any provider: pinned above the
                // tree and framed so it cannot be mistaken for a model row.
                h(ModelItem, {
                  rail: false,
                  title: '跟随页面默认',
                  subtitle: '使用页面当前默认模型',
                  chip: '推荐',
                  selected: pendingModel === '',
                  onPick: () => pick(''),
                }),
                groups.length === 0
                  ? h('div', { style: { ...font(12, 400, '18px'), color: C.text3, padding: '10px' } }, '没有匹配的模型')
                  : h('div', {
                      style: {
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '8px 8px 2px', marginTop: 2,
                      },
                    },
                      h('span', { style: { flex: '1', height: 1, background: C.strokeSoft } }),
                      h('span', { style: { fontSize: 10, lineHeight: '14px', letterSpacing: '0.06em', color: C.text3 } },
                        'PROVIDER / MODEL'),
                      h('span', { style: { flex: '1', height: 1, background: C.strokeSoft } }),
                    ),
                // One collapsible node per provider; models are its children.
                ...groups.map((group) => {
                  const isCollapsed = collapsed[group.provider] === true
                  return h('div', {
                    key: group.provider,
                    style: { display: 'flex', flexDirection: 'column', gap: 1 },
                  },
                    h(ProviderHeader, {
                      providerName: group.providerName,
                      count: group.items.length,
                      collapsed: isCollapsed,
                      onToggle: () => setCollapsed((previous) => {
                        const next = { ...previous }
                        if (next[group.provider]) delete next[group.provider]
                        else next[group.provider] = true
                        return next
                      }),
                    }),
                    isCollapsed
                      ? null
                      : h('div', {
                          style: { display: 'flex', flexDirection: 'column', gap: 1, paddingLeft: 14 },
                        },
                          ...group.items.map((item) => h(ModelItem, {
                            key: item.value,
                            title: item.name,
                            subtitle: item.model,
                            selected: pendingModel === item.value,
                            onPick: () => pick(item.value),
                          })),
                        ),
                  )
                }),
              )
            : null,
        ),

        dirty
          ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
              background: C.accentSoft, borderRadius: C.radiusSm } },
              h('span', { style: { ...font(12, 400, '18px'), color: C.text2, flex: 1 } }, '选择已改变，应用后写入配置文件'),
              h(Button, { variant: 'subtle', disabled: busy, onClick: () => pick(currentValue) }, '撤销'),
              h(Button, { variant: 'primary', disabled: busy, onClick: props.onSave }, busy ? '应用中…' : '应用'),
            )
          : null,
      )
    }


    /** Effort tiers rendered in words, so the control reads as a choice of cost
     *  rather than a raw enum. Unknown ids fall back to the id itself. */
    const EFFORT_LABELS = {
      off: 'Off · 不思考',
      minimal: 'Minimal',
      low: 'Low · 轻量',
      medium: 'Medium · 均衡',
      high: 'High · 深入',
      xhigh: 'XHigh',
      max: 'Max · 最强',
      ultra: 'Ultra',
    }

    /**
     * The reasoning-effort selector for distillation.
     *
     * Why this is a segmented control and not a dropdown: there are at most a
     * handful of tiers, they are ordered, and the user is choosing a position on a
     * cost/quality axis. A menu hides that ordering behind a click; a segmented row
     * shows where the current choice sits.
     *
     * `null` (跟随模型默认) is always offered, because on some models the best
     * choice is to send no override at all — the gateway then applies the adapter's
     * own default. It is framed differently from a real tier so it cannot be
     * mistaken for one.
     */
    function EffortPicker(props) {
      const busy = props.busy === true
      const info = props.info
      const current = props.value
      const onChange = props.onChange
      const efforts = info === null ? [] : (info.efforts || [])
      const supported = info !== null && info.supported === true

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('span', { style: { ...font(13, 500, '20px'), color: C.text2, flex: '0 0 auto' } }, '思考等级'),
          info === null || info.modelDefault === null
            ? null
            : h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.text3 } },
                '模型默认：' + info.modelDefault),
          h('span', { style: { flex: 1 } }),
          // The one number that makes the trade-off concrete. Distillation is a
          // background task that runs per note, so its cost is a multiplier, not a
          // one-off.
          h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.text3 } },
            '等级越低，蒸馏越快、消耗越少'),
        ),

        info === null
          ? h('div', { style: { ...font(12, 400, '18px'), color: C.text3 } }, '正在读取模型支持的档位…')
          : supported === false
            ? h('div', { style: { ...font(12, 400, '18px'), color: C.text3 } },
                '当前模型未声明思考档位，蒸馏将使用模型自身的默认行为。')
            : h('div', {
                role: 'radiogroup',
                'aria-label': '蒸馏思考等级',
                style: { display: 'flex', flexWrap: 'wrap', gap: 6 },
              },
                // "Follow the model default" first, visually separated: it is not a
                // tier, it is the absence of an override.
                h('button', {
                  type: 'button',
                  role: 'radio',
                  'aria-checked': current === null,
                  disabled: busy,
                  onClick: () => { if (!busy && current !== null) onChange(null) },
                  title: '不发送任何档位覆盖，交由模型自身的默认值决定',
                  style: {
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '6px 11px', fontSize: 12, lineHeight: '18px',
                    borderRadius: C.radiusSm, fontFamily: 'inherit',
                    cursor: busy ? 'not-allowed' : 'pointer',
                    opacity: busy ? 0.6 : 1,
                    border: '1px dashed ' + (current === null ? C.accent : C.strokeSoft),
                    background: current === null ? C.accentSoft : 'transparent',
                    color: current === null ? C.accentText : C.text3,
                  },
                }, '跟随模型默认'),
                h('span', {
                  'aria-hidden': true,
                  style: { width: 1, alignSelf: 'stretch', background: C.strokeSoft, margin: '0 2px' },
                }),
                ...efforts.map((effort) => {
                  const selected = current === effort.id
                  return h('button', {
                    key: effort.id,
                    type: 'button',
                    role: 'radio',
                    'aria-checked': selected,
                    disabled: busy,
                    title: effort.description === undefined ? effort.id : effort.description,
                    onClick: () => { if (!busy && !selected) onChange(effort.id) },
                    style: {
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      padding: '6px 11px', fontSize: 12, lineHeight: '18px',
                      borderRadius: C.radiusSm, fontFamily: 'inherit',
                      cursor: busy ? 'not-allowed' : 'pointer',
                      opacity: busy ? 0.6 : 1,
                      border: '1px solid ' + (selected ? C.accent : C.strokeSoft),
                      background: selected ? C.accentSoft : C.inset,
                      color: selected ? C.accentText : C.text2,
                      fontWeight: selected ? 600 : 400,
                      transition: 'background 140ms ease, border-color 140ms ease',
                    },
                  },
                    EFFORT_LABELS[effort.id] || effort.name || effort.id,
                    selected ? h(CheckMark, null) : null,
                  )
                }),
              ),

        h('p', { style: { ...font(11, 400, '16px'), color: C.text3, margin: 0 } },
          '蒸馏是后台任务，每篇笔记调用一次，所以档位省下的是乘以篇数的开销。实测同一条笔记、'
          + '同一模型下，Low 比 High 少约 26% 的思考量、约 4% 的输出 token，结论条数不变，'
          + '耗时基本持平；Max 则多耗约 51% 输出 token。'),
      )
    }

    /** The parallelism tiers. Plain counts, so every label is the number. */
    const CONCURRENCY_OPTIONS = [1, 2, 3, 4, 6, 8]

    /**
     * The distillation concurrency selector.
     *
     * Same segmented shape as the effort picker, for the same reason: the
     * choices sit on an ordered speed/cost axis, and a menu would hide that
     * ordering behind a click. The numbers ARE the labels here — one option is
     * one worker — so the row reads as a dial, not a list of names.
     */
    function ConcurrencyPicker(props) {
      const busy = props.busy === true || props.disabled === true
      const current = props.value
      const onChange = props.onChange
      const maxKnown = typeof props.max === 'number' && props.max > 0
      const max = maxKnown ? props.max : 8
      const options = CONCURRENCY_OPTIONS.filter((count) => count <= max)

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('span', { style: { ...font(13, 500, '20px'), color: C.text2, flex: '0 0 auto' } }, '并发蒸馏'),
          maxKnown
            ? h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.text3 } }, '上限 ' + max + ' 个')
            : null,
          h('span', { style: { flex: 1 } }),
          // Distillation runs once per note, so concurrency multiplies a
          // background cost instead of adding a one-off: tokens buy wall time.
          h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.text3 } },
            '同时蒸馏的笔记数，越大越快但更吃额度'),
        ),

        current === null
          ? h('div', { style: { ...font(12, 400, '18px'), color: C.text3 } }, '正在读取并发设置…')
          : h('div', {
              role: 'radiogroup',
              'aria-label': '蒸馏并发数',
              style: { display: 'flex', flexWrap: 'wrap', gap: 6 },
            },
              ...options.map((count) => {
                const selected = current === count
                return h('button', {
                  key: count,
                  type: 'button',
                  role: 'radio',
                  'aria-checked': selected,
                  disabled: busy,
                  title: count === 1
                    ? '逐个处理：一结束才开下一篇，最稳也最慢'
                    : ('同时蒸馏 ' + count + ' 篇笔记'),
                  onClick: () => { if (!busy && !selected) onChange(count) },
                  style: {
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '6px 11px', fontSize: 12, lineHeight: '18px',
                    borderRadius: C.radiusSm, fontFamily: 'inherit',
                    cursor: busy ? 'not-allowed' : 'pointer',
                    opacity: busy ? 0.6 : 1,
                    border: '1px solid ' + (selected ? C.accent : C.strokeSoft),
                    background: selected ? C.accentSoft : C.inset,
                    color: selected ? C.accentText : C.text2,
                    fontWeight: selected ? 600 : 400,
                    transition: 'background 140ms ease, border-color 140ms ease',
                  },
                },
                  String(count),
                  selected ? h(CheckMark, null) : null,
                )
              }),
            ),

        h('p', { style: { ...font(11, 400, '16px'), color: C.text3, margin: 0 } },
          '并发只作用于排队中的笔记：设为 1 时逐个处理（最稳），数值越高越吃模型额度。'
          + '改动从下一篇笔记起生效，正在进行的那一批不受影响，无需重启。'),
      )
    }

    /**
     * The live activity panel.
     *
     * Renders one authoritative state object pushed by the Host plus a bounded
     * log of activity lines. The only clock-like thing it does is format a
     * duration it already received, never poll for a new one.
     */
    function LiveActivity(props) {
      const live = props.live
      const activity = props.activity || []
      const enabled = props.enabled === true
      const busy = props.busy === true
      const connected = props.connected === true

      const phase = live === null ? (enabled ? 'idle' : 'idle') : (live.phase || 'idle')
      const running = live !== null && live.running === true
      const coverage = live === null ? null : (live.coverage || null)
      const budget = live === null ? null : (live.budget || null)
      const current = live === null ? null : (live.current || null)
      // In-flight files, newest-to-oldest as the Host listed them. A Host that
      // predates the worker pool sends none, and one in-flight note is still
      // the single line below, so both shapes keep the old rendering.
      const files = current !== null && Array.isArray(current.files) ? current.files : []
      const parallel = files.length > 1
      const activeCount = current !== null && typeof current.active === 'number'
        ? current.active
        : files.length

      // A pass in flight is worth showing even when the coverage number cannot
      // move yet; without this the pane looks dead for the whole first batch.
      const tone = running ? 'accent' : (phase === 'failed' ? 'danger' : (phase === 'queued' ? 'muted' : 'neutral'))
      const label = running
        ? '正在蒸馏…'
        : phase === 'queued'
          ? '已排队，等待下一轮'
          : phase === 'failed'
            ? '上一轮失败'
            : phase === 'finished'
              ? '上一轮已完成'
              : '空闲'

      const progress = coverage !== null && typeof coverage.scanned === 'number' && coverage.scanned > 0
        ? Math.min(100, Math.round((coverage.distilled / coverage.scanned) * 100))
        : 0

      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: 10,
          padding: '12px 13px', borderRadius: C.radiusSm,
          border: '1px solid ' + (running ? C.accent : C.strokeSoft),
          background: running ? C.accentSoft : 'transparent',
          transition: 'border-color 200ms ease, background 200ms ease',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', {
            'aria-hidden': true,
            style: {
              width: 8, height: 8, borderRadius: 99, flex: '0 0 auto',
              background: running ? C.accent : (phase === 'failed' ? C.danger : C.text3),
              boxShadow: running ? '0 0 0 4px ' + C.accentSoft : 'none',
              animation: running ? 'dsh-mnemon-pulse 1.6s ease-in-out infinite' : 'none',
            },
          }),
          h('span', { style: { ...font(13, 600, '20px'), color: C.text } }, '实时状态'),
          h(Pill, { tone }, label),
          connected ? null : h(Pill, { tone: 'danger' }, '未连接'),
          h('span', { style: { flex: 1 } }),
          h(Button, {
            variant: 'primary',
            disabled: busy || !enabled || running,
            onClick: props.onStart,
            title: enabled ? '立即开始一轮蒸馏' : '请先开启语义蒸馏',
          }, running ? '蒸馏中…' : '立即蒸馏'),
        ),

        // One note in flight is the old single line, unchanged; several means a
        // worker pool is running, so each in-flight note gets its own row and
        // the header names how many Agents are busy.
        current === null ? null : parallel
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('span', { style: { fontSize: 11, color: C.text3 } }, '当前文件'),
                h(Pill, { tone: 'accent' }, activeCount + ' 个 Agent 并行'),
              ),
              ...files.map((entry) => h('div', {
                key: entry.file,
                style: {
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px',
                  borderRadius: C.radiusSm, background: C.inset,
                },
              },
                h('span', {
                  style: {
                    flex: 1, minWidth: 0, fontSize: 12, fontFamily: C.mono, color: C.text,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  },
                  title: entry.file,
                }, entry.file),
                entry.bytes === undefined ? null : h(Pill, { tone: 'muted' }, entry.bytes + ' B'),
              )),
            )
          : h('div', {
              style: {
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px',
                borderRadius: C.radiusSm, background: C.inset,
              },
            },
              h('span', { style: { fontSize: 11, color: C.text3, flex: '0 0 auto' } }, '当前文件'),
              h('span', {
                style: {
                  flex: 1, minWidth: 0, fontSize: 12, fontFamily: C.mono, color: C.text,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                },
                title: current.file,
              }, current.file),
              current.bytes === undefined ? null : h(Pill, { tone: 'muted' }, current.bytes + ' B'),
            ),

        budget === null ? null : h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h(Pill, { tone: 'muted' }, '本批 ' + budget.done + ' / ' + budget.planned),
          budget.failed > 0 ? h(Pill, { tone: 'danger' }, '失败 ' + budget.failed) : null,
          live.insights === undefined ? null : h(Pill, { tone: 'accent' },
            '已写入 ' + (live.insights.persisted || 0) + ' 条'),
          live.nextRunAt === undefined ? null : h(Pill, { tone: 'muted' },
            '下次 ' + new Date(live.nextRunAt).toLocaleTimeString()),
        ),

        coverage === null ? null : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
            h('span', { style: { ...font(12, 500, '18px'), color: C.text2 } }, '蒸馏覆盖率'),
            h('span', { style: { fontSize: 11, fontFamily: C.mono, color: C.text3 } },
              coverage.distilled + ' / ' + coverage.scanned),
            h('span', { style: { flex: 1 } }),
            h('span', { style: { fontSize: 11, color: C.text3 } },
              coverage.pending === 0 ? '全部完成' : '剩余 ' + coverage.pending + ' 篇排队'),
          ),
          h('div', {
            role: 'progressbar',
            'aria-valuemin': 0,
            'aria-valuemax': coverage.scanned,
            'aria-valuenow': coverage.distilled,
            style: { height: 6, borderRadius: 99, overflow: 'hidden', background: C.inset, border: '1px solid ' + C.strokeSoft },
          },
            h('div', {
              style: {
                width: progress + '%', height: '100%',
                background: coverage.pending === 0 ? C.success : C.accent,
                transition: 'width 320ms ease',
              },
            }),
          ),
        ),

        live !== null && live.lastError !== undefined && live.lastError !== null
          ? h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.danger } }, '最近错误：' + live.lastError)
          : null,

        activity.length === 0
          ? h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.text3 } },
              enabled ? '暂无活动。知识库一有变化就会在这里出现。' : '语义蒸馏已关闭，不会产生活动。')
          : h('div', {
              style: {
                display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 168, overflowY: 'auto',
                padding: '6px 9px', borderRadius: C.radiusSm, background: C.inset,
              },
            },
              ...activity.slice(0, 40).map((line) => h('div', {
                key: line.seq,
                style: { display: 'flex', gap: 8, fontSize: 11.5, lineHeight: '18px' },
              },
                h('span', { style: { color: C.text3, fontFamily: C.mono, flex: '0 0 auto' } },
                  new Date(line.at).toLocaleTimeString()),
                h('span', {
                  style: {
                    color: C.text2, flex: 1, minWidth: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  },
                  title: line.message,
                }, line.message),
              )),
            ),
      )
    }

    /** The watched-roots manager plus the distillation controls. */
    function SyncMonitorSection() {
      const [state, setState] = React.useState({ loading: true, roots: [], store: null, patch: null, env: null, attempts: [], distill: null })
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      // The model list comes ONLY from /models, which is the same ctx.llm catalog
      // the main composer's model picker renders. No second list is kept here.
      const [models, setModels] = React.useState([])
      const [selectedModel, setSelectedModel] = React.useState(null)
      const [pendingModel, setPendingModel] = React.useState('')
      const [distillEnabled, setDistillEnabled] = React.useState(false)
      // Reasoning effort: { efforts, supported, modelDefault, effective, ... }.
      // Null until /efforts answers; the picker renders a placeholder until then.
      const [effortInfo, setEffortInfo] = React.useState(null)
      const [effort, setEffort] = React.useState(null)
      // Distillation concurrency: how many notes are distilled in parallel.
      // Null until /concurrency (or the first state frame) answers.
      const [concurrency, setConcurrency] = React.useState(null)
      const [concurrencyMax, setConcurrencyMax] = React.useState(null)
      // Ledger coverage: { scanned, distilled, pending, roots }. Null until the
      // first state frame arrives.
      const [coverage, setCoverage] = React.useState(null)
      // Live pass state pushed by the Host. Null until the stream opens.
      const [live, setLive] = React.useState(null)
      // Newest-first activity lines, bounded: this is a log, not a transcript.
      const [activity, setActivity] = React.useState([])
      const [connected, setConnected] = React.useState(false)

      React.useEffect(() => { ensureKeyframes() }, [])

      const load = React.useCallback(async () => {
        try {
          const body = await api('/state')
          setState({
            loading: false,
            roots: body.roots || [],
            store: body.store || null,
            patch: body.patch || null,
            env: body.env || null,
            attempts: body.attempts || [],
            distill: body.distill || null,
          })
          if (body.distill && typeof body.distill.enabled === 'boolean') {
            setDistillEnabled(body.distill.enabled)
          }
          // A page that has not received its first stream frame yet still needs
          // an accurate picture; the stream then keeps it current. When the
          // stream is already up it wins, so this first paint cannot regress
          // state that has since moved on.
          if (body.distill && body.distill.coverage && typeof body.distill.coverage.scanned === 'number') {
            setCoverage((previous) => previous === null ? body.distill.coverage : previous)
          }
          if (body.distill && body.distill.live && typeof body.distill.live === 'object') {
            setLive((previous) => previous === null ? body.distill.live : previous)
          }
          // Same rule for the parallelism knob: seed it when the page has never
          // read it, then let /concurrency and the stream own it.
          if (typeof body.concurrency === 'number') {
            setConcurrency((previous) => previous === null ? body.concurrency : previous)
          }
          if (typeof body.concurrencyMax === 'number') {
            setConcurrencyMax((previous) => previous === null ? body.concurrencyMax : previous)
          }
          setError(null)
        } catch (loadError) {
          setState((previous) => ({ ...previous, loading: false }))
          setError(loadError.message)
        }
      }, [])

      const loadModels = React.useCallback(async () => {
        try {
          const body = await api('/models')
          const list = body.models || []
          setModels(list)
          const selected = body.selected || null
          setSelectedModel(selected)
          setPendingModel(selected === null ? '' : JSON.stringify([selected.provider, selected.model]))
        } catch (modelError) {
          // A provider outage must not hide the roots manager; report it in the
          // model section instead of failing the whole page.
          setModels([])
          setError((previous) => previous || ('模型列表加载失败：' + modelError.message))
        }
      }, [])

      /** Load the effort tiers the selected model accepts. */
      const loadEfforts = React.useCallback(async () => {
        try {
          const body = await api('/efforts')
          const info = body.effort || null
          setEffortInfo(info)
          if (info !== null) setEffort(info.effective === undefined ? null : info.effective)
        } catch (effortError) {
          // A failed effort read must not block the switch or the model picker.
          setEffortInfo(null)
          setError((previous) => previous || ('思考等级加载失败：' + effortError.message))
        }
      }, [])

      /** Persist one effort choice. Applies to the next call, no restart. */
      const saveEffort = async (next) => {
        if (busy) return
        setBusy(true); setError(null); setNotice(null)
        try {
          const body = await api('/effort', {
            method: 'POST',
            body: JSON.stringify({ effort: next }),
          })
          // Trust the Host: a failed write must not leave the row showing a tier
          // that was never persisted.
          const confirmed = body.effort === undefined ? next : body.effort
          setEffort(confirmed)
          setNotice(confirmed === null
            ? '已改为跟随模型默认档位'
            : ('思考等级已设为 ' + confirmed + '，下一篇笔记立即生效'))
          await loadEfforts()
        } catch (effortError) {
          setError(effortError.message)
        } finally { setBusy(false) }
      }

      /** Read the current parallelism and its ceiling from the Host. */
      const loadConcurrency = React.useCallback(async () => {
        try {
          const body = await api('/concurrency')
          const info = body.concurrency || null
          if (info === null) return
          setConcurrency(typeof info.value === 'number' ? info.value : null)
          if (typeof info.max === 'number') setConcurrencyMax(info.max)
        } catch (concurrencyError) {
          // A failed read must not hide the switch, the model picker or the
          // effort row; the picker just keeps its placeholder.
          setError((previous) => previous || ('并发设置加载失败：' + concurrencyError.message))
        }
      }, [])

      /** Persist one concurrency choice. Applies from the next note onward. */
      const saveConcurrency = async (next) => {
        if (busy) return
        setBusy(true); setError(null); setNotice(null)
        try {
          const body = await api('/concurrency', {
            method: 'POST',
            body: JSON.stringify({ concurrency: next }),
          })
          // Trust the Host: a rejected write must not leave the row showing a
          // number that was never persisted.
          setConcurrency(typeof body.concurrency === 'number' ? body.concurrency : next)
          setNotice('并发蒸馏已设为 ' + (typeof body.concurrency === 'number' ? body.concurrency : next)
            + ' 个 Agent，下一篇笔记立即生效')
          await loadConcurrency()
        } catch (concurrencyError) {
          setError(concurrencyError.message)
        } finally { setBusy(false) }
      }

      // One subscription for the lifetime of the page.
      //
      // The initial /state and /models reads are a ONE-OFF bootstrap: they carry
      // what the stream does not (roots, model catalog, config paths). Everything
      // that changes while the page is open - phase, current file, counters,
      // coverage, switch position - arrives on the stream, so there is no timer
      // anywhere in this component.
      React.useEffect(() => { load(); loadModels(); loadEfforts(); loadConcurrency() },
        [load, loadModels, loadEfforts, loadConcurrency])

      React.useEffect(() => {
        const unsubscribe = subscribeActivity({
          onConnection: (open) => setConnected(open),
          onState: (next) => setLive(next),
          onHistory: (lines) => setActivity((previous) => {
            // The hello frame replays the recent ring; merge rather than replace
            // so lines received live are not lost if a reconnect races them.
            const seen = new Set(previous.map((line) => line.seq))
            const merged = [...previous]
            for (const line of lines) if (!seen.has(line.seq)) merged.push(line)
            return merged.sort((a, b) => b.seq - a.seq).slice(0, 60)
          }),
          onActivity: (line) => setActivity((previous) => [line, ...previous].slice(0, 60)),
        })
        return unsubscribe
      }, [])

      // Coverage travels on the stream, so a pass that finishes while the page
      // is open updates the bar without another request.
      React.useEffect(() => {
        if (live !== null && live.coverage !== undefined && live.coverage !== null) {
          setCoverage(live.coverage)
        }
      }, [live])

      // The effective concurrency can change behind the page's back (a config
      // edit, a clamp to the ceiling). When the stream carries it, the row
      // follows rather than showing a number that is no longer in force.
      React.useEffect(() => {
        if (live !== null && typeof live.concurrency === 'number') {
          setConcurrency(live.concurrency)
        }
      }, [live])

      const toggleEnabled = async (next) => {
        if (busy) return
        setBusy(true); setError(null); setNotice(null)
        try {
          const body = await api('/enabled', {
            method: 'POST',
            body: JSON.stringify({ enabled: next }),
          })
          // Trust the Host response, not the optimistic value: a failed persist
          // must not show a switch that is actually still off.
          const confirmed = body.status && typeof body.status.enabled === 'boolean'
            ? body.status.enabled
            : next
          setDistillEnabled(confirmed)
          setNotice(confirmed ? '蒸馏已开启，后续知识库变更将自动入库' : '蒸馏已关闭，待执行的调度已取消')
          await load()
        } catch (toggleError) {
          setError(toggleError.message)
        } finally { setBusy(false) }
      }

      const saveModel = async () => {
        if (busy) return
        setBusy(true); setError(null); setNotice(null)
        try {
          await api('/model', {
            method: 'POST',
            body: JSON.stringify({ value: pendingModel === '' ? null : pendingModel }),
          })
          setNotice('模型已切换；后续蒸馏调用立即生效，无需重启')
          await loadModels()
          // Tiers are a per-model capability: the new model may not accept the
          // effort that was selected for the old one.
          await loadEfforts()
          await load()
        } catch (saveError) {
          setError(saveError.message)
        } finally { setBusy(false) }
      }

      const add = async () => {
        const value = draft.trim()
        if (value === '' || busy) return
        setBusy(true); setError(null); setNotice(null)
        try {
          await api('/roots', { method: 'POST', body: JSON.stringify({ root: value }) })
          setDraft('')
          setNotice('已添加并开始监听')
          await load()
        } catch (addError) {
          setError(addError.message)
        } finally { setBusy(false) }
      }

      const remove = async (root) => {
        if (busy) return
        setBusy(true); setError(null); setNotice(null)
        try {
          await api('/roots/remove', { method: 'POST', body: JSON.stringify({ root }) })
          setNotice('已移除监听')
          await load()
        } catch (removeError) {
          setError(removeError.message)
        } finally { setBusy(false) }
      }

      /** Ask for a pass now. The reply is 202; progress arrives on the stream. */
      const startDistill = async () => {
        if (busy) return
        setBusy(true); setError(null); setNotice(null)
        try {
          await api('/distill', { method: 'POST' })
          setNotice('已开始蒸馏，进度在下方实时显示')
        } catch (startError) {
          setError(startError.message)
        } finally {
          setBusy(false)
        }
      }

      const rescan = async () => {
        if (busy) return
        setBusy(true); setError(null); setNotice(null)
        try {
          await api('/rescan', { method: 'POST' })
          setNotice('已触发重新扫描')
        } catch (rescanError) {
          setError(rescanError.message)
        } finally { setBusy(false) }
      }

      const roots = state.roots || []
      const totalDocs = roots.reduce((sum, entry) => sum + (Number(entry.markdown) || 0), 0)
      const distill = state.distill || null
      const runningNow = distill !== null && distill.running === true
      const pendingPass = distill !== null && distill.pending === true

      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 880, padding: '4px 0' },
      },
        // Page header
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h('h2', { style: { ...font(18, 600, '26px'), margin: 0 } }, '知识库实时同步'),
          h('p', { style: { ...font(12, 400, '18px'), color: C.text3, margin: 0 } },
            '监听 Markdown 知识库；文件新增、修改会即时写入 dsh-mnemon 项目档案。删除的源文件默认保留档案（prune 关闭）。'),
        ),

        // ---- GROUP 1: watched roots ----
        h(Card, null,
          h(GroupHead, {
            title: '知识库监听',
            meta: roots.length === 0 ? '尚未监听' : (roots.length + ' 个目录 · ' + totalDocs + ' 篇 md'),
            // The rescan lives HERE, not beside the path input. It acts on every
            // root already being watched and never reads the text field, so
            // sitting it next to 添加 invited the reading "scan the path I just
            // typed". Same row as the list it operates on makes the scope visible.
            right: h(Button, {
              disabled: busy || roots.length === 0,
              onClick: rescan,
              title: roots.length === 0
                ? '尚未监听任何目录'
                : '重新扫描全部 ' + roots.length + ' 个已监听目录（不影响下方输入框）',
            }, busy ? '扫描中…' : '立即扫描'),
          }),

          state.loading
            ? h('div', { style: { ...font(13, 400, '20px'), color: C.text3, padding: '10px 0' } }, '加载中…')
            : roots.length === 0
              ? h('div', {
                  style: {
                    display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center',
                    padding: '22px 16px', borderRadius: C.radiusSm,
                    border: '1px dashed ' + C.strokeSoft, color: C.text3,
                  },
                },
                  h('span', { style: font(13, 500, '20px') }, '还没有监听任何目录'),
                  h('span', { style: font(12, 400, '18px') }, '在下方输入一个知识库根目录的绝对路径后添加'),
                )
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                  ...roots.map((entry) => h(RootRow, {
                    key: entry.path,
                    entry,
                    busy,
                    onRemove: () => remove(entry.path),
                  })),
                ),

          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('input', {
              value: draft,
              placeholder: '输入要监听的目录绝对路径，例如 C:\\Users\\me\\Obsidian\\vault',
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') add() },
              disabled: busy,
              style: {
                flex: '1 1 180px', minWidth: 160,
                padding: '8px 11px', fontSize: 13, lineHeight: '20px', borderRadius: C.radiusSm,
                border: '1px solid ' + C.strokeSoft, background: C.inset, color: C.text,
                fontFamily: C.mono, outline: 'none',
              },
            }),
            h(Button, { variant: 'primary', disabled: busy || draft.trim() === '', onClick: add, style: { flex: '0 0 auto' } }, '添加'),
          ),

          // Spelled out because the two actions sit in one card: 添加 acts on the
          // field above, 立即扫描 on the list. Adding already triggers a scan.
          h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.text3 } },
            '添加后会自动扫描该目录；上方的「立即扫描」只针对已监听的目录，与输入框无关。'),

          error === null ? null : h('div', {
            style: { fontSize: 12, lineHeight: '18px', color: C.danger, padding: '6px 10px',
              borderRadius: C.radiusSm, background: 'var(--dsw-static-red-600-a08, rgba(239,68,68,0.10))' },
          }, '错误：' + error),
          notice === null ? null : h('div', {
            style: { fontSize: 12, lineHeight: '18px', color: C.success, padding: '6px 10px',
              borderRadius: C.radiusSm, background: 'var(--dsw-static-green-500-a08, rgba(34,197,94,0.10))' },
          }, notice),

          h('div', {
            style: { display: 'flex', flexDirection: 'column', gap: 3, paddingTop: 10, borderTop: '1px solid ' + C.strokeSoft },
          },
            state.patch === null
              ? h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.danger } }, '未找到 profile 配置文件：改动无法持久化')
              : h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.text3 } }, '配置写入：' + state.patch),
            state.patch === null && state.env !== null
              ? h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.text3 } },
                  '诊断 · DSH_HOME=' + String(state.env.DSH_HOME)
                  + ' · DSH_PROFILE=' + String(state.env.DSH_PROFILE)
                  + ' · DSH_PROFILE_DIR=' + String(state.env.DSH_PROFILE_DIR))
              : null,
            state.patch === null && state.attempts.length > 0
              ? h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.text3 } },
                  '尝试路径：' + state.attempts.map((a) => a.source + (a.exists ? '(存在)' : '(不存在)')).join(' / '))
              : null,
            state.store === null ? null : h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.text3 } }, '档案存储：' + state.store),
            h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.text3 } }, '注意：新同步的内容需要重开会话才能在检索中看到。'),
          ),
        ),

        // ---- GROUP 2: semantic distillation ----
        h(Card, { accent: true },
          h(GroupHead, {
            accent: true,
            title: '语义蒸馏',
            meta: distillEnabled ? '已开启 · 变更自动写入 Memory Space' : '已关闭 · 仅同步 Documents',
            right: h(Switch, {
              checked: distillEnabled,
              disabled: busy,
              label: '语义蒸馏开关',
              title: '开启后，知识库变更会经模型蒸馏写入 Memory Space',
              onChange: toggleEnabled,
            }),
          }),
          h('p', { style: { ...font(12, 400, '18px'), color: C.text3, margin: 0 } },
            '知识库变更后，用选定的模型把笔记蒸馏成结论写入 Memory Space。模型列表与主输入框底部同源；provider 变更导致模型下架时在此切换即可，无需改配置文件。'),

          h(ModelPicker, {
            models,
            selectedModel,
            pendingModel,
            busy,
            onPick: setPendingModel,
            onSave: saveModel,
            onRefresh: loadModels,
          }),

          models.length === 0
            ? h('div', { style: { fontSize: 12, lineHeight: '18px', color: C.danger } },
                '当前没有可用模型，请检查主输入框的模型列表。')
            : null,

          h(EffortPicker, {
            info: effortInfo,
            value: effort,
            busy,
            onChange: saveEffort,
          }),

          // Sits directly under the effort row: both are per-note cost knobs for
          // the same background pass, so they belong side by side.
          h(ConcurrencyPicker, {
            value: concurrency,
            max: concurrencyMax,
            disabled: busy,
            onChange: saveConcurrency,
          }),

          // Live pass panel. Everything here is pushed by the Host; the page has
          // no timer and derives nothing on its own, so what it shows IS what the
          // pass is doing rather than what it was doing when the pane opened.
          h(LiveActivity, {
            live,
            connected,
            enabled: distillEnabled,
            activity,
            busy,
            onStart: startDistill,
          }),

          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            h(Pill, { tone: distillEnabled ? 'success' : 'muted' }, distillEnabled ? '已开启' : '已关闭'),
            distill === null ? null : h(Pill, { tone: distill.automatic ? 'accent' : 'muted' },
              distill.automatic ? '自动调度' : '仅手动触发'),
            h(Pill, { tone: connected ? 'success' : 'danger' },
              connected ? '已连接实时状态' : '实时连接中断'),
            runningNow || (live !== null && live.running === true) ? h(Pill, { tone: 'accent' }, '正在蒸馏…') : null,
            pendingPass || (live !== null && live.phase === 'queued') ? h(Pill, { tone: 'muted' }, '等待下次调度') : null,
            // Two separate facts: a model CALL wired up, and a specific model
            // chosen. Reporting the first as "未解析到模型" blamed the picker for a
            // profile that simply had no distill.command.
            distill === null ? null : h(Pill, { tone: distill.hasModel ? 'muted' : 'danger' },
              distill.hasModel ? '模型通道已就绪' : '未配置蒸馏命令'),
            distill === null || selectedModel === null ? null : h(Pill, { tone: 'muted' },
              selectedModel === null ? '跟随页面默认' : '已选定模型'),
            // Coverage is the ledger's answer to "what still has no distilled content?".
            // It is a set difference over content hashes, so it stays correct across
            // edits, restarts, and a lost ledger -- the failures that made the old
            // watermark report a healthy system that distilled nothing.
            coverage === null ? null : h(Pill, {
              tone: coverage.pending === 0 ? 'success' : 'accent',
            }, coverage.pending === 0
              ? '全部已蒸馏'
              : ('待蒸馏 ' + coverage.pending + ' / ' + coverage.scanned)),
            h('span', { style: { flex: 1 } }),
            h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.text3, fontFamily: C.mono } },
              selectedModel === null
                ? '生效：页面默认'
                : '生效：' + selectedModel.provider + '/' + selectedModel.model),
          ),

        ),
      )
    }

    /** One watched root: status dot, path, document count, remove. */
    function RootRow(props) {
      const entry = props.entry
      const [hover, setHover] = React.useState(false)
      return h('div', {
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px',
          borderRadius: C.radiusSm,
          border: '1px solid ' + C.strokeSoft,
          background: hover ? C.hover : 'transparent',
          transition: 'background 140ms ease',
        },
      },
        h('span', {
          'aria-hidden': true,
          title: entry.exists ? '目录存在' : '目录不存在',
          style: {
            width: 7, height: 7, borderRadius: 99, flex: '0 0 auto',
            background: entry.exists ? C.success : C.danger,
            boxShadow: entry.exists ? '0 0 0 3px rgba(34,197,94,0.16)' : '0 0 0 3px rgba(239,68,68,0.16)',
          },
        }),
        h('span', {
          style: {
            flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: '18px',
            fontFamily: C.mono, color: C.text, wordBreak: 'break-all',
          },
        }, entry.path),
        h(Pill, { tone: entry.exists ? 'muted' : 'danger' },
          entry.exists ? (entry.markdown + ' 篇 md') : '目录缺失'),
        h(Button, {
          variant: 'danger',
          disabled: props.busy,
          onClick: props.onRemove,
          title: '停止监听该目录（已同步的档案不会被删除）',
        }, '移除'),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: SECTION_ID,
              // Existing orders: account -10, general 0, models 10, plugins 15,
              // agent-presets 20 — 40 appends after every shipped entry.
              order: 40,
              label: () => '知识库同步',
              inject: () => ({}),
            },
            SyncMonitorSection,
          ),
        )
      },
    }
  },
})
