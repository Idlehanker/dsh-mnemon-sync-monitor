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
      // Ledger coverage: { scanned, distilled, pending, roots }. Null until /state answers.
      const [coverage, setCoverage] = React.useState(null)

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
          if (body.distill && body.distill.coverage && typeof body.distill.coverage.scanned === 'number') {
            setCoverage(body.distill.coverage)
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

      React.useEffect(() => { load(); loadModels() }, [load, loadModels])

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
            h(Button, { disabled: busy, onClick: rescan, title: '立即重新扫描所有已监听目录', style: { flex: '0 0 auto' } }, '立即扫描'),
          ),

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

          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            h(Pill, { tone: distillEnabled ? 'success' : 'muted' }, distillEnabled ? '已开启' : '已关闭'),
            distill === null ? null : h(Pill, { tone: distill.automatic ? 'accent' : 'muted' },
              distill.automatic ? '自动调度' : '仅手动触发'),
            runningNow ? h(Pill, { tone: 'accent' }, '正在蒸馏…') : null,
            pendingPass ? h(Pill, { tone: 'muted' }, '等待下次调度') : null,
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

          // Ledger progress. Distillation is per-note, so a bar is the honest shape:
          // the number of documents with no distilled content right now.
          coverage === null ? null : h('div', {
            style: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 2 },
          },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
              h('span', { style: { ...font(12, 500, '18px'), color: C.text2 } }, '蒸馏覆盖率'),
              h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.text3, fontFamily: C.mono } },
                coverage.distilled + ' / ' + coverage.scanned),
              h('span', { style: { flex: 1 } }),
              coverage.pending === 0
                ? h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.success } }, '全部完成')
                : h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.text3 } },
                    '剩余 ' + coverage.pending + ' 篇待蒸馏'),
            ),
            h('div', {
              role: 'progressbar',
              'aria-valuemin': 0,
              'aria-valuemax': coverage.scanned,
              'aria-valuenow': coverage.distilled,
              style: {
                height: 6, borderRadius: 99, overflow: 'hidden',
                background: C.inset,
                border: '1px solid ' + C.strokeSoft,
              },
            },
              h('div', {
                style: {
                  width: (coverage.scanned === 0
                    ? 0
                    : Math.round((coverage.distilled / coverage.scanned) * 100)) + '%',
                  height: '100%',
                  background: coverage.pending === 0 ? C.success : C.accent,
                  transition: 'width 320ms ease',
                },
              }),
            ),
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
