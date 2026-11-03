/* dsh-mnemon-sync-monitor — client half.
 *
 * A Settings page listing the watched knowledge-base roots, with add, remove,
 * and a manual rescan. It is a hand-written CommonJS factory registered into the
 * browser module loader, with no bundler and no JSX: the host serves this file
 * as-is and the loader hands it \`require\`.
 *
 * The page never reads the configuration file itself. It talks to the Host route
 * mounted by the host half (\`/mnemon-sync-monitor\`), which owns the trust fence
 * and the write.
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
        const error = new Error(body?.message ?? ('HTTP ' + response.status))
        error.code = body?.code
        error.status = response.status
        throw error
      }
      return body
    }

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 860, padding: '4px 0' },
      header: { display: 'flex', flexDirection: 'column', gap: 4 },
      title: { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: '26px' },
      hint: { margin: 0, fontSize: 12, lineHeight: '18px', opacity: 0.7 },
      list: { display: 'flex', flexDirection: 'column', gap: 8 },
      row: {
        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.28))',
        borderRadius: 8,
      },
      path: { flex: 1, fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' },
      meta: { fontSize: 12, opacity: 0.65, whiteSpace: 'nowrap' },
      inputRow: { display: 'flex', gap: 8, alignItems: 'center' },
      input: {
        flex: 1, padding: '8px 10px', fontSize: 13, borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.28))',
        background: 'transparent', color: 'inherit',
      },
      button: {
        padding: '8px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.28))',
        background: 'transparent', color: 'inherit',
      },
      primary: { borderColor: 'var(--dsw-alias-accent, #4d6bfe)', color: 'var(--dsw-alias-accent, #4d6bfe)' },
      danger: { borderColor: 'var(--dsw-alias-danger, #d9534f)', color: 'var(--dsw-alias-danger, #d9534f)' },
      badge: (ok) => ({
        fontSize: 11, padding: '2px 7px', borderRadius: 99,
        border: '1px solid ' + (ok ? 'var(--dsw-alias-success, #3c9a5f)' : 'var(--dsw-alias-danger, #d9534f)'),
        color: ok ? 'var(--dsw-alias-success, #3c9a5f)' : 'var(--dsw-alias-danger, #d9534f)',
        whiteSpace: 'nowrap',
      }),
      error: { fontSize: 12, color: 'var(--dsw-alias-danger, #d9534f)', margin: 0 },
      empty: { fontSize: 13, opacity: 0.7, padding: '12px 0' },
      footer: { fontSize: 12, opacity: 0.6, display: 'flex', flexDirection: 'column', gap: 2 },
    }

    /** The watched-roots manager. */
    function SyncMonitorSection() {
      const [state, setState] = React.useState({ loading: true, roots: [], store: null, patch: null })
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)

      const load = React.useCallback(async () => {
        try {
          const body = await api('/state')
          setState({ loading: false, roots: body.roots ?? [], store: body.store ?? null, patch: body.patch ?? null })
          setError(null)
        } catch (loadError) {
          setState((previous) => ({ ...previous, loading: false }))
          setError(loadError.message)
        }
      }, [])

      React.useEffect(() => { load() }, [load])

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

      return h('div', { style: styles.page },
        h('div', { style: styles.header },
          h('h2', { style: styles.title }, '知识库实时同步'),
          h('p', { style: styles.hint },
            '监听以下 Markdown 知识库；文件新增、修改会即时写入 dsh-mnemon 项目档案。删除的源文件默认保留档案（prune 关闭）。'),
        ),

        state.loading
          ? h('div', { style: styles.empty }, '加载中…')
          : state.roots.length === 0
            ? h('div', { style: styles.empty }, '尚未监听任何目录。在下方添加一个知识库根目录。')
            : h('div', { style: styles.list }, ...state.roots.map((entry) =>
                h('div', { key: entry.path, style: styles.row },
                  h('span', {
                    style: styles.badge(entry.exists),
                    title: entry.exists ? '目录存在' : '目录不存在',
                  }, entry.exists ? '已连接' : '缺失'),
                  h('span', { style: styles.path }, entry.path),
                  h('span', { style: styles.meta }, entry.exists ? (entry.markdown + ' 篇 md') : '—'),
                  h('button', {
                    style: { ...styles.button, ...styles.danger },
                    onClick: () => remove(entry.path),
                    disabled: busy,
                    title: '停止监听该目录（已同步的档案不会被删除）',
                  }, '移除'),
                ),
              )),

        h('div', { style: styles.inputRow },
          h('input', {
            style: styles.input,
            value: draft,
            placeholder: '输入要监听的目录绝对路径，例如 C:\\Users\\me\\Obsidian\\vault',
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') add() },
            disabled: busy,
          }),
          h('button', {
            style: { ...styles.button, ...styles.primary },
            onClick: add,
            disabled: busy || draft.trim() === '',
          }, '添加'),
          h('button', { style: styles.button, onClick: rescan, disabled: busy }, '立即扫描'),
        ),

        error === null ? null : h('p', { style: styles.error }, '错误：' + error),
        notice === null ? null : h('p', { style: styles.hint }, notice),

        h('div', { style: styles.footer },
          state.patch === null
            ? h('span', null, '未找到 profile 配置文件：改动无法持久化')
            : h('span', null, '配置写入：' + state.patch),
          state.store === null ? null : h('span', null, '档案存储：' + state.store),
          h('span', null, '注意：新同步的内容需要重开会话才能在检索中看到。'),
        ),
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
