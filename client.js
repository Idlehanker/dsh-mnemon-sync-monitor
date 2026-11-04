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
      section: {
        display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px',
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.28))',
        borderRadius: 8,
      },
      sectionTitle: { margin: 0, fontSize: 13, fontWeight: 600 },
      switchRow: { display: 'flex', alignItems: 'center', gap: 10 },
      switchLabel: { fontSize: 13, cursor: 'pointer', userSelect: 'none' },
      checkbox: { width: 16, height: 16, cursor: 'pointer', accentColor: 'var(--dsw-alias-accent, #4d6bfe)' },
      select: {
        flex: 1, padding: '8px 10px', fontSize: 13, borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.28))',
        background: 'transparent', color: 'inherit',
      },
    }

    /** The watched-roots manager. */
    function SyncMonitorSection() {
      const [state, setState] = React.useState({ loading: true, roots: [], store: null, patch: null, env: null, attempts: [] })
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      // The model list comes ONLY from /models, which is the same ctx.llm catalog
      // the main composer's model picker renders. No second list is kept here.
      const [models, setModels] = React.useState([])
      const [selectedModel, setSelectedModel] = React.useState(null) // { provider, model } | null
      const [pendingModel, setPendingModel] = React.useState('')
      const [distillEnabled, setDistillEnabled] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          const body = await api('/state')
          setState({
            loading: false,
            roots: body.roots ?? [],
            store: body.store ?? null,
            patch: body.patch ?? null,
            env: body.env ?? null,
            attempts: body.attempts ?? [],
          })
          if (body.distill && typeof body.distill.enabled === 'boolean') {
            setDistillEnabled(body.distill.enabled)
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
          const list = body.models ?? []
          setModels(list)
          const selected = body.selected ?? null
          setSelectedModel(selected)
          setPendingModel(selected === null ? '' : JSON.stringify([selected.provider, selected.model]))
        } catch (modelError) {
          // A provider outage must not hide the roots manager; show the reason in
          // the model section instead of failing the whole page.
          setModels([])
          setError((previous) => previous ?? ('模型列表加载失败：' + modelError.message))
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
          // Trust the Host's response, not the optimistic value: a failed
          // persist must not show a switch that is actually still off.
          setDistillEnabled(typeof body.status?.enabled === 'boolean' ? body.status.enabled : next)
          setNotice(next ? '蒸馏已开启，后续知识库变更将自动入库' : '蒸馏已关闭，待执行的调度已取消')
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

        // Distillation model picker. Options come from the composer's own
        // catalog (ctx.llm), the same list shown under the main input box.
        // Switching persists to the profile patch, so it survives restarts.
        // Master switch for the distillation sidecar. Flips the live value in the
        // Host, so no restart is needed; the choice is also persisted.
        h('div', { style: styles.switchRow },
          h('input', {
            type: 'checkbox',
            style: styles.checkbox,
            checked: distillEnabled,
            disabled: busy,
            onChange: (event) => toggleEnabled(event.target.checked),
            title: '开启后，知识库变更会经模型蒸馏写入 Memory Space',
          }),
          h('span', { style: styles.switchLabel },
            distillEnabled ? '语义蒸馏：已开启' : '语义蒸馏：已关闭'),
          h('span', { style: styles.meta },
            distillEnabled ? '变更自动入库' : '仅同步 Documents'),
        ),

        h('div', { style: styles.section },
          h('p', { style: styles.sectionTitle }, '语义蒸馏模型'),
          h('p', { style: styles.hint },
            '知识库变更后用该模型把笔记蒸馏成结论写入 Memory Space。模型列表与主输入框底部同源；provider 变更导致模型下架时在此切换即可，无需改配置文件。'),
          h('div', { style: styles.inputRow },
            h('select', {
              style: styles.select,
              value: pendingModel,
              onChange: (event) => setPendingModel(event.target.value),
              disabled: busy || models.length === 0,
            },
              h('option', { value: '' }, '跟随页面默认（推荐：当前免费模型）'),
              ...models.map((entry) =>
                h('option', { key: entry.value, value: entry.value },
                  '[' + entry.providerName + '] ' + entry.name + ' · ' + entry.model),
              ),
            ),
            h('button', {
              style: { ...styles.button, ...styles.primary },
              onClick: saveModel,
              disabled: busy || models.length === 0,
            }, '保存模型'),
            h('button', {
              style: styles.button,
              onClick: loadModels,
              disabled: busy,
              title: 'provider 变化后重新拉取可用模型',
            }, '刷新'),
          ),
          selectedModel === null
            ? h('span', { style: styles.hint }, '当前：跟随默认')
            : h('span', { style: styles.hint },
                '当前：' + selectedModel.provider + '/' + selectedModel.model),
          models.length === 0
            ? h('span', { style: styles.error }, '当前没有可用模型，请检查主输入框的模型列表。')
            : null,
        ),
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
          // Show why resolution failed, so a report says "env never arrived" or
          // "file missing" instead of leaving the reader to guess.
          state.patch === null && state.env !== null
            ? h('span', { style: { fontSize: 11, opacity: 0.75 } },
                '诊断 · DSH_HOME=' + String(state.env.DSH_HOME)
                + ' · DSH_PROFILE=' + String(state.env.DSH_PROFILE)
                + ' · DSH_PROFILE_DIR=' + String(state.env.DSH_PROFILE_DIR))
            : null,
          state.patch === null && state.attempts.length > 0
            ? h('span', { style: { fontSize: 11, opacity: 0.75 } },
                '尝试路径：' + state.attempts.map((a) => a.source + (a.exists ? '(存在)' : '(不存在)')).join(' / '))
            : null,
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