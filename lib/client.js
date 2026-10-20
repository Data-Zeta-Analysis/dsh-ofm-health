/**
 * dsh-ofm-health — Client half.
 *
 * One compact control before the composer's submit action, opening a panel that
 * lists every model this DSH can actually offer.
 *
 * Grouping follows the **model family** (DeepSeek, GLM, GPT, Qwen …), not the
 * lane that happens to serve it: what a chooser compares is "which DeepSeek",
 * never "which free lane". Inside a family the variants of one model — the same
 * `v4.1-flash` reached through Qoder, WorkBuddy, CodeArts — sit next to each
 * other, and the working ones come first so a wall of dead free-lane rows can no
 * longer push the usable models below the fold.
 *
 * Every line reads: `model · xNN  provider  first-token · tok/s · ok/total`.
 *
 * Everything comes from the Host half's read-only snapshot route; this file
 * never re-probes and never writes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ofm-health',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const react = require('react')

    /**
     * Must match the Host half's routes.
     *
     * These sit under `/api/` so the remote channel rewrites them onto its
     * `/remote` mirror and a paired phone passes the host trust fence. A path
     * outside the rewrite table (`/plugins/...`) is fetched bare from the
     * phone, hits the fence, and 403s — which is exactly why the panel used to
     * read "尚无探测记录" on mobile.
     */
    const STATE_URL = '/api/ofm-health/state'
    const ORDER_ROUTE = '/api/ofm-health/order'
    /** Where one active test is requested. */
    const TEST_ROUTE = '/api/ofm-health/test'

    /**
     * How long one test may keep this panel waiting.
     *
     * Deliberately longer than the Host's own deadline, so a slow channel is
     * reported by the Host — with its timeout text and whatever tokens did
     * arrive — instead of being cut off here with a generic abort. CodeArts is
     * the reason a panel-side deadline exists at all: its adapter retries a
     * queued request for thirty minutes and does not honour its abort signal, so
     * without a backstop of our own one stuck row would freeze a whole sweep.
     */
    const TEST_FETCH_TIMEOUT_MS = 140000

    /**
     * The share of that deadline the Host is given, in milliseconds.
     *
     * The Host stops at `deadline − headroom` and hard-stops five seconds later;
     * this margin is what lets its answer travel back before the panel gives up
     * on waiting for it.
     */
    const TEST_HOST_HEADROOM_MS = 10000

    /**
     * How often the snapshot is re-read while a page stays open.
     *
     * The snapshot itself is cheap — it re-reads four small JSON files — so this
     * is a poll of the *evidence*, not of the models. It cannot make a dead
     * channel alive; only a real request can. That is what the test button is
     * for.
     */
    const POLL_MS = 30000

    /**
     * Where the drag order lives, and why it lives there.
     *
     * The order belongs to the person dragging, not to the machine, and the
     * panel has to keep working when the Host half is an older build that has no
     * POST route. `localStorage` satisfies both: it survives reloads, needs no
     * round trip, and cannot fail because a plugin was not reloaded yet. The Host
     * copy is a bonus — written when the route exists, so a second browser picks
     * the layout up too.
     */
    const ORDER_KEY = 'dsh-ofm-health.order.v1'

    /** Whitelist an order document, dropping anything malformed. */
    const sanitizeOrder = (raw) => {
      const list = (value, cap) => {
        if (!Array.isArray(value)) return []
        const out = []
        const seen = new Set()
        for (const item of value) {
          if (typeof item !== 'string') continue
          const id = item.trim()
          if (id === '' || seen.has(id)) continue
          seen.add(id)
          out.push(id)
          if (out.length >= cap) break
        }
        return out
      }
      const models = {}
      const source = raw?.models
      if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
        for (const [family, ids] of Object.entries(source)) {
          const key = String(family).trim()
          const cleaned = list(ids, 400)
          if (key !== '' && cleaned.length > 0) models[key] = cleaned
        }
      }
      return { families: list(raw?.families, 200), models }
    }

    /** Read the order this browser saved, or null when there is none. */
    const readStoredOrder = () => {
      try {
        const text = window.localStorage.getItem(ORDER_KEY)
        if (text === null || text === '') return null
        return sanitizeOrder(JSON.parse(text))
      } catch {
        return null
      }
    }

    /** Save the order in this browser. Returns whether the write stuck. */
    const writeStoredOrder = (order) => {
      try {
        window.localStorage.setItem(ORDER_KEY, JSON.stringify(sanitizeOrder(order)))
        return true
      } catch {
        return false
      }
    }

    /**
     * Which sections are folded, remembered per browser.
     *
     * The panel lives on a single composer seat, so every new conversation
     * remounts it. Without this the folds reset on every switch and the user
     * folds the same sections again — the exact complaint that added this key.
     * A blank object is a legitimate value ("nothing folded"), which is why the
     * reader distinguishes "no stored value" (null) from "stored nothing".
     */
    const COLLAPSE_KEY = 'dsh-ofm-health.collapsed.v1'

    /** Read the fold state. Returns null when this browser has never folded. */
    const readStoredCollapsed = () => {
      try {
        const text = window.localStorage.getItem(COLLAPSE_KEY)
        if (text === null || text === '') return null
        const parsed = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
        const out = {}
        for (const [key, value] of Object.entries(parsed)) {
          const id = String(key).trim()
          if (id !== '' && value === true) out[id] = true
        }
        return out
      } catch {
        return null
      }
    }

    /** Save the fold state in this browser. */
    const writeStoredCollapsed = (collapsed) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed))
        return true
      } catch {
        return false
      }
    }

    /**
     * The families that stay as sections of their own.
     *
     * Everything else is swept into one `mix` section, because a tail of
     * one-model families the user never opens is noise between the sections
     * they do use. `step` earns its place beside the majors; `claude` and
     * `gemini` do not, because this machine reaches them through channels that
     * are mostly dead.
     */
    const NAMED_FAMILIES = ['deepseek', 'glm', 'kimi', 'hunyuan', 'qwen', 'step', 'gpt']

    /** The section id and title the swept-up families land under. */
    const MIX_ID = 'mix'
    const MIX_NAME = '其他'

    /** Sections folded by default the first time they are seen. */
    const DEFAULT_COLLAPSED = new Set([MIX_ID])

    /**
     * Display states, and how to show them.
     *
     * `available`/`throttled`/`region-blocked`/`unavailable` come from the
     * plugin's own probe. `measured-ok`/`measured-failed` are not probes at all:
     * they are the outcome of the requests this machine actually made — from the
     * plugin's own samples for its lanes, and from the channels' request ledger
     * for the account channels, which nothing probes.
     */
    const STATES = {
      available: { name: '可用', color: 'var(--dsw-alias-state-success-primary)' },
      'measured-ok': { name: '实测可用', color: 'var(--dsw-alias-state-success-primary)' },
      throttled: { name: '限流', color: 'var(--dsw-alias-state-warn-primary)' },
      'region-blocked': { name: '地区受限', color: 'var(--dsw-alias-state-warn-primary)' },
      'measured-failed': { name: '实测失败', color: 'var(--dsw-alias-state-error-primary)' },
      unavailable: { name: '不可用', color: 'var(--dsw-alias-state-error-primary)' },
      unknown: { name: '未探测', color: 'var(--dsw-alias-state-idle-primary)' },
    }

    const stateOf = (state) => STATES[state] ?? STATES.unknown

    const HEALTHY = (state) => state === 'available' || state === 'measured-ok'

    /**
     * The short status word for the fixed status cell.
     *
     * The full names in STATES are for the tooltip: in a 56px track they would be
     * clipped to two characters, and `地区受…` reads as a different state than
     * `地区受限`. These are the shortest words that still distinguish the states.
     */
    const STATE_SHORT = {
      available: '可用',
      'measured-ok': '通',
      throttled: '限流',
      'region-blocked': '受限',
      'measured-failed': '失败',
      unavailable: '不可用',
      unknown: '未测',
    }

    const shortStateOf = (state) => STATE_SHORT[state] ?? STATE_SHORT.unknown

    /** Render a duration the way the plugin's own pages do. */
    const formatMs = (value) => {
      if (typeof value !== 'number' || !isFinite(value) || value <= 0) return null
      if (value < 1000) return `${Math.round(value)}ms`
      if (value < 10000) return `${(value / 1000).toFixed(1)}s`
      return `${Math.round(value / 1000)}s`
    }

    /**
     * Decode throughput: output tokens per second of *generation*, not per
     * second of wall clock.
     *
     * The first token can take two seconds on one channel and ninety on
     * another; dividing by the whole duration charges that wait to the model's
     * speed and reports a claim like "0.8 tok/s" for a channel that decodes at
     * 200. The channel ledger already subtracts the first-token wait, so this
     * uses the same definition and the two views finally agree.
     */
    const decodeTps = (outputTokens, ttftMs, elapsedMs) => {
      if (typeof outputTokens !== 'number' || !isFinite(outputTokens) || outputTokens <= 0) return null
      if (typeof elapsedMs !== 'number' || !isFinite(elapsedMs) || elapsedMs <= 0) return null
      // Without a first-token timestamp the whole duration is the only window
      // there is; it understates the rate, but it is still a real measurement.
      const start = typeof ttftMs === 'number' && isFinite(ttftMs) && ttftMs > 0 ? ttftMs : 0
      const decodeMs = elapsedMs - start
      // A single-token answer decodes instantly; dividing by a sub-millisecond
      // window would print an absurd number, so a floor keeps it plausible.
      if (decodeMs < 1) return null
      return Math.round((outputTokens / (decodeMs / 1000)) * 10) / 10
    }

    /**
     * Throughput for one finished test.
     *
     * The Host measures the generation window itself (`decodeMs`: first token
     * to last token) and that is the better number, so it wins whenever it
     * exists. Older Hosts only sent `ttftMs`/`elapsedMs`, which decodeTps can
     * subtract into the same quantity — so a panel talking to an un-restarted
     * Host still shows a sensible rate instead of nothing.
     */
    const testResultTps = (result) => {
      const tokens = result?.usage?.outputTokens
      if (typeof result?.decodeMs === 'number' && result.decodeMs > 0) {
        if (typeof tokens !== 'number' || !isFinite(tokens) || tokens <= 0) return null
        return Math.round((tokens / (result.decodeMs / 1000)) * 10) / 10
      }
      return decodeTps(tokens, result?.ttftMs, result?.elapsedMs)
    }

    /**
     * The rows the panel is drawing right now: the Host snapshot narrowed by
     * the search box.
     *
     * Both the renderer and the "test everything visible" sweep must agree on
     * this list, or a sweep would test rows that are not on screen.
     */
    const filteredModels = (data, filter) => {
      const all = Array.isArray(data?.models) ? data.models : []
      const search = String(filter ?? '').trim().toLowerCase()
      if (search === '') return all
      return all.filter((model) => `${model.name ?? ''} ${model.id} ${model.providerName ?? ''} ${model.provider} ${model.familyName ?? ''}`
        .toLowerCase().includes(search))
    }

    /**
     * Whether a section is expanded right now.
     *
     * `groupModels` has already normalised the id (`mix` for the swept-up
     * tail), so this takes a section id, not a family id. A search forces every
     * section open — see `panelChildren` — so a sweep with a filter running
     * covers everything that matched instead of only the open sections.
     */
    const sectionExpanded = (groupId, folds, filtering) => {
      if (filtering) return true
      return folds[groupId] !== true
    }

    /**
     * Merge a stored order into the rows that currently exist.
     *
     * The stored list is the user's order, but it is a *history*: it can lack a
     * row that appeared later (a new channel, a model the plugin discovered on
     * its own) and it can hold rows that are gone. Dropping such a row with
     * `indexOf` returned -1 and the reorder silently did nothing — which is
     * exactly why a model missing from the saved order could not be dragged at
     * all. Appending the unseen rows keeps every visible row draggable.
     */
    const mergeRows = (stored, visible) => {
      const known = Array.isArray(stored) ? stored : []
      const seen = new Set(known)
      const out = known.slice()
      for (const key of visible) {
        if (seen.has(key)) continue
        seen.add(key)
        out.push(key)
      }
      return out
    }

    /**
     * Split a provider-owned display name into the model part and its price
     * multiplier: `Deepseek-V4.1-Flash · x0.11` becomes
     * `{ model: 'Deepseek-V4.1-Flash', price: 'x0.11' }`.
     *
     * The multiplier is worth showing — it is the one number that says what a
     * turn costs on that channel — but it is not part of the model's name.
     */
    const splitName = (name, id) => {
      const raw = typeof name === 'string' && name !== '' ? name : String(id ?? '')
      const match = /^(.*?)\s*·\s*(x\s*[\d.]+.*)$/i.exec(raw)
      if (match !== null) {
        const model = match[1].trim()
        return { model: model === '' ? raw : model, price: match[2].trim() }
      }
      return { model: raw, price: null }
    }

    /** Poll the Host snapshot. */
    function useHealth() {
      const [data, setData] = react.useState(null)
      const [error, setError] = react.useState(null)
      /** Bumped to re-read immediately, without waiting for the timer. */
      const [tick, setTick] = react.useState(0)

      react.useEffect(() => {
        let alive = true
        let timer = null

        const schedule = () => {
          if (!alive) return
          timer = setTimeout(load, POLL_MS)
          timer.unref?.()
        }

        const load = () => {
          fetch(STATE_URL, {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { accept: 'application/json' },
          }).then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json()
          }).then((next) => {
            if (!alive) return
            setData(next)
            setError(null)
            schedule()
          }).catch((cause) => {
            if (!alive) return
            setError(String((cause && cause.message) || cause))
            schedule()
          })
        }

        load()
        return () => {
          alive = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [tick])

      return { data, error, reload: () => setTick((value) => value + 1) }
    }

    /**
     * Per-row active tests.
     *
     * One entry per `${provider}|${model}`: `{ state, result }`, where `state`
     * is `running`, `done`, or `failed`. Results live in this component, not in
     * the Host snapshot, because they are the answer to a click the user just
     * made; the next snapshot poll folds the same numbers in from the Host so
     * they survive a reload.
     */
    function useTests() {
      const [tests, setTests] = react.useState({})

      const run = react.useCallback((provider, model, options) => {
        const key = `${provider}|${model}`
        setTests((current) => ({ ...current, [key]: { state: 'running', startedAt: Date.now() } }))
        const timeoutMs = typeof options?.timeoutMs === 'number' && options.timeoutMs > 0
          ? options.timeoutMs
          : TEST_FETCH_TIMEOUT_MS
        // A deadline of the client's own. The Host also has one, but an adapter
        // that ignores its abort signal (CodeArts retries a queued request for
        // thirty minutes) can hold the Host route open far past it — and a sweep
        // waiting on one such row would never reach the rest.
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        const body = { provider, model }
        if (options?.effort) body.effort = options.effort
        // Ask the Host for a slightly shorter deadline, so a reachable-but-slow
        // channel is cancelled upstream and its timeout text can still travel
        // back before the panel stops waiting.
        body.timeoutMs = Math.max(1000, timeoutMs - TEST_HOST_HEADROOM_MS)
        return fetch(TEST_ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        }).finally(() => clearTimeout(timer)).then((response) => response.text().then((text) => {
          let payload = null
          try { payload = text === '' ? null : JSON.parse(text) } catch { payload = null }
          if (!response.ok) {
            // A 404/405 here is not a model failure: it means the Host half of
            // this plugin predates the test route. Saying "HTTP 405" would read
            // like the model rejected us, so name the real cause once.
            if (response.status === 404 || response.status === 405) {
              throw new Error('宿主端尚未加载测试路由，请重启 DSH')
            }
            throw new Error(payload?.error ?? `HTTP ${response.status}`)
          }
          if (payload === null) throw new Error('宿主端返回了非 JSON 响应')
          return payload
        })).then((result) => {
          setTests((current) => ({ ...current, [key]: { state: 'done', result } }))
          return result
        }).catch((cause) => {
          // An abort here means the panel's own deadline fired, which only
          // happens when the Host failed to answer within its shorter one. Saying
          // "signal is aborted" would send the user looking at the wrong layer.
          const aborted = cause?.name === 'AbortError' || controller.signal.aborted
          const message = aborted
            ? `无响应（${Math.round(timeoutMs / 1000)}s 内宿主未返回结果）`
            : String((cause && cause.message) || cause)
          setTests((current) => ({ ...current, [key]: { state: 'failed', result: { ok: false, error: message } } }))
          return { ok: false, error: message }
        })
      }, [])

      const clear = react.useCallback(() => { setTests({}) }, [])

      return { tests, run, clear }
    }

    /**
     * One model line: `model · xNN  provider  first-token · tok/s · ok/total`.
     *
     * The provider is what distinguishes two rows of the same model, so it sits
     * right after the name instead of leading. A healthy row carries no status
     * word — the dot says it — while an unusable row names its reason.
     */
    function ModelLine({ model, rank, dragging, dropTarget, test, onTest, onBeginDrag, narrow }) {
      const info = stateOf(model.state)
      const parts = splitName(model.name, model.id)
      // The drag key has to identify one row across refreshes, so it is the
      // provider plus the provider-owned id — never the display name.
      const key = `${model.provider}|${model.id}`

      // A test result wins over the snapshot for this row: the user just asked
      // the question, so the freshest answer is the one to show.
      const testResult = test?.state === 'done' ? test.result : null
      const running = test?.state === 'running'
      const live = testResult !== null ? (testResult.ok === true) : HEALTHY(model.state)
      const liveInfo = testResult !== null ? stateOf(testResult.ok === true ? 'measured-ok' : 'measured-failed') : info

      const ttft = formatMs(testResult !== null ? testResult.ttftMs : (model.lastTtftMs ?? model.probeTtftMs ?? model.probeLatencyMs))
      // Two sources, one definition: decode rate, first-token wait excluded.
      // The signed test reports its own numbers; a ledger row carries the
      // channel's average, already computed that way.
      const tps = testResult !== null
        ? testResultTps(testResult)
        : model.lastTps
      const metrics = []
      if (ttft !== null) metrics.push(`首字 ${ttft}`)
      if (typeof tps === 'number' && tps > 0) metrics.push(`${Math.round(tps)} tok/s`)
      const counts = model.calls > 0 ? `${model.calls - model.failed}/${model.calls}` : ''
      // No "刚测通 / 刚测失败" word here on purpose: the dot already turns green
      // or red and the numbers beside it come from the test, so a status word
      // only repeats what the row shows and clutters a column that has to hold
      // latency and rate.
      const meta = counts === '' ? metrics : [...metrics, counts]

      const healthy = live
      const providerText = model.providerName || model.provider
      const title = [
        liveInfo.name,
        providerText,
        model.id,
        testResult !== null && testResult.error ? testResult.error : model.detail,
      ].filter(Boolean).join(' — ')

      // On a phone the row is three narrow columns, so every one of them may
      // take a second line before it truncates. `-webkit-line-clamp` is the only
      // mechanism that both wraps and keeps a row from growing without bound;
      // it is what stops "DeepSeek-V4.1-Flash" from turning into a five-line cell
      // at 374px. The value is a string on purpose: React adds a "px" unit to a
      // bare number it does not recognise as unitless, and `-webkit-line-clamp: 2px`
      // is not a clamp at all.
      const clamp = {
        display: '-webkit-box',
        WebkitBoxOrient: 'vertical',
        WebkitLineClamp: '2',
        overflow: 'hidden',
      }

      // Column 1 — the model, and its price multiplier when the channel has one.
      // The company column only stays on one vertical line if every cell after
      // this one is fixed-width, which is why the numbers cell below is a track
      // rather than `1 1 auto`. This cell then absorbs whatever is left, and it
      // wraps rather than truncating.
      const label = react.createElement('span', {
        style: narrow
          ? { ...clamp, flex: '1 1 0', minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }
          : { flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' },
      },
        parts.model,
        parts.price !== null
          ? react.createElement('span', {
            style: { marginLeft: 4, color: 'var(--dsw-alias-label-secondary)', fontSize: 11, whiteSpace: 'nowrap' },
          }, `· ${parts.price}`)
          : null,
      )

      // Column 2 — the company. Two rows of the same model are told apart by
      // this, so it is a column of its own in both layouts, not a stray label
      // between the name and the numbers.
      //
      // Centred and fixed-width. Auto-width made every row put the company at a
      // different x — `Qoder` sits left, `CodeArts Agent` pushes right — so a
      // column of rows had no vertical line to read down and looked ragged even
      // though each row was individually fine. 110px is the width of the longest
      // name the account channels actually use (`CodeBuddy (腾讯)`).
      const provider = react.createElement('span', {
        title: providerText,
        style: narrow
          ? {
            ...clamp,
            // A fixed strip: the numbers to the right are content-sized and can
            // ask for 46% on their own, so the company gets a predictable slot
            // and truncates inside it rather than competing for the remainder.
            flex: '0 0 78px',
            minWidth: 0,
            fontSize: 11,
            color: 'var(--dsw-alias-label-secondary)',
            textAlign: 'center',
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
          }
          : {
            flex: '0 0 110px',
            minWidth: 0,
            fontSize: 11,
            color: 'var(--dsw-alias-label-secondary)',
            textAlign: 'center',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          },
      }, providerText)

      // The status word is shown for an unusable row, and also while a test
      // runs on a healthy one: otherwise clicking 测试 on a green row would
      // look like nothing happened until the answer lands.
      //
      // Two forms of the same thing. A phone folds the status into the numbers
      // cell, where there is room for the full name; the desktop row gives it a
      // 56px track of its own, which only holds the two- or three-character
      // short form — `地区受限` clipped to `地区受…` reads as a different state.
      const stateKey = testResult !== null
        ? (testResult.ok === true ? 'measured-ok' : 'measured-failed')
        : model.state
      const statusWord = healthy && !running ? null : (running ? '测试中…' : liveInfo.name)
      const statusShort = running ? '测试中…' : (healthy ? '' : shortStateOf(stateKey))

      // Column 3 — the measurements, in exactly two rows on a phone: the wait,
      // then the rate and the success ratio. Two fixed rows rather than one
      // wrapping cell, because a cell that wraps to three lines gets clamped and
      // the number that falls off the end is the one the user opened the panel
      // to read.
      const stats = react.createElement('span', {
        title: meta.join(' · '),
        style: narrow
          ? {
            // Fixed, not content-sized. The company column's x is decided by
            // everything to its left, so a numbers cell that grows with its own
            // text — `298 tok/s · 5/5` is wider than `首字 777ms` — shifts the
            // company on every row, which is the same drift the desktop layout
            // had. 88px is the width of the longer of the two lines it holds.
            flex: '0 0 88px',
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            fontSize: 10,
            lineHeight: '13px',
            color: 'var(--dsw-alias-label-secondary)',
            fontVariantNumeric: 'tabular-nums',
          }
          : {
            // A fixed track, not `1 1 auto`. Every desktop row must put the
            // company column at the same x, and that only happens when every cell
            // after the model name has a constant basis: with an auto-sized
            // numbers cell its content ate a different share of each row, so the
            // model cell — the one flexible cell — got a different width every
            // time and everything to its right drifted.
            //
            // 160px holds the longest line this cell ever draws,
            // `首字 959ms · 320 tok/s · 5/5` (~140px at 11px), with room for the
            // wider CJK glyphs. Everything here is fixed because the model cell
            // is the only flexible one: 620 − 20 padding − 48 gaps − 8 handle −
            // 6 dot − 110 company − 56 status − 160 numbers − 32 button leaves
            // 180px for the name, which fits `Deepseek-V4.1-Flash · x0.11`.
            flex: '0 0 160px',
            textAlign: 'right',
            fontSize: 11,
            color: 'var(--dsw-alias-label-secondary)',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          },
      }, narrow
        ? [
          react.createElement('span', {
            key: 'waited',
            style: {
              maxWidth: '100%',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              color: statusWord !== null ? liveInfo.color : undefined,
            },
          }, statusWord !== null
            ? statusWord
            : (ttft !== null ? `首字 ${ttft}` : '')),
          react.createElement('span', {
            key: 'rate',
            style: { maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
          }, [typeof tps === 'number' && tps > 0 ? `${Math.round(tps)} tok/s` : '', counts].filter(Boolean).join(' · ')),
        ]
        : (meta.length > 0 ? meta.join(' · ') : null))

      const isDragging = dragging === key
      const isDropTarget = dropTarget === key

      return react.createElement('div', {
        'data-ofm-drag': key,
        'data-ofm-row': key,
        'data-ofm-family': model.family,
        'data-ofm-section': model.family,
        'data-ofm-narrow': narrow ? 'true' : 'false',
        title,
        style: {
          display: 'flex',
          // Narrow rows align at the top: a two-line cell would otherwise float
          // the dot and the handle to its own middle.
          alignItems: narrow ? 'flex-start' : 'baseline',
          gap: narrow ? 4 : 8,
          padding: narrow ? '4px 10px' : '3px 10px',
          fontSize: 12,
          lineHeight: '16px',
          color: 'var(--dsw-alias-label-primary)',
          opacity: isDragging ? 0.4 : 1,
          borderTop: isDropTarget ? '2px solid var(--dsw-alias-brand-primary)' : '2px solid transparent',
        },
      },
        // The grab handle, not the whole row, starts a drag: the row also holds a
        // test button and text the user may want to select.
        react.createElement('span', {
          style: {
            flex: 'none',
            width: 8,
            alignSelf: narrow ? 'flex-start' : 'center',
            marginTop: narrow ? 1 : 0,
            fontSize: 10,
            color: 'var(--dsw-alias-label-secondary)',
            cursor: 'grab',
            // Only the handle takes pointer events, so a press anywhere else in
            // the row still selects text instead of starting a drag.
            touchAction: 'none',
          },
          onPointerDown: (event) => {
            event.stopPropagation()
            onBeginDrag(event, 'model', key, model.family)
          },
          title: '按住并拖动，可调整同组内顺序',
        }, '⠿'),
        react.createElement('span', {
          style: {
            flex: 'none',
            width: 6,
            height: 6,
            alignSelf: narrow ? 'flex-start' : 'center',
            marginTop: narrow ? 5 : 0,
            borderRadius: '50%',
            background: liveInfo.color,
            opacity: running ? 0.35 : 1,
          },
        }),
        label,
        provider,
        // Wide rows put the status word between the provider and the numbers;
        // narrow rows fold it into the numbers column instead, because a fourth
        // fixed-width cell does not fit at 374px.
        //
        // Always drawn on a wide row, even when it has nothing to say. This cell
        // is blank on every healthy row — which is most of them — and letting it
        // collapse would move the company column on exactly the broken rows the
        // user is scanning for.
        narrow
          ? null
          : react.createElement('span', {
            style: {
              flex: '0 0 56px',
              textAlign: 'center',
              fontSize: 10,
              color: running ? 'var(--dsw-alias-brand-primary)' : liveInfo.color,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
            },
          }, statusShort),
        stats,
        // Every row gets a test button. Hiding it on rows the provider registry
        // had not advertised made the panel look half-built — several rows the
        // plugin discovers on its own (ledger-only channel rows, free-lane
        // aliases) never appear in that registry. The Host now accepts any row
        // it lists, so the button can always try, and a genuinely unknown id
        // comes back as a readable 404 instead of a silently missing control.
        react.createElement('button', {
          type: 'button',
          // The row closes the popover on mousedown and carries the drag
          // handle, so the button has to stop both: a test is not a drag and
          // must not dismiss the panel the user is reading.
          draggable: false,
          onMouseDown: (event) => event.stopPropagation(),
          onClick: (event) => {
            event.stopPropagation()
            event.preventDefault()
            if (!running) onTest(model.provider, model.id)
          },
          disabled: running,
          title: running ? '正在发起一次真实请求…' : `对 ${model.provider} / ${model.id} 发起一次真实请求，测连通性与首字延迟`,
          style: {
            flex: 'none',
            alignSelf: narrow ? 'flex-start' : 'auto',
            height: 16,
            padding: '0 5px',
            fontSize: 10,
            lineHeight: '14px',
            color: running ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-brand-primary)',
            background: 'transparent',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 4,
            cursor: running ? 'default' : 'pointer',
            whiteSpace: 'nowrap',
          },
        }, running ? '…' : '测试'),
      )
    }

    /**
     * Group a flat model list by family, preserving the host's order.
     *
     * The host already sorts usable families first and keeps one model's
     * variants adjacent; this only re-buckets without re-deciding.
     */
    /**
     * Group a flat model list by family, honouring the user's own order.
     *
     * The Host already sorted the rows; this only re-buckets and then applies
     * two overrides the Host cannot know about, because they only exist once the
     * user drags something:
     *
     * - a family listed in `order.families` moves to that position;
     * - a row listed in `order.models[family]` moves to that position inside the
     *   family. Anything unlisted keeps the Host's order behind it.
     *
     * @param {Array} models - the snapshot's rows, already in Host order.
     * @param {{families: string[], models: Record<string, string[]>}} [order] - the user's drag order.
     */
    function groupModels(models, order) {
      const buckets = new Map()
      const mix = []
      for (const model of models) {
        const family = model.family ?? 'others'
        // Only the named families get a section of their own; everything else
        // is collected into one bucket rather than becoming a dozen one-model
        // sections the user has to scroll past.
        if (!NAMED_FAMILIES.includes(family)) {
          mix.push(model)
          continue
        }
        let bucket = buckets.get(family)
        if (bucket === undefined) {
          bucket = {
            id: family,
            name: model.familyName ?? family,
            usable: 0,
            models: [],
          }
          buckets.set(family, bucket)
        }
        bucket.models.push(model)
        if (HEALTHY(model.state)) bucket.usable += 1
      }

      if (mix.length > 0) {
        // The swept-up rows keep their Host order, which is already
        // worst-last, so the one model worth clicking sits at the top.
        buckets.set(MIX_ID, {
          id: MIX_ID,
          name: MIX_NAME,
          usable: mix.filter((model) => HEALTHY(model.state)).length,
          models: mix,
        })
      }

      const groups = [...buckets.values()]

      // Row order inside each family.
      const pinned = order?.models ?? {}
      for (const group of groups) {
        const list = pinned[group.id]
        if (!Array.isArray(list) || list.length === 0) continue
        const rankOf = (model) => {
          const index = list.indexOf(`${model.provider}|${model.id}`)
          return index === -1 ? list.length : index
        }
        group.models = group.models
          .map((model, index) => ({ model, index, rank: rankOf(model) }))
          .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.index - b.index))
          .map((entry) => entry.model)
      }

      // Section order. `mix` is swept-up leftovers, so it always sits last: a
      // dragged position for it would only interleave the noise the merge
      // exists to remove.
      const familyOrder = Array.isArray(order?.families) ? order.families : []
      const rankOfFamily = (group) => {
        if (group.id === MIX_ID) return Number.MAX_SAFE_INTEGER
        const index = familyOrder.indexOf(group.id)
        return index === -1 ? familyOrder.length : index
      }
      return groups
        .map((group, index) => ({ group, index, rank: rankOfFamily(group) }))
        .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.index - b.index))
        .map((entry) => entry.group)
    }

    /**
     * Move one item to a new slot, returning a new array.
     *
     * `to` is the slot the pointer is over, in the *original* array. Removing
     * the item first shifts later slots down by one, so inserting at the raw
     * `to` puts a downward drag just *after* the hovered row and an upward drag
     * just *before* it — which is what the pointer is asking for. An earlier
     * `to - 1` correction for the downward case collapsed a one-row drag onto
     * itself and left the list unchanged.
     */
    const moveItem = (list, from, to) => {
      const next = list.slice()
      const [item] = next.splice(from, 1)
      if (item === undefined) return list
      const target = Math.max(0, Math.min(next.length, to))
      next.splice(target, 0, item)
      return next
    }

    /**
     * Start one pointer-driven reorder.
     *
     * Native HTML5 drag-and-drop is not used: a React re-render inside
     * `dragstart` cancels the native session, so a `setState` there makes the
     * row undraggable. A touch screen never opens a native session at all.
     * Here the drag belongs to this panel — the pointer is captured on the
     * handle and `pointermove`/`pointerup`/`pointercancel` live on `document`
     * in the capture phase, so the gesture survives re-renders and leaving the
     * row.
     *
     * The caller owns all mutable state and passes it in, which keeps the
     * gesture testable without mounting React.
     */
    function startPointerDrag(options) {
      const { event, kind, key, family } = options
      const { dragCleanup, dragRef, dragTimer, setDrag, wrapRef } = options
      const { listModels, listOrder, applyDrop } = options

      if (dragCleanup.current !== null) return
      if (event.pointerType === 'mouse' && event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()

      const startX = event.clientX
      const startY = event.clientY
      const pointerId = event.pointerId
      const handle = event.currentTarget
      try { handle.setPointerCapture(pointerId) } catch { /* capture is optional */ }

      let active = false
      let over = null

      // What the pointer is over right now. A row drag may only land on a row
      // of its own family; a section drag lands on a section header or
      // anywhere inside that section.
      const targetAt = (x, y) => {
        const node = document.elementFromPoint(x, y)
        if (node === null || typeof node.closest !== 'function') return null
        if (kind === 'group') {
          const head = node.closest('[data-ofm-group]')
          if (head !== null) return { key: head.getAttribute('data-ofm-group') }
          const row = node.closest('[data-ofm-section]')
          if (row !== null) return { key: row.getAttribute('data-ofm-section') }
          return null
        }
        const row = node.closest('[data-ofm-row]')
        if (row === null) return null
        if (row.getAttribute('data-ofm-family') !== family) return null
        return { key: row.getAttribute('data-ofm-row') }
      }

      // Nudging the panel when the pointer nears its edge: on a phone the
      // list is taller than the screen and the drag cannot scroll it.
      const edgeScroll = (y) => {
        const panel = wrapRef.current?.querySelector?.('[data-ofm-health-panel]')
        if (!panel) return
        const rect = panel.getBoundingClientRect()
        const margin = 28
        if (y < rect.top + margin) panel.scrollTop -= 12
        else if (y > rect.bottom - margin) panel.scrollTop += 12
      }

      const onMove = (moveEvent) => {
        if (moveEvent.pointerId !== pointerId) return
        if (!active) {
          // A few pixels of slack keep a plain press from reordering a row.
          if (Math.abs(moveEvent.clientX - startX) < 3 && Math.abs(moveEvent.clientY - startY) < 3) return
          active = true
          dragRef.current = { kind, key, family: family ?? null, over: null }
          setDrag(dragRef.current)
          document.body.style.cursor = 'grabbing'
          document.body.style.userSelect = 'none'
        }
        moveEvent.preventDefault()
        edgeScroll(moveEvent.clientY)
        over = targetAt(moveEvent.clientX, moveEvent.clientY)?.key ?? null
        if (dragRef.current !== null && dragRef.current.over !== over) {
          dragRef.current = { ...dragRef.current, over }
          setDrag(dragRef.current)
        }
      }

      const finish = (upEvent) => {
        if (upEvent !== null && upEvent.pointerId !== pointerId) return
        document.removeEventListener('pointermove', onMove, true)
        document.removeEventListener('pointerup', finish, true)
        document.removeEventListener('pointercancel', finish, true)
        dragCleanup.current = null
        try { handle.releasePointerCapture(pointerId) } catch { /* already released */ }
        if (dragTimer.current !== null) {
          clearTimeout(dragTimer.current)
          dragTimer.current = null
        }
        dragRef.current = null
        setDrag(null)
        if (!active) return
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        if (over === null) return
        const models = listModels()
        const visibleFamilies = groupModels(models, listOrder() ?? undefined).map((group) => group.id)
        const visibleRows = kind === 'model'
          ? models.filter((model) => model.family === family)
            .map((model) => `${model.provider}|${model.id}`)
          : []
        applyDrop(kind, key, over, family, visibleFamilies, visibleRows)
      }

      dragCleanup.current = () => finish(null)
      document.addEventListener('pointermove', onMove, true)
      document.addEventListener('pointerup', finish, true)
      document.addEventListener('pointercancel', finish, true)
    }

    /** Group header: click to collapse, with the usable ratio on the right. */
    function GroupHeader({ group, collapsed, onToggle, dragging, dropTarget, onBeginDrag }) {
      const dead = group.usable === 0
      const isDragging = dragging === group.id
      const isDropTarget = dropTarget === group.id
      return react.createElement('div', {
        'data-ofm-drag': group.id,
        'data-ofm-group': group.id,
        'data-ofm-section': group.id,
        onClick: onToggle,
        title: dead ? '这一组目前没有任何可用或实测可用的模型' : undefined,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 10px 2px',
          fontSize: 11,
          lineHeight: '14px',
          fontWeight: 600,
          color: dead
            ? 'var(--dsw-alias-label-secondary)'
            : 'var(--dsw-alias-label-primary)',
          opacity: isDragging ? 0.4 : dead ? 0.65 : 1,
          borderTop: isDropTarget ? '2px solid var(--dsw-alias-brand-primary)' : '2px solid transparent',
          cursor: 'pointer',
          userSelect: 'none',
        },
      },
        // The handle starts the drag; a press anywhere else folds the section.
        react.createElement('span', {
          style: {
            flex: 'none',
            width: 8,
            cursor: 'grab',
            color: 'var(--dsw-alias-label-secondary)',
            touchAction: 'none',
          },
          onPointerDown: (event) => {
            event.stopPropagation()
            onBeginDrag(event, 'group', group.id, null)
          },
          title: '按住并拖动，可调整分组顺序',
        }, '⠿'),
        react.createElement('span', { style: { flex: 'none', width: 8 } }, collapsed ? '▸' : '▾'),
        react.createElement('span', {
          style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, group.name),
        react.createElement('span', {
          style: {
            flex: 'none',
            fontVariantNumeric: 'tabular-nums',
            fontWeight: 400,
            color: dead ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
          },
        }, dead ? `${group.usable}/${group.models.length} 全部不可用` : `${group.usable}/${group.models.length}`),
      )
    }

    /** Build the popover's children from one snapshot. */
    function panelChildren(data, error, filter, collapsed, toggle, narrow = false) {
      const children = []
      const drag = toggle.drag ?? null
      const tests = toggle.tests ?? {}
      const onTest = toggle.test ?? (() => {})
      // The order to draw with: the user's drag order once there is one, else
      // whatever the Host sent. `toggle.order` wins because it is the copy this
      // panel is actively editing.
      const order = toggle.order ?? data?.order ?? null

      const search = filter.trim().toLowerCase()
      children.push(react.createElement('div', {
        key: 'search',
        style: { padding: '0 10px 6px' },
      }, react.createElement('input', {
        type: 'text',
        value: filter,
        placeholder: '筛选模型或厂商…',
        onChange: (event) => toggle.search(event.target.value),
        style: {
          width: '100%',
          boxSizing: 'border-box',
          height: 24,
          padding: '0 8px',
          fontSize: 11,
          color: 'var(--dsw-alias-label-primary)',
          background: 'var(--dsw-alias-bg-layer-1)',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 6,
          outline: 'none',
        },
      })))

      // One button that folds every section at once, and its inverse. Without
      // it, closing a long list means clicking every header in turn.
      const allCollapsed = toggle.allCollapsed === true
      children.push(react.createElement('div', {
        key: 'fold-all',
        style: { display: 'flex', justifyContent: 'flex-end', padding: '0 10px 6px' },
      }, react.createElement('button', {
        type: 'button',
        onClick: () => (allCollapsed ? toggle.expandAll() : toggle.collapseAll()),
        title: allCollapsed ? '展开全部模型分组' : '收起全部模型分组',
        style: {
          height: 20,
          padding: '0 8px',
          fontSize: 10,
          lineHeight: '18px',
          color: 'var(--dsw-alias-label-secondary)',
          background: 'transparent',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 4,
          cursor: 'pointer',
        },
      }, allCollapsed ? '展开全部' : '收起全部')))

      const ip = data?.egress?.ip
      children.push(react.createElement('div', {
        key: 'head',
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 10px 6px',
          fontSize: 10,
          lineHeight: '14px',
          color: 'var(--dsw-alias-label-secondary)',
        },
      },
        react.createElement('span', {
          style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, ip ? ip : ''),
        react.createElement('button', {
          type: 'button',
          onMouseDown: (event) => event.stopPropagation(),
          onClick: (event) => { event.stopPropagation(); toggle.refresh?.() },
          title: '立即重新读取宿主的健康快照（不会发起真实请求）',
          style: {
            flex: 'none',
            height: 16,
            padding: '0 5px',
            fontSize: 10,
            lineHeight: '14px',
            color: 'var(--dsw-alias-label-secondary)',
            background: 'transparent',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 4,
            cursor: 'pointer',
          },
        }, '刷新'),
        react.createElement('button', {
          type: 'button',
          onMouseDown: (event) => event.stopPropagation(),
          onClick: (event) => { event.stopPropagation(); toggle.testAll?.() },
          disabled: toggle.testingAll === true,
          title: '对当前展开的分组里每个模型各发一次真实请求（较慢，会产生真实调用）',
          style: {
            flex: 'none',
            height: 16,
            padding: '0 5px',
            fontSize: 10,
            lineHeight: '14px',
            color: toggle.testingAll === true ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-brand-primary)',
            background: 'transparent',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 4,
            cursor: toggle.testingAll === true ? 'default' : 'pointer',
          },
        }, toggle.testingAll === true ? '测试中…' : '测试展开项'),
        // The sweep is long by nature — dozens of real requests — so it needs a
        // way out that does not mean closing the panel.
        toggle.testingAll === true
          ? react.createElement('button', {
            type: 'button',
            onMouseDown: (event) => event.stopPropagation(),
            onClick: (event) => { event.stopPropagation(); toggle.stopTestAll?.() },
            title: '停止正在进行的批量测试（已经测完的行会保留结果）',
            style: {
              flex: 'none',
              height: 16,
              padding: '0 5px',
              fontSize: 10,
              lineHeight: '14px',
              color: 'var(--dsw-alias-state-error-primary)',
              background: 'transparent',
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: 4,
              cursor: 'pointer',
            },
          }, '停止')
          : null,
      ))

      if (error) {
        children.push(react.createElement('div', {
          key: 'error',
          style: { padding: '4px 10px 6px', fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' },
        }, error))
      }
      if (data?.catalogError) {
        children.push(react.createElement('div', {
          key: 'catalog-error',
          style: { padding: '4px 10px 6px', fontSize: 10, color: 'var(--dsw-alias-label-secondary)' },
        }, `供应商清单读取异常：${data.catalogError}`))
      }

      const all = Array.isArray(data?.models) ? data.models : null
      if (all === null) {
        if (!error) {
          children.push(react.createElement('div', {
            key: 'loading',
            style: { padding: '4px 10px 6px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
          }, '正在读取…'))
        }
        return children
      }

      const models = filteredModels(data, filter)

      if (models.length === 0) {
        children.push(react.createElement('div', {
          key: 'empty',
          style: { padding: '4px 10px 6px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
        }, `没有匹配 “${filter}” 的模型`))
      }

      for (const group of groupModels(models, order)) {
        const isCollapsed = search === '' && collapsed[group.id] === true
        children.push(react.createElement(GroupHeader, {
          key: `group:${group.id}`,
          group,
          collapsed: isCollapsed,
          dragging: drag?.kind === 'group' ? drag.key : null,
          dropTarget: drag?.kind === 'group' ? drag.over : null,
          onToggle: () => toggle.group(group.id),
          onBeginDrag: toggle.beginDrag,
        }))
        if (isCollapsed) continue
        for (const model of group.models) {
          const testKey = `${model.provider}|${model.id}`
          children.push(react.createElement(ModelLine, {
            key: `${group.id}|${model.provider}|${model.id}`,
            model,
            test: tests[testKey],
            onTest,
            dragging: drag?.kind === 'model' ? drag.key : null,
            dropTarget: drag?.kind === 'model' ? drag.over : null,
            onBeginDrag: toggle.beginDrag,
            narrow,
          }))
        }
      }

      const counts = data?.counts
      if (counts) {
        const tally = [
          ['可用', counts.available],
          ['实测可用', counts.measuredOk],
          ['限流', counts.throttled],
          ['未探测', counts.unknown],
          ['不可用', counts.unavailable + counts.measuredFailed],
          ['地区受限', counts.regionBlocked],
        ].filter(([, value]) => value > 0).map(([label, value]) => `${label} ${value}`)

        const save = toggle.saveState
        const saveLabel = save === null || save === undefined
          ? '拖动排序会自动保存在本浏览器'
          : save.state === 'saving'
            ? '正在保存顺序…'
            : save.state === 'saved'
              ? save.synced === true
                ? '顺序已保存（本机 + 宿主）'
                : '顺序已保存'
              : `顺序保存失败：${save.message ?? ''}`

        children.push(react.createElement('div', {
          key: 'legend',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 6,
            padding: '6px 10px 0',
            borderTop: '1px solid var(--dsw-alias-border-l1)',
            fontSize: 10,
            lineHeight: '14px',
            color: 'var(--dsw-alias-label-secondary)',
          },
        },
          react.createElement('span', { style: { flex: '1 1 auto' } }, tally.join(' · ')),
          react.createElement('span', {
            style: {
              flex: 'none',
              color: save?.state === 'error'
                ? 'var(--dsw-alias-state-error-primary)'
                : 'var(--dsw-alias-label-secondary)',
            },
          }, saveLabel),
          react.createElement('button', {
            type: 'button',
            onClick: () => toggle.resetOrder(),
            title: '清除手动排序，回到自动顺序',
            style: {
              flex: 'none',
              padding: '0 6px',
              height: 18,
              fontSize: 10,
              lineHeight: '16px',
              color: 'var(--dsw-alias-label-secondary)',
              background: 'transparent',
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: 4,
              cursor: 'pointer',
              display: (order?.families?.length ?? 0) > 0
                || Object.keys(order?.models ?? {}).length > 0
                ? 'inline-block'
                : 'none',
            },
          }, '重置排序'),
        ))
      }

      return children
    }

    /** The panel's natural width, and the gap it keeps from the viewport edges. */
    const PANEL_WIDTH = 620
    const PANEL_MARGIN = 8
    /** Vertical strip left free above and below a centred panel (see panelStyle). */
    const CENTERED_KEEP_OUT = 24

    /**
     * Below this width one row is drawn as three stacked-friendly columns.
     *
     * A row has to hold four things — the model, the company, the numbers and a
     * test button — and about 300px of that is text. At 620px they fit on one
     * line; on a phone they do not, and squeezing them onto one line truncates
     * every one of them: "Lobste…", "首字 777ms · …". So the same row is laid out
     * as three cells that each get two lines, which is the only arrangement that
     * shows a full model name and its full numbers at 374px.
     */
    const NARROW_BREAKPOINT = 560

    /**
     * Where the popover goes for one measured trigger box.
     *
     * The panel is anchored to the right edge of its trigger, which is correct
     * while the viewport is wider than the panel. A phone is not: at 390px the
     * anchor puts the panel's LEFT edge at `390 - 8 - 620 = -238px`, so the whole
     * sheet hangs off the left side of the screen and every row reads as a
     * clipped strip. When the panel cannot fit beside its trigger, centre it on
     * the viewport and cap it to the width that exists — the only placement that
     * keeps both columns of every row on screen.
     * @param box - the trigger's measured rect.
     * @param viewport - `{ width, height }` in CSS pixels.
     */
    /**
     * Whether a row has to fall back to the three-column phone layout.
     *
     * Keyed to the panel's width rather than the viewport's: the panel is what a
     * row has to fit inside, and it stays 620 until the window is narrower than
     * that. Above 636px viewport the panel is 620 and rows keep one line; below
     * it the panel shrinks with the window and rows switch to the stacked cells.
     * @param viewport - `{ width, height }` in CSS pixels.
     */
    function panelNarrow(viewport) {
      const width = Math.min(PANEL_WIDTH, Math.max(200, viewport.width - PANEL_MARGIN * 2))
      return width < NARROW_BREAKPOINT
    }

    function panelStyle(box, viewport) {
      const width = Math.min(PANEL_WIDTH, Math.max(200, viewport.width - PANEL_MARGIN * 2))
      const centered = viewport.width < PANEL_WIDTH + PANEL_MARGIN * 2
      const style = {
        position: 'fixed',
        zIndex: 2147483000,
        width,
        overflowY: 'auto',
        padding: '8px 0',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-overlay)',
        boxShadow: '0 10px 32px rgba(0, 0, 0, .22)',
        textAlign: 'left',
        boxSizing: 'border-box',
      }
      if (centered) {
        // Anchoring is meaningless when the panel is wider than the space the
        // anchor leaves: pin it to the middle of the viewport instead, and cap
        // the height against the viewport rather than against the trigger.
        //
        // The cap deliberately stops short of the full viewport. A centred
        // panel that spans edge to edge has nowhere left to tap, and tapping
        // outside is the only way to close it on a phone — the trigger it hangs
        // off is underneath the panel by then. Leaving a strip above and below
        // keeps that dismissal, and keeps the composer in view.
        style.left = '50%'
        style.top = '50%'
        style.transform = 'translate(-50%, -50%)'
        style.maxHeight = Math.max(160, viewport.height - CENTERED_KEEP_OUT * 2)
      } else {
        // Anchor to the trigger's right edge, but never let the panel leave the
        // viewport: a trigger near the left edge would otherwise push the panel
        // past the left side, which looks exactly like a menu glued to the left.
        const wanted = Math.max(PANEL_MARGIN, viewport.width - box.right)
        const ceiling = viewport.width - width - PANEL_MARGIN
        style.right = Math.max(PANEL_MARGIN, Math.min(wanted, ceiling))
        style.bottom = Math.max(PANEL_MARGIN, viewport.height - box.top + 6)
        style.maxHeight = Math.max(160, Math.min(560, box.top - 24))
      }
      return style
    }

    function HealthPanel() {
      const { data, error, reload } = useHealth()
      const { tests, run } = useTests()
      const [open, setOpen] = react.useState(false)
      const [box, setBox] = react.useState(null)
      const [filter, setFilter] = react.useState('')
      // Whether a "test every visible model" sweep is running, and how far it
      // has got. Kept separate from the per-row map so the header can show it.
      const [testingAll, setTestingAll] = react.useState(false)
      // Flipped by the stop button. A sweep checks it between rows; the row in
      // flight is left to finish or time out on its own deadline rather than
      // being abandoned mid-request.
      const stopSweep = react.useRef(false)
      // Folds are read lazily: the first render of a fresh mount happens before
      // the storage read, so `null` means "not loaded yet" and is replaced by
      // the stored value (or the defaults) in the effect below.
      const [collapsed, setCollapsed] = react.useState(null)
      // The live drag: what is being dragged, which family a dragged model came
      // from, and what it is currently hovering over.
      //
      // The payload is mirrored into a ref because the authoritative copy must
      // be readable *synchronously* from the document-level pointer handlers,
      // while the state copy only drives the dimmed row and the drop-target
      // line. The ref is the truth; a render that has not committed yet must
      // never decide where a drop lands.
      const [drag, setDrag] = react.useState(null)
      const dragRef = react.useRef(null)
      const dragTimer = react.useRef(null)
      // Tears down the document listeners of an in-flight pointer drag.
      const dragCleanup = react.useRef(null)
      // The order this panel is showing. It starts from the Host's snapshot and
      // takes over the moment the user drags something, so a background refresh
      // cannot undo a drag in progress.
      const [order, setOrder] = react.useState(null)
      const [saveState, setSaveState] = react.useState(null)
      const wrapRef = react.useRef(null)
      const buttonRef = react.useRef(null)

      // Restore the folds once per mount, so switching conversations no longer
      // expands everything the user just folded away.
      react.useEffect(() => {
        if (collapsed !== null) return
        const stored = readStoredCollapsed()
        if (stored !== null) {
          setCollapsed(stored)
          return
        }
        const defaults = {}
        for (const id of DEFAULT_COLLAPSED) defaults[id] = true
        setCollapsed(defaults)
        writeStoredCollapsed(defaults)
      }, [collapsed])

      /** Fold state, with the defaults standing in until storage is read. */
      const folds = collapsed ?? Object.fromEntries([...DEFAULT_COLLAPSED].map((id) => [id, true]))

      /** Change one fold and persist the whole document. */
      const setFold = (id) => {
        const next = { ...folds }
        if (next[id] === true) delete next[id]
        else next[id] = true
        setCollapsed(next)
        writeStoredCollapsed(next)
      }

      // Adopt the saved order immediately, so a reload shows the user's layout
      // without waiting for a round trip.
      react.useEffect(() => {
        if (order !== null) return
        const stored = readStoredOrder()
        if (stored !== null) setOrder(stored)
        else {
          // Nothing dragged on this browser yet: adopt whatever the Host has,
          // so a machine that never drags still honours a shared copy.
          const incoming = data?.order
          if (incoming !== undefined && incoming !== null) {
            setOrder({
              families: Array.isArray(incoming.families) ? incoming.families : [],
              models: incoming.models ?? {},
            })
          }
        }
      }, [data, order])

      /**
       * Persist one order document.
       *
       * The browser is the authority. `localStorage` is written first and is
       * what the panel re-reads on the next mount, so dragging works even when
       * the Host half is an older build with no POST route. The Host is then
       * told on a best-effort basis — a failure there is reported as "saved
       * locally" rather than as a failure, because the user's drag did take
       * effect and will survive a reload.
       */
      const persist = (next) => {
        setOrder(next)
        const written = writeStoredOrder(next)
        setSaveState(written
          ? { state: 'saved', at: Date.now() }
          : { state: 'error', message: '浏览器存储不可用，刷新后会丢失' })

        fetch(ORDER_ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(next),
        }).then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response.json()
        }).then((body) => {
          if (body?.order !== undefined) setOrder(body.order)
          setSaveState({ state: 'saved', at: Date.now(), synced: true })
        }).catch((cause) => {
          // Local storage already holds the order; the Host copy is optional.
          setSaveState(written
            ? { state: 'saved', at: Date.now(), synced: false, message: `仅本地保存（${String((cause && cause.message) || cause)}）` }
            : { state: 'error', message: String((cause && cause.message) || cause) })
        })
      }

      /**
       * Apply a drop. `families` is the section order; `models[family]` is the
       * row order inside one family. Dragging a family reorders sections only;
       * dragging a row reorders that row inside its own family, so a drag can
       * never move a model into a family it does not belong to.
       */
      const applyDrop = (kind, from, to, family, visibleFamilies, visibleRows) => {
        if (from === null || to === null || from === to) return
        const next = order ?? { families: [], models: {} }

        if (kind === 'group') {
          // The stored list is only a starting point: a family that appeared
          // after the last drag is not in it, and an `indexOf` miss used to
          // abort the drop outright. Merging keeps every drawn section movable.
          const current = mergeRows(next.families, visibleFamilies)
          const fromIndex = current.indexOf(from)
          const toIndex = current.indexOf(to)
          if (fromIndex === -1 || toIndex === -1) return
          persist({ ...next, families: moveItem(current, fromIndex, toIndex) })
          return
        }

        if (family === undefined || family === null) return
        // Same reason as the section branch, one level down: a row that is not
        // in the saved order yet (a new provider, a ledger-only channel row)
        // could not be dragged until the order happened to be regenerated.
        const current = mergeRows(next.models[family], visibleRows)
        const fromIndex = current.indexOf(from)
        const toIndex = current.indexOf(to)
        if (fromIndex === -1 || toIndex === -1) return
        persist({
          ...next,
          models: { ...next.models, [family]: moveItem(current, fromIndex, toIndex) },
        })
      }

      const toggle = {
        search: (value) => setFilter(value),
        group: (id) => setFold(id),
        // Collapse or expand every section at once. Named families only: `mix`
        // is the sweep-up bucket and folding it with the rest would hide the
        // whole tail behind two clicks.
        collapseAll: () => {
          const next = {}
          for (const id of NAMED_FAMILIES) next[id] = true
          setCollapsed(next)
          writeStoredCollapsed(next)
        },
        expandAll: () => {
          setCollapsed({})
          writeStoredCollapsed({})
        },
        collapsed: folds,
        allCollapsed: NAMED_FAMILIES.every((id) => folds[id] === true),
        drag,
        order,
        saveState,
        resetOrder: () => {
          setSaveState(null)
          persist({ families: [], models: {} })
        },
        // A press on a grab handle starts a pointer drag; see startPointerDrag.
        beginDrag: (event, kind, key, family) => startPointerDrag({
          event,
          kind,
          key,
          family,
          dragCleanup,
          dragRef,
          dragTimer,
          setDrag,
          wrapRef,
          listModels: () => (Array.isArray(data?.models) ? data.models : []),
          listOrder: () => order,
          applyDrop,
        }),
        tests,
        test: (provider, model) => {
          run(provider, model).then(() => {
            // A finished test is also new evidence the Host now holds, so the
            // snapshot is re-read to keep the two views from disagreeing.
            reload()
          })
        },
        testingAll,
        refresh: () => reload(),
        stopTestAll: () => {
          // The in-flight row is not cancelled. It has its own deadline, and an
          // abandoned POST would keep burning a channel slot while the sweep
          // pretended to have stopped.
          stopSweep.current = true
        },
        testAll: () => {
          if (testingAll) return
          // Only the rows the user can actually see: the expanded sections,
          // narrowed by the search box. Testing collapsed groups made the sweep
          // spend most of its time on rows nobody was looking at, and made it
          // impossible to test a single chosen group by folding the rest.
          const search = filter.trim().toLowerCase()
          const visible = []
          for (const group of groupModels(filteredModels(data, filter), order)) {
            if (!sectionExpanded(group.id, folds, search !== '')) continue
            for (const model of group.models) visible.push(model)
          }
          if (visible.length === 0) return
          setTestingAll(true)
          stopSweep.current = false
          // Sequential on purpose: four concurrent tests already saturate most
          // channels, and a serial sweep shows progress row by row.
          let index = 0
          const step = () => {
            if (stopSweep.current || index >= visible.length) {
              stopSweep.current = false
              setTestingAll(false)
              reload()
              return
            }
            const model = visible[index]
            index += 1
            run(model.provider, model.id).then(step, step)
          }
          step()
        },
      }

      react.useEffect(() => {
        if (!open) return undefined

        const measure = () => {
          const node = buttonRef.current
          if (node) setBox(node.getBoundingClientRect())
        }
        const onPointerDown = (event) => {
          const node = wrapRef.current
          if (node && !node.contains(event.target)) setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }

        measure()
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, true)
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          window.removeEventListener('resize', measure)
          window.removeEventListener('scroll', measure, true)
          document.removeEventListener('mousedown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      const counts = data?.counts ?? null
      const ok = counts ? (counts.usable ?? counts.available) : 0
      const total = counts ? counts.total : 0
      const tone = error
        ? 'var(--dsw-alias-state-error-primary)'
        : counts === null
          ? 'var(--dsw-alias-state-idle-primary)'
          : ok > 0
            ? 'var(--dsw-alias-state-success-primary)'
            : 'var(--dsw-alias-state-error-primary)'

      const trigger = react.createElement('button', {
        ref: buttonRef,
        type: 'button',
        'aria-expanded': open,
        onClick: () => setOpen((value) => !value),
        title: error
          ? `our-free-model 健康数据读取失败：${error}`
          : 'our-free-model：选择模型前查看连通性与速度',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 26,
          padding: '0 8px',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 6,
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          fontSize: 11,
          lineHeight: 1,
          fontVariantNumeric: 'tabular-nums',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        },
      },
        react.createElement('span', {
          style: { width: 6, height: 6, borderRadius: '50%', flex: 'none', background: tone },
        }),
        react.createElement('span', null, 'OFM'),
        react.createElement('span', {
          style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 },
        }, counts ? `${ok}/${total}` : '—'),
      )

      let popover = null
      if (open && box) {
        const viewport = { width: window.innerWidth, height: window.innerHeight }
        popover = react.createElement('div', {
          'data-ofm-health-panel': '',
          'data-ofm-narrow': panelNarrow(viewport) ? 'true' : 'false',
          style: panelStyle(box, viewport),
        }, panelChildren(data, error, filter, folds, toggle, panelNarrow(viewport)))
      }

      return react.createElement('span', {
        ref: wrapRef,
        style: { position: 'relative', display: 'inline-flex' },
      }, trigger, popover)
    }

    /**
     * Client plugin body: claim one composer toolbar slot.
     * @param ctx - client root context carrying the slot registry.
     */
    function apply(ctx) {
      ctx.effect(
        () => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'ofm-health',
          order: 30,
          label: () => 'Our Free Model 健康度',
        }, (props) => react.createElement(HealthPanel, props))),
        'ofm-health: model health panel',
      )
    }

    const inject = ['slots']

    exports.apply = apply
    exports.inject = inject
    // Render helpers, exposed so the package can be smoke-tested without a
    // browser. Nothing here is used by the shell.
    exports.__test = {
      panelChildren,
      panelStyle,
      panelNarrow,
      groupModels,
      moveItem,
      startPointerDrag,
      sanitizeOrder,
      readStoredOrder,
      writeStoredOrder,
      readStoredCollapsed,
      writeStoredCollapsed,
      ORDER_KEY,
      COLLAPSE_KEY,
      NAMED_FAMILIES,
      MIX_ID,
      MIX_NAME,
      DEFAULT_COLLAPSED,
      formatMs,
      decodeTps,
      testResultTps,
      splitName,
      filteredModels,
      sectionExpanded,
      mergeRows,
      TEST_FETCH_TIMEOUT_MS,
      TEST_HOST_HEADROOM_MS,
      STATES,
      HEALTHY,
      STATE_URL,
      ORDER_ROUTE,
      TEST_ROUTE,
      POLL_MS,
    }
    return module.exports
  },
})
