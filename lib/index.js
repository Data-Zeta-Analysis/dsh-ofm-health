/**
 * dsh-ofm-health — Host half.
 *
 * The `dsh-our-free-model` plugin already measures everything a model picker
 * needs: which models answer, how long the first token takes, and the decode
 * rate of real requests. It keeps that in its own data directory and shows it
 * in its own settings pages — nowhere near the composer, which is where the
 * choice is actually made.
 *
 * This package adds exactly one thing: a same-origin, cookie-authenticated
 * read-only route that folds those sources into one flat JSON snapshot, which
 * lib/client.js renders next to the model selector.
 *
 * Three sources are folded together, and they never overwrite each other:
 *
 *   1. The LLM registry (`llm.listProviders()` / `llm.listModels()`), which is
 *      the authoritative list of what the picker can actually offer. This is
 *      the only place the account channels (CodeArts, CodeBuddy, WorkBuddy,
 *      LobsterAI, Qoder, Raccoon, ZCode …) appear: they are registered by the
 *      same plugin but are absent from its catalog file.
 *   2. `dsh-our-free-model`'s own probe results and request samples, which
 *      cover its free lane, Kilo pool, EAC rows and region route.
 *   3. `channel-pack/token-ledger.json`, the per-provider/per-model request
 *      ledger the channels maintain — the only honest health evidence for a
 *      channel model, since nothing probes those.
 *
 * A probe result is labelled as a probe; a real request outcome is labelled as
 * measured. The two are reported in separate fields and never merged into one
 * invented number.
 *
 * The only thing this file writes is its own heartbeat (see HEARTBEAT_FILE),
 * which exists so a running install can be told apart from a stale one. It
 * never writes to the data directory, the credentials store or DSH config.
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** This cordis plugin's name. */
const name = 'ofm-health'

/** Composition services this plugin needs: a route table and the trust fence. */
const inject = ['webServer', 'connection']

/**
 * The single route this package adds.
 *
 * It lives under `/api/` — not `/plugins/` — because that is the only path
 * family the remote-channel rewrite table knows about. A phone reaching the
 * host from the LAN or the relay is a *non-loopback* client, so every
 * `connection.requestRejection` in this file returns 403 unless the request
 * arrives through the paired remote channel, which only rewrites `/api/*`
 * (plus `/sidebar`, `/git`, `/pet`) onto its `/remote` mirror. A route under
 * `/plugins/` is never rewritten, so the phone's fetch hits the fence bare and
 * the panel can only ever show an empty list.
 */
const STATE_ROUTE = '/api/ofm-health/state'

/** Bumped on every behaviour change, so a live install is identifiable. */
const BUILD = 'ofm-health/7'

/**
 * Persisted user ordering, next to the heartbeat.
 *
 * Two levels, because the panel has two: `families` is the section order, and
 * `models` maps a family id to the row order inside it. Both are arrays of ids
 * the panel has already shown — an id that disappears simply stops matching, and
 * a model that was never dragged keeps the automatic order behind the dragged
 * ones.
 */
const ORDER_FILE = 'ofm-health/order.json'

/** Where the client posts a new order. */
const ORDER_ROUTE = '/api/ofm-health/order'

/** Where the client asks for one real request to be made. */
const TEST_ROUTE = '/api/ofm-health/test'

/**
 * What an active test asks the model to do.
 *
 * It has to produce *enough* tokens to measure throughput: an answer of two
 * tokens divided by the first-token wait reported "0.8 tok/s" for channels that
 * decode at 200. Counting is cheap, deterministic, needs no world knowledge,
 * and still yields a few dozen tokens on every model including the ones that
 * only reason.
 */
const TEST_PROMPT = '请从 1 数到 40，只输出数字，用英文逗号分隔。'

/** Output cap for a test: room for a short reasoning pass plus the answer. */
const TEST_MAX_TOKENS = 200

/** Default ceiling on one test; the caller may ask for more (CodeArts can be slow). */
const TEST_TIMEOUT_MS = 120000

/**
 * How long past its own deadline a test may still hold the route open.
 *
 * The abort signal asks the adapter to stop; some adapters do not listen. This
 * grace period is the difference between "we asked" and "we answered anyway".
 * Kept short: everything worth reporting has already been recorded by then.
 */
const HARD_STOP_GRACE_MS = 5000

/** Ceiling on how many tests may run at once across the whole process. */
const TEST_CONCURRENCY = 4

/** Tests currently running, so a click storm cannot open dozens of streams. */
let testsInFlight = 0

/**
 * Every `${provider}|${model}` the last snapshot put on screen.
 *
 * The registry is the wrong authority for whether a row may be tested. A
 * channel row that only the token ledger knows about, or a free-lane alias the
 * plugin discovered itself, is shown in the panel but is not advertised by
 * `llm.listProviders()` — and hiding its button (or answering 404) made those
 * rows untestable for a reason the user cannot see. What the panel lists, the
 * panel may test; the adapter still answers honestly for an id it cannot serve.
 */
let lastKnownRoutes = new Set()

/** How many raw request samples are kept for the "last measured" columns. */
const SAMPLE_WINDOW = 400

/** How long the provider catalog from the `llm` service is reused. */
const CATALOG_TTL_MS = 5 * 60 * 1000

/** Per-provider ceiling on `llm.listModels()` (some adapters fetch upstream). */
const PROVIDER_TIMEOUT_MS = 12000

/** Hard ceiling on rendered rows, so a runaway registry cannot blow the panel up. */
const MAX_ROWS = 2500

/** Relative path of the liveness heartbeat, under the DSH home. */
const HEARTBEAT_FILE = 'ofm-health/heartbeat.json'

/** Models exposed through the region route instead of the main one. */
const REGION_IDS = new Set(['beam-free'])

/** The two provider routes `dsh-our-free-model` registers natively. */
const OFM_MAIN = 'our-free-model'
const OFM_REGION = 'our-free-model-region'

/** Providers that are DSH's own, not this plugin's lanes. */
const OFFICIAL_PROVIDERS = new Set(['deepseek-official', 'deepseek-account'])

/**
 * Model families, in the order the panel lists them.
 *
 * The panel groups by family rather than by lane, because the lane is an
 * implementation detail: what a chooser actually compares is "which DeepSeek"
 * and "which GLM", not "which free lane".
 *
 * The first six are the user's explicit order — DeepSeek, GLM, Kimi, HY, GPT,
 * Qwen — and everything after them is a stable alphabetical-ish tail rather than
 * a second opinion. Order here only decides ties; a family with a working model
 * still floats above one with none (see `familyOrderOf`).
 */
const FAMILIES = [
  { id: 'deepseek', name: 'DeepSeek', match: /deepseek|deep-seek/ },
  { id: 'glm', name: 'GLM', match: /glm|chatglm|zhipu|bigmodel/ },
  { id: 'kimi', name: 'Kimi', match: /kimi|moonshot/ },
  // `HY` is Hunyuan's short name in every channel's own model list, so both the
  // long and short spellings must land in this family.
  { id: 'hunyuan', name: 'HY (Hunyuan)', match: /hunyuan|(?:^|[^a-z])hy\d|hy\d-(?:preview|flash)|[^a-z]hy[^a-z0-9]/ },
  { id: 'gpt', name: 'GPT', match: /gpt|openai\/|^o[134](?:-|$)|codex/ },
  { id: 'qwen', name: 'Qwen', match: /qwen|tongyi/ },
  { id: 'claude', name: 'Claude', match: /claude|anthropic/ },
  { id: 'gemini', name: 'Gemini', match: /gemini|google\// },
  { id: 'grok', name: 'Grok', match: /grok|xai\// },
  { id: 'minimax', name: 'MiniMax', match: /minimax/ },
  { id: 'step', name: 'Step', match: /^step-|stepfun|step-5/ },
  { id: 'mimo', name: 'MiMo', match: /mimo/ },
  { id: 'nemotron', name: 'Nemotron', match: /nemotron/ },
  { id: 'llama', name: 'Llama', match: /llama/ },
  { id: 'mistral', name: 'Mistral', match: /mistral|codestral|devstral/ },
  { id: 'cohere', name: 'Cohere', match: /cohere|command-/ },
  { id: 'sensenova', name: 'SenseNova', match: /sensenova|sn-/ },
  { id: 'poolside', name: 'Poolside', match: /laguna|poolside/ },
  { id: 'liquid', name: 'Liquid', match: /lfm-|liquid\// },
  { id: 'dots', name: 'Dots', match: /dots-/ },
  { id: 'inkling', name: 'Inkling', match: /inkling|thinkingmachines/ },
  { id: 'longcat', name: 'LongCat', match: /longcat/ },
  { id: 'xingchen', name: 'Xingchen', match: /xing/ },
  { id: 'others', name: '其他', match: null },
]

/** Family id → display order, derived once. */
const FAMILY_ORDER = new Map(FAMILIES.map((family, index) => [family.id, index]))
const FAMILY_BY_ID = new Map(FAMILIES.map((family) => [family.id, family]))

/** Tokens that describe a route or a price, not a model. */
const VARIANT_NOISE = new Set([
  'free', 'sn', 'plus', 'preview', 'auto', 'default', 'model', 'fast', 'balanced',
  'primary', 'deep', 'cli', 'ai', 'the', 'and', 'of', 'new', 'hot', 'x', 'eac',
])

/**
 * A variant cluster counts as live when its best member is at least "measured
 * ok" — i.e. some concrete evidence says this model answered. `throttled` and
 * `unknown` do not qualify.
 */
const CLUSTER_LIVE_STATE = 1

/**
 * Collapse a model id + display name into the key two rows share when they are
 * the same underlying model reached through different providers.
 *
 * The vendor prefix, a `· x0.11` price multiplier, a `-free` suffix and the
 * `v4.1` / `v4-1` / `v4 1` spelling splits are all removed here, so
 * `sn-deepseek-v4-1-flash`, `opencode/deepseek-v4.1-flash-free` and
 * `deepseek-v4.1-flash` land in one bucket.
 *
 * The id and the display name are both folded in, because either one may be the
 * one carrying the real model name: a channel often advertises `dfmodel` and
 * spells the model out only in the name, while an aggregate lane does the
 * reverse. Tokens are then deduplicated and sorted, so the two spellings of one
 * model produce the same key regardless of order.
 *
 * @param {string} id - the provider-owned model id.
 * @param {string} name - the display name the provider advertises.
 * @returns {string} the clustering key.
 */
function variantKey(id, name) {
  const tail = typeof id === 'string' && id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : String(id ?? '')
  let text = `${tail} ${name ?? ''}`.toLowerCase()

  // Price multipliers and arrows are decoration, not identity.
  text = text.replace(/·\s*x\s*[\d.]+.*$/g, ' ')
  text = text.replace(/x\s*\d+(?:\.\d+)?\s*(?:→|->).*$/g, ' ')
  text = text.replace(/(?:→|->).*$/g, ' ')

  // Version spelling: `v4.1`, `v4-1`, `v4_1` and `v4 1` all mean 41.
  text = text.replace(/v(\d+)[.\-_ ](\d+)/g, 'v$1$2')
  text = text.replace(/\b(\d+)\.(\d+)\b/g, '$1$2')

  // Everything else that is not a letter or digit is a separator.
  text = text.replace(/[^a-z0-9]+/g, ' ')

  const tokens = new Set()
  for (const token of text.split(' ')) {
    if (token === '' || VARIANT_NOISE.has(token)) continue
    tokens.add(token)
  }
  return [...tokens].sort().join(' ').slice(0, 80)
}

/**
 * Which family a model belongs to.
 * @returns the family entry (always defined; `others` is the fallback).
 */
function familyOf(id, name) {
  const haystack = `${id} ${name}`.toLowerCase()
  for (const family of FAMILIES) {
    if (family.match !== null && family.match.test(haystack)) return family
  }
  return FAMILY_BY_ID.get('others')
}

/** The DSH home that holds both data directories. */
function dshHome() {
  return process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

/**
 * Candidate data directories, in resolution order.
 *
 * `dsh-our-free-model` resolves its own home from `DSH_HOME` (falling back to
 * `~/.dsh`) and appends `our-free-model`; the profile-relative and env-var
 * candidates are here so a relocated or per-profile install still resolves.
 */
function dataDirCandidates() {
  const candidates = []
  if (process.env.DSH_OFM_DATA_DIR !== undefined && process.env.DSH_OFM_DATA_DIR !== '') {
    candidates.push(process.env.DSH_OFM_DATA_DIR)
  }
  candidates.push(join(dshHome(), 'our-free-model'))
  if (process.env.DSH_PROFILE_DIR !== undefined && process.env.DSH_PROFILE_DIR !== '') {
    candidates.push(join(process.env.DSH_PROFILE_DIR, 'our-free-model'))
  }
  candidates.push(join(homedir(), '.dsh', 'our-free-model'))
  return candidates
}

/**
 * Pick the first candidate that actually holds a probe result.
 * @returns the resolved data directory, or the first candidate when none exists.
 */
async function resolveDataDir() {
  const candidates = dataDirCandidates()
  for (const dir of candidates) {
    try {
      await stat(join(dir, 'availability.json'))
      return dir
    } catch {
      // Not this one; keep looking.
    }
  }
  return candidates[0]
}

/**
 * Where the account channels keep their ledger and account state.
 * @returns the channel-pack directory under the DSH home.
 */
async function resolveChannelDir() {
  const direct = join(dshHome(), 'channel-pack')
  try {
    await stat(join(direct, 'state.json'))
    return direct
  } catch {
    // Fall through to the per-profile location used by relocated installs.
  }
  if (process.env.DSH_PROFILE_DIR !== undefined && process.env.DSH_PROFILE_DIR !== '') {
    const profile = join(process.env.DSH_PROFILE_DIR, 'channel-pack')
    try {
      await stat(join(profile, 'state.json'))
      return profile
    } catch {
      // Not there either; report the default so the panel can say so.
    }
  }
  return direct
}

/**
 * Read and parse one JSON file.
 * @returns the parsed value, or `undefined` when missing or malformed.
 */
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Modification time of one file, in epoch milliseconds.
 *
 * This is the only honest timestamp for the two evidence files: they are
 * rewritten whenever a request is recorded, so their mtime is an upper bound on
 * "when the newest evidence inside them was written". A ledger bucket is keyed
 * by calendar day, so the bucket itself cannot say what time a call happened —
 * using its date's midnight as `lastAt` is what made a fresh request still read
 * as "9 小时前".
 *
 * @returns the mtime, or `undefined` when the file cannot be stat'ed.
 */
async function fileMtime(file) {
  try {
    const info = await stat(file)
    return info.mtimeMs
  } catch {
    return undefined
  }
}

/** Coerce a value to a finite number, or a fallback. */
function numberOr(value, fallback) {
  return typeof value === 'number' && isFinite(value) ? value : fallback
}

/** Reject after `ms` so one slow provider cannot stall the catalog refresh. */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    timer.unref?.()
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/* ------------------------------------------------------------------ *
 * The provider catalog, straight from the composition's LLM registry.
 * ------------------------------------------------------------------ */

/** Resolves the `llm` service once the composition provides it. */
let llmOf = null

/** Last successful catalog: `{ at, providers: [{ id, name, models }], error }`. */
let catalog = { at: 0, providers: [], error: undefined }

/** In-flight refresh, so overlapping callers share one sweep. */
let catalogRefresh = null

/**
 * Refresh the provider catalog from `llm.listProviders()` /
 * `llm.listModels()`. Never throws, never blocks a caller: the result lands in
 * `catalog` and every reader uses whatever is cached right now.
 * @returns the in-flight refresh promise (already running, if one is).
 */
function refreshCatalog() {
  const llm = llmOf === null ? undefined : llmOf()
  if (llm === undefined || llm === null) return catalogRefresh
  if (catalogRefresh !== null) return catalogRefresh

  catalogRefresh = Promise.resolve()
    .then(() => llm.listProviders())
    .then(async (providers) => {
      const list = Array.isArray(providers) ? providers : []
      const rows = await Promise.all(list.map(async (provider) => {
        const id = provider !== null && typeof provider === 'object' && typeof provider.id === 'string'
          ? provider.id
          : ''
        if (id === '') return null
        let models = []
        try {
          models = await withTimeout(llm.listModels(id), PROVIDER_TIMEOUT_MS)
        } catch {
          models = []
        }
        return {
          id,
          name: typeof provider.name === 'string' && provider.name !== '' ? provider.name : id,
          models: Array.isArray(models)
            ? models
              .filter((model) => model !== null && typeof model === 'object' && typeof model.id === 'string')
              .map((model) => ({
                id: model.id,
                name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
              }))
            : [],
        }
      }))
      catalog = { at: Date.now(), providers: rows.filter((row) => row !== null), error: undefined }
    })
    .catch((error) => {
      catalog = { ...catalog, at: catalog.at === 0 ? Date.now() : catalog.at, error: String((error && error.message) || error) }
    })
    .finally(() => { catalogRefresh = null })

  return catalogRefresh
}

/* ------------------------------------------------------------------ *
 * Active testing: make one real request and report what happened.
 *
 * The snapshot route can only report evidence that already exists. For a
 * channel model nothing probes, that evidence may be hours old or absent
 * entirely, which is exactly what "the panel never updates" means. This is the
 * one place the panel can produce new evidence on demand: a real call through
 * the same `llm` service the agent uses, so it exercises the same adapter, the
 * same credentials and the same route a real turn would.
 *
 * It never writes to the data directory or the ledger: the result is returned to
 * the caller and, optionally, kept in memory as a probe for that row. A test
 * therefore cannot corrupt what the plugin's own measurements say.
 * ------------------------------------------------------------------ */

/** In-memory results of active tests, keyed `${provider}|${model}`. */
const testResults = new Map()

/** How many test results are remembered before the oldest is dropped. */
const TEST_RESULTS_CAP = 500

/**
 * Record one test result, dropping the oldest when the map is full.
 * @param key - `${provider}|${model}`.
 * @param result - the result to remember.
 */
function rememberTest(key, result) {
  testResults.set(key, result)
  while (testResults.size > TEST_RESULTS_CAP) {
    const oldest = testResults.keys().next()
    if (oldest.done === true) break
    testResults.delete(oldest.value)
  }
}

/** Turn an error into the one line a row can show. */
function errorText(error) {
  if (error === null || error === undefined) return 'unknown error'
  const code = typeof error.code === 'string' && error.code !== '' ? error.code : null
  const message = typeof error.message === 'string' && error.message !== '' ? error.message : String(error)
  return code === null ? message : `${code}: ${message}`
}

/**
 * Make one real request and measure it.
 *
 * Every path ends in a result object rather than an exception, because a failed
 * test is a successful measurement: "this route does not answer" is the answer.
 *
 * @param llm - the composition's `llm` service.
 * @param request - `{ provider, model, effort?, timeoutMs? }`.
 * @returns `{ provider, model, ok, at, elapsedMs, ttftMs, text, usage, error }`.
 */
async function runTest(llm, request) {
  const provider = request.provider
  const model = request.model
  const startedAt = Date.now()
  const result = {
    provider,
    model,
    ok: false,
    at: startedAt,
    elapsedMs: 0,
    ttftMs: null,
    text: '',
    usage: undefined,
    error: undefined,
  }

  if (testsInFlight >= TEST_CONCURRENCY) {
    result.error = `同时进行的测试已达上限（${TEST_CONCURRENCY}），请稍后再试`
    result.elapsedMs = Date.now() - startedAt
    return result
  }

  const timeoutMs = typeof request.timeoutMs === 'number' && isFinite(request.timeoutMs) && request.timeoutMs > 0
    ? Math.min(request.timeoutMs, 600000)
    : TEST_TIMEOUT_MS

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  timer.unref?.()

  testsInFlight += 1
  let sawToken = false
  // The generation window, measured from the first token to the last one.
  // Throughput is a property of decoding, not of the queue wait in front of it,
  // so the first-token latency must not be charged to it — a channel that waits
  // 90 s and then streams at 150 tok/s would otherwise read "0.5 tok/s".
  let firstTokenAt = null
  let lastTokenAt = null
  let finish

  // The abort above is advisory. A channel that ignores it — CodeArts retries a
  // queued request every ten seconds for up to thirty minutes, and its
  // `delay(ms, signal)` resolves on abort instead of rejecting — would hold this
  // route open long past the deadline and stall whatever sweep is waiting on it.
  // So the read loop runs inside a race with a hard deadline of its own: the
  // signal asks the adapter to stop, this is what happens when it does not.
  let hardStop = () => {}
  const hardDeadline = new Promise((resolve) => { hardStop = resolve })
  const hardTimer = setTimeout(() => {
    timedOut = true
    controller.abort()
    hardStop()
  }, timeoutMs + HARD_STOP_GRACE_MS)
  hardTimer.unref?.()

  try {
    const options = {
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: TEST_PROMPT }] }],
      maxTokens: TEST_MAX_TOKENS,
      // A stable per-model session, so a channel that fingerprints a
      // conversation does not see a new conversation on every click.
      sessionId: `ofm-health:test:${provider}:${model}`,
      signal: controller.signal,
    }
    if (typeof request.effort === 'string' && request.effort !== '') options.reasoningEffort = request.effort

    const consume = (async () => {
      for await (const chunk of llm.stream(options)) {
        if (chunk === null || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
          const hasText = typeof chunk.text === 'string' && chunk.text !== ''
          if (sawToken === false && hasText) {
            sawToken = true
            result.ttftMs = Date.now() - startedAt
            firstTokenAt = Date.now()
          }
          if (hasText) lastTokenAt = Date.now()
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') result.text += chunk.text
        } else if (chunk.type === 'usage') {
          result.usage = chunk.usage
        } else if (chunk.type === 'finish') {
          finish = chunk.reason
        }
      }
    })()
    // The abandoned consumer must not become an unhandled rejection when the
    // adapter finally gives up after we already answered the user.
    consume.catch(() => {})
    await Promise.race([consume, hardDeadline])
  } catch (error) {
    result.error = errorText(error)
  } finally {
    clearTimeout(timer)
    clearTimeout(hardTimer)
    testsInFlight -= 1
  }

  result.elapsedMs = Date.now() - startedAt
  // Decode window, in the same definition the channel ledger uses
  // (`pack.js:32205`: outputTokens / (duration - ttft)): from the first token to
  // the last one, so the first-token wait is not charged to decoding speed.
  if (firstTokenAt !== null) {
    const last = lastTokenAt ?? firstTokenAt
    result.decodeMs = Math.max(0, last - firstTokenAt)
  }

  if (result.error === undefined && finish !== undefined) {
    if (finish.kind === 'error') result.error = errorText(finish.failure)
    else if (finish.kind === 'aborted') result.error = timedOut ? `超时（${timeoutMs}ms 无结果）` : '请求被取消'
  }
  // A timeout usually surfaces as an aborted stream first. Say "timeout", not
  // the adapter's generic abort text: the user asked for a deadline, and that
  // deadline is the reason, not an incidental cancellation.
  if (timedOut) result.error = `超时（${timeoutMs}ms 无结果）`

  // A model that only reasons and never emits text still answered: the request
  // reached it and it produced tokens. Calling that a failure would mislabel
  // every thinking-first model on this machine.
  result.ok = result.error === undefined
  if (result.text.length > 2000) result.text = result.text.slice(0, 2000)
  return result
}

/* ------------------------------------------------------------------ *
 * Evidence sources.
 * ------------------------------------------------------------------ */

/** Pull the advertised model ids out of `catalog.json`. */
function rosterIds(catalogFile) {
  const free = new Set()
  const kilo = new Set()
  const into = (target, value) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') target.add(item)
        else if (item !== null && typeof item === 'object' && typeof item.id === 'string') target.add(item.id)
      }
    }
  }
  into(free, catalogFile?.entries)
  into(kilo, catalogFile?.kiloRows)
  return { free, kilo }
}

/** Keep only the most recent recorded run per model. */
function latestByModel(samples) {
  const latest = new Map()
  if (!Array.isArray(samples)) return latest
  for (const sample of samples.slice(-SAMPLE_WINDOW)) {
    const id = sample?.model
    if (typeof id !== 'string' || id === '') continue
    const previous = latest.get(id)
    if (previous === undefined || (sample.at ?? 0) >= (previous.at ?? 0)) latest.set(id, sample)
  }
  return latest
}

/**
 * Fold `channel-pack/token-ledger.json` into one aggregate per provider+model.
 *
 * The ledger buckets by day, keyed `<mode>|<provider>|<account>|<model>`, so the
 * same model reached through two accounts (or through the gateway) has to be
 * summed before it can describe the model.
 *
 * @returns a Map keyed `${provider}|${model}`.
 */
function parseLedger(ledger) {
  const out = new Map()
  const days = ledger?.days
  if (days === null || typeof days !== 'object') return out
  for (const [day, bucket] of Object.entries(days)) {
    if (bucket === null || typeof bucket !== 'object') continue
    for (const [key, value] of Object.entries(bucket)) {
      if (value === null || typeof value !== 'object') continue
      const parts = key.split('|')
      if (parts.length < 4) continue
      const provider = parts[1]
      const model = parts.slice(3).join('|')
      if (provider === '' || model === '') continue
      const id = `${provider}|${model}`
      let acc = out.get(id)
      if (acc === undefined) {
        acc = {
          provider,
          model,
          requests: 0,
          errors: 0,
          input: 0,
          output: 0,
          ttftSumMs: 0,
          ttftCount: 0,
          tpsSum: 0,
          tpsCount: 0,
          day: '',
        }
        out.set(id, acc)
      }
      if (typeof day === 'string' && day > acc.day) acc.day = day
      acc.requests += numberOr(value.requests, 0)
      acc.errors += numberOr(value.errors, 0)
      acc.input += numberOr(value.inputTokens, 0)
      acc.output += numberOr(value.outputTokens, 0)
      acc.ttftSumMs += numberOr(value.ttftSumMs, 0)
      acc.ttftCount += numberOr(value.ttftCount, 0)
      acc.tpsSum += numberOr(value.tpsSum, 0)
      acc.tpsCount += numberOr(value.tpsCount, 0)
    }
  }
  return out
}

/** A day bucket is a date, so its instant is that day's UTC midnight. */
function dayToMs(day) {
  if (typeof day !== 'string' || day === '') return undefined
  const ms = Date.parse(day)
  return isFinite(ms) ? ms : undefined
}

/** Rank a display state for sorting: usable first, unusable last. */
function rank(state) {
  if (state === 'available') return 0
  if (state === 'measured-ok') return 1
  if (state === 'throttled') return 2
  if (state === 'unknown') return 3
  if (state === 'measured-failed') return 4
  if (state === 'region-blocked') return 5
  return 6
}

/**
 * Decide what to show for one model.
 *
 * The free lane is probed by `dsh-our-free-model`, so its models carry a real
 * probe state. The Kilo pool, EAC rows, aggregates and combos are deliberately
 * left unprobed by that plugin, and the account channels are not probed by
 * anything at all — for those the only honest evidence is the outcome of the
 * requests actually recorded, reported as `measured-*` and kept distinct from a
 * probe so the two are never confused.
 */
function displayState(probeState, measured) {
  if (typeof probeState === 'string' && probeState !== '' && probeState !== 'unknown') return probeState
  if (measured !== undefined && measured.ok === true) return 'measured-ok'
  if (measured !== undefined && measured.ok === false) return 'measured-failed'
  return 'unknown'
}

/**
 * Fold every source into one snapshot.
 *
 * Every column is best-effort: a model advertised by the registry with no probe
 * and no recorded request still appears, as `unknown`.
 *
 * @returns the snapshot the client renders.
 */
async function snapshot() {
  const dir = await resolveDataDir()
  const channelDir = await resolveChannelDir()
  const ledgerFile = join(channelDir, 'token-ledger.json')
  const statsFile = join(dir, 'stats.json')
  const [availability, catalogFile, stats, ledger, userOrder, ledgerAt, statsAt] = await Promise.all([
    readJson(join(dir, 'availability.json')),
    readJson(join(dir, 'catalog.json')),
    readJson(statsFile),
    readJson(ledgerFile),
    readOrder(),
    fileMtime(ledgerFile),
    fileMtime(statsFile),
  ])

  // The registry sweep is monotonic and cached; this call only ever warms it.
  refreshCatalog()

  const results = availability?.results ?? {}
  const dayTotals = stats?.models ?? {}
  const latest = latestByModel(stats?.samples)
  const ledgerRows = parseLedger(ledger)
  const { free: freeIds, kilo: kiloIds } = rosterIds(catalogFile)

  const providerNames = new Map()
  for (const provider of catalog.providers) providerNames.set(provider.id, provider.name)

  /** The provider route a bare data-directory id belongs to. */
  const laneProvider = (id) => (REGION_IDS.has(id) ? OFM_REGION : OFM_MAIN)

  /** Which lane a row came from — kept as a per-row tag, no longer a grouping. */
  const laneFor = (provider, id) => {
    if (REGION_IDS.has(id) || provider === OFM_REGION) return 'region'
    if (provider === OFM_MAIN) {
      if (kiloIds.has(id)) return 'kilo'
      if (freeIds.has(id)) return 'free'
      return 'eac'
    }
    if (OFFICIAL_PROVIDERS.has(provider)) return 'official'
    return 'channel'
  }

  const rows = new Map()
  const ensure = (provider, id, display) => {
    const key = `${provider}|${id}`
    let row = rows.get(key)
    if (row === undefined) {
      row = { id, provider, name: display ?? id }
      rows.set(key, row)
    } else if (display !== undefined && display !== '' && display !== row.id) {
      row.name = display
    }
    return row
  }

  // 1. Everything the picker can actually offer, from the LLM registry.
  for (const provider of catalog.providers) {
    for (const model of provider.models) ensure(provider.id, model.id, model.name)
  }

  // 2. The plugin's own lanes, which its catalog file advertises even when the
  //    registry drops an unusable row.
  const discovery = new Set([...freeIds, ...kiloIds, ...Object.keys(results), ...Object.keys(dayTotals)])
  for (const id of discovery) ensure(laneProvider(id), id, undefined)

  // 3. Channel rows the ledger knows about but the registry no longer offers.
  for (const aggregate of ledgerRows.values()) {
    ensure(aggregate.provider, aggregate.model, undefined)
  }

  const models = []
  for (const row of rows.values()) {
    if (models.length >= MAX_ROWS) break
    const probe = results[row.id] ?? {}
    const totals = dayTotals[row.id] ?? {}
    const last = latest.get(row.id)
    const aggregate = ledgerRows.get(`${row.provider}|${row.id}`)

    const probeState = typeof probe.state === 'string' ? probe.state : undefined
    const test = testResults.get(`${row.provider}|${row.id}`)

    // Measured evidence: a recorded request from this machine, from either the
    // plugin's own samples (its lanes) or the channels' ledger.
    let measured
    if (test !== undefined) {
      // A test the user just ran outranks every historical source: it is the
      // only evidence with a timestamp that is certainly about right now.
      measured = {
        source: 'test',
        ok: test.ok === true,
        at: test.at,
        ttftMs: test.ttftMs,
        // Decode rate, matching the channel ledger's definition. Dividing by
        // `elapsedMs` would charge the first-token wait to the model and report
        // single-digit tok/s for a channel that streams at 200.
        tps: typeof test.usage?.outputTokens === 'number' && typeof test.decodeMs === 'number' && test.decodeMs > 0
          ? Math.round((test.usage.outputTokens / (test.decodeMs / 1000)) * 10) / 10
          : null,
        calls: 1,
        failed: test.ok === true ? 0 : 1,
        input: typeof test.usage?.inputTokens === 'number' ? test.usage.inputTokens : 0,
        output: typeof test.usage?.outputTokens === 'number' ? test.usage.outputTokens : 0,
        elapsedMs: test.elapsedMs,
        detail: test.error ?? (test.ok === true ? undefined : '主动测试未通过'),
      }
    } else if (aggregate !== undefined && aggregate.requests > 0) {
      const failed = aggregate.errors
      const ok = aggregate.requests - failed > 0
      measured = {
        source: 'ledger',
        ok,
        // The ledger is bucketed by day, so it cannot say *when* the last call
        // happened — only which day it happened on. The bucket's midnight is
        // therefore the honest lower bound, and the client renders it as a day
        // label ("今天") rather than a misleading "22 小时前". The file's own
        // mtime is reported separately, as `evidenceAt`, where it means exactly
        // what it is: when any request was last recorded at all.
        at: dayToMs(aggregate.day),
        evidenceAt: ledgerAt,
        day: aggregate.day,
        ttftMs: aggregate.ttftCount > 0 ? Math.round(aggregate.ttftSumMs / aggregate.ttftCount) : null,
        tps: aggregate.tpsCount > 0 ? aggregate.tpsSum / aggregate.tpsCount : null,
        calls: aggregate.requests,
        failed,
        input: aggregate.input,
        output: aggregate.output,
        detail: failed === 0
          ? undefined
          : failed >= aggregate.requests
            ? `${aggregate.requests} 次请求全部失败`
            : `${failed}/${aggregate.requests} 次请求失败`,
      }
    } else if (last !== undefined) {
      measured = {
        source: 'sample',
        ok: last.ok === true,
        at: last.at,
        ttftMs: last.ttftMs ?? null,
        tps: last.tps ?? null,
        calls: totals.calls ?? 0,
        failed: totals.failed ?? 0,
        input: totals.input ?? 0,
        output: totals.output ?? 0,
        detail: last.truncated === true ? '上一次响应被截断' : undefined,
      }
    } else if (totals.calls > 0) {
      measured = {
        source: 'totals',
        ok: (totals.failed ?? 0) < (totals.calls ?? 0),
        calls: totals.calls,
        failed: totals.failed ?? 0,
        input: totals.input ?? 0,
        output: totals.output ?? 0,
      }
    }

    const providerName = providerNames.get(row.provider) ?? row.provider
    const family = familyOf(row.id, row.name)

    models.push({
      id: row.id,
      name: row.name,
      provider: row.provider,
      providerName,
      lane: laneFor(row.provider, row.id),
      family: family.id,
      familyName: family.name,
      variant: variantKey(row.id, row.name),
      state: displayState(probeState, measured),
      probeState: probeState ?? 'unknown',
      detail: measured?.detail ?? (typeof probe.detail === 'string' ? probe.detail : undefined),
      probeDetail: typeof probe.detail === 'string' ? probe.detail : undefined,
      probeAt: probe.at,
      probeTtftMs: probe.ttftMs,
      probeLatencyMs: probe.latencyMs,
      measuredSource: measured?.source,
      lastOk: measured?.ok,
      lastAt: measured?.at ?? last?.at,
      // When the evidence behind `lastAt` was written. For a ledger row that is
      // the ledger file's mtime — the only sub-day timestamp that file has —
      // while `lastAt` stays the day the bucket describes. The client shows the
      // day as a day and this as an age, so neither is asked to mean both.
      lastEvidenceAt: measured?.evidenceAt,
      lastDay: measured?.day,
      lastTtftMs: measured?.ttftMs ?? last?.ttftMs ?? null,
      lastTps: measured?.tps ?? last?.tps ?? null,
      lastElapsedMs: measured?.elapsedMs ?? last?.elapsedMs,
      calls: measured?.calls ?? 0,
      failed: measured?.failed ?? 0,
      input: measured?.input ?? 0,
      output: measured?.output ?? 0,
      // Whether this row can be tested right now. Every row the panel lists can:
      // the button is not a promise about the channel, only about whether the
      // route will accept the id.
      testable: true,
    })
  }

  const usableOf = (model) => model.state === 'available' || model.state === 'measured-ok'
  const speedOf = (model) => {
    const value = model.lastTtftMs ?? model.probeTtftMs ?? model.probeLatencyMs
    return typeof value === 'number' && isFinite(value) && value > 0 ? value : Number.MAX_SAFE_INTEGER
  }

  // Cluster the variants of one model together, so `deepseek-v4.1-flash` from
  // Qoder, WorkBuddy and CodeArts sit next to each other inside their family.
  const clusters = new Map()
  for (const model of models) {
    const key = `${model.family}|${model.variant}`
    let cluster = clusters.get(key)
    if (cluster === undefined) {
      cluster = { key, family: model.family, bestState: 99, bestSpeed: Number.MAX_SAFE_INTEGER, usable: 0, size: 0 }
      clusters.set(key, cluster)
    }
    cluster.size += 1
    if (usableOf(model)) {
      cluster.usable += 1
      cluster.bestState = Math.min(cluster.bestState, rank(model.state))
      cluster.bestSpeed = Math.min(cluster.bestSpeed, speedOf(model))
    }
  }

  for (const model of models) {
    const cluster = clusters.get(`${model.family}|${model.variant}`)
    model.cluster = cluster.key
    model.clusterUsable = cluster.usable
    model.clusterSize = cluster.size
    model.clusterBestState = cluster.bestState
    model.clusterBestSpeed = cluster.bestSpeed
  }

  // Families with anything usable float to the top; a wall of dead models does
  // not push the working ones below the fold any more.
  const familyStats = new Map()
  for (const model of models) {
    let stats = familyStats.get(model.family)
    if (stats === undefined) {
      stats = { id: model.family, name: model.familyName, total: 0, usable: 0 }
      familyStats.set(model.family, stats)
    }
    stats.total += 1
    if (usableOf(model)) stats.usable += 1
  }
  /**
   * Family order: the user's own drag order first, then the declared order.
   *
   * Dragging a section is an explicit instruction, so it outranks health: once
   * the user has put GLM above DeepSeek, no probe result moves it back. Anything
   * the user has not dragged keeps the fixed DeepSeek → GLM → Kimi → HY → GPT →
   * Qwen → tail order.
   */
  const familyOrderOf = (familyId) => {
    const dragged = rankByOrder(userOrder.families, familyId)
    if (dragged !== Number.MAX_SAFE_INTEGER) return dragged
    return 1000 + (FAMILY_ORDER.get(familyId) ?? 900)
  }

  /** Row order inside one family: the user's drag order, when there is one. */
  const modelOrderOf = (familyId, model) => {
    const list = userOrder.models[familyId]
    if (!Array.isArray(list) || list.length === 0) return Number.MAX_SAFE_INTEGER
    return rankByOrder(list, `${model.provider}|${model.id}`)
  }

  // One comparator, in the order a chooser actually cares about:
  //   1. the family order — the user's drag order, else the declared order
  //   2. inside a dragged family, the user's own row order
  //   3. working model-variants above dead ones
  //   4. faster variant-clusters first
  //   5. one model's variants stay adjacent, usable ones first
  models.sort((a, b) => {
    const byFamily = familyOrderOf(a.family) - familyOrderOf(b.family)
    if (byFamily !== 0) return byFamily

    const aPinned = modelOrderOf(a.family, a)
    const bPinned = modelOrderOf(b.family, b)
    if (aPinned !== bPinned) {
      // Pinned rows first in their own order; unpinned rows keep the automatic
      // order behind them. Two unpinned rows both report MAX_SAFE_INTEGER and
      // fall through to the health keys below.
      if (aPinned === Number.MAX_SAFE_INTEGER || bPinned === Number.MAX_SAFE_INTEGER) {
        return aPinned === Number.MAX_SAFE_INTEGER ? 1 : -1
      }
      return aPinned - bPinned
    }

    const aLive = a.clusterBestState <= CLUSTER_LIVE_STATE ? 0 : 1
    const bLive = b.clusterBestState <= CLUSTER_LIVE_STATE ? 0 : 1
    if (aLive !== bLive) return aLive - bLive

    if (a.variant !== b.variant) {
      // Working clusters by measured speed; a cluster with no timing sorts by
      // name so the order stays deterministic across refreshes.
      if (aLive === 0) {
        const bySpeed = a.clusterBestSpeed - b.clusterBestSpeed
        if (bySpeed !== 0) return bySpeed
      }
      return a.variant.localeCompare(b.variant)
    }

    const byState = rank(a.state) - rank(b.state)
    if (byState !== 0) return byState
    const bySpeed = speedOf(a) - speedOf(b)
    if (bySpeed !== 0) return bySpeed
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider)
    return a.id.localeCompare(b.id)
  })

  const counts = {
    total: models.length,
    available: 0,
    measuredOk: 0,
    throttled: 0,
    regionBlocked: 0,
    unavailable: 0,
    measuredFailed: 0,
    unknown: 0,
    channels: 0,
  }
  const groupCounts = new Map()
  for (const model of models) {
    if (model.state === 'available') counts.available += 1
    else if (model.state === 'measured-ok') counts.measuredOk += 1
    else if (model.state === 'throttled') counts.throttled += 1
    else if (model.state === 'region-blocked') counts.regionBlocked += 1
    else if (model.state === 'unavailable') counts.unavailable += 1
    else if (model.state === 'measured-failed') counts.measuredFailed += 1
    else counts.unknown += 1
    if (model.lane === 'channel') counts.channels += 1

    let bucket = groupCounts.get(model.family)
    if (bucket === undefined) {
      bucket = {
        group: model.family,
        name: model.familyName,
        order: familyOrderOf(model.family),
        total: 0,
        usable: 0,
      }
      groupCounts.set(model.family, bucket)
    }
    bucket.total += 1
    if (usableOf(model)) bucket.usable += 1
  }
  counts.usable = counts.available + counts.measuredOk

  // The header carries its own hint about whether the section is worth opening:
  // a family whose models are all unusable says so, instead of looking equal.
  const groups = [...groupCounts.values()]
    .sort((a, b) => a.order - b.order)
    .map((group) => ({
      ...group,
      dead: group.usable === 0,
      pinned: userOrder.families.includes(group.group),
    }))

  const body = {
    build: BUILD,
    at: Date.now(),
    probeAt: availability?.at,
    egress: availability?.egress,
    dir,
    channelDir,
    catalogAt: catalog.at === 0 ? undefined : catalog.at,
    catalogError: catalog.error,
    providers: catalog.providers.length,
    counts,
    groups,
    models,
    // When the two evidence files were last written. Without these the panel
    // could only say "no data"; with them it can say "this evidence is nine
    // hours old", which is the difference between a dead channel and a stale
    // panel.
    evidence: {
      ledgerAt,
      statsAt,
      availabilityAt: availability?.at,
    },
    // Echo the whole order back so the client can show what is pinned and post
    // a complete document instead of guessing at the parts it did not send.
    order: userOrder,
  }

  // The set the test route checks against: what this snapshot just listed. Kept
  // here rather than rebuilt from the registry, so the panel and the route agree
  // on exactly which ids exist.
  lastKnownRoutes = new Set(models.map((entry) => `${entry.provider}|${entry.id}`))

  await writeHeartbeat({
    build: BUILD,
    at: body.at,
    dir,
    channelDir,
    providers: catalog.providers.length,
    models: models.length,
    counts,
    catalogError: catalog.error,
    evidence: body.evidence,
  })

  return body
}

/**
 * Record that this build answered, so a live install can be told from a stale
 * one without a browser. Best-effort: a failure here never fails the route.
 */
async function writeHeartbeat(payload) {
  try {
    const target = join(dshHome(), HEARTBEAT_FILE)
    await mkdir(join(dshHome(), 'ofm-health'), { recursive: true })
    await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch {
    // Best effort only.
  }
}

/* ------------------------------------------------------------------ *
 * The user's own ordering.
 * ------------------------------------------------------------------ */

/** Last order read from disk, so a hot loop does not stat the file each time. */
let orderCache = { at: 0, value: emptyOrder() }

/** An order with nothing dragged yet. */
function emptyOrder() {
  return { families: [], models: {} }
}

/** Whitelist one array of ids: strings, trimmed, deduplicated, capped. */
function cleanIdList(value, cap = 500) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push(id.slice(0, 200))
    if (out.length >= cap) break
  }
  return out
}

/** Whitelist a whole order document. Anything unexpected is dropped, not kept. */
function cleanOrder(raw) {
  const families = cleanIdList(raw?.families, 200)
  const models = {}
  const source = raw?.models
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    for (const [family, list] of Object.entries(source)) {
      const key = String(family).trim().slice(0, 80)
      if (key === '') continue
      const ids = cleanIdList(list, 400)
      if (ids.length > 0) models[key] = ids
    }
  }
  return { families, models }
}

/**
 * Read the persisted order. A missing file is an empty order, not an error: the
 * panel works before anything has been dragged.
 * @returns the validated order.
 */
async function readOrder() {
  try {
    const text = await readFile(join(dshHome(), ORDER_FILE), 'utf8')
    const parsed = JSON.parse(text)
    orderCache = { at: Date.now(), value: cleanOrder(parsed) }
    return orderCache.value
  } catch {
    return orderCache.value
  }
}

/**
 * Persist one order, replacing whatever was there.
 * @returns the validated order that was written.
 */
async function writeOrder(raw) {
  const value = cleanOrder(raw)
  await mkdir(join(dshHome(), 'ofm-health'), { recursive: true })
  const target = join(dshHome(), ORDER_FILE)
  const pending = `${target}.tmp`
  await writeFile(pending, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(pending, target)
  orderCache = { at: Date.now(), value }
  return value
}

/**
 * Rank an id by the user's list: listed ids first, in list order; everything
 * else after them, keeping the caller's own order.
 */
function rankByOrder(order, id) {
  const index = order.indexOf(id)
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

/** Read a request body, capped so a huge post cannot exhaust memory. */
function readBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Send one JSON response with the same headers the snapshot route uses. */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Build the order handler: the one write path this package has.
 *
 * It accepts a complete order document (`{ families, models }`) and replaces the
 * stored one. The client sends what it wants rather than a delta, because a
 * delta computed against a snapshot that has since changed would drop the user's
 * drags silently.
 *
 * @param connection - the composition's trust fence.
 * @returns the route handler.
 */
function orderHandler(connection) {
  return (req, res) => {
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) {
      res.statusCode = rejection
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'POST')
      res.end()
      return
    }
    readBody(req).then(
      (text) => {
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          sendJson(res, 400, { error: 'body is not valid JSON' })
          return
        }
        return writeOrder(parsed).then(
          (order) => sendJson(res, 200, { ok: true, order }),
          (error) => sendJson(res, 500, { error: String((error && error.message) || error) }),
        )
      },
      (error) => sendJson(res, 400, { error: String((error && error.message) || error) }),
    )
  }
}

/**
 * Build the active-test handler.
 *
 * One POST runs one real request and answers with its measurement. It is the
 * only route here that causes network traffic, so it is deliberately narrow:
 * the body must name one provider and one model that the registry actually
 * advertises, and the reply never contains credentials.
 *
 * @param connection - the composition's trust fence.
 * @returns the route handler.
 */
function testHandler(connection) {
  return (req, res) => {
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) {
      res.statusCode = rejection
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'POST')
      res.end()
      return
    }
    const llm = llmOf === null ? undefined : llmOf()
    if (llm === undefined || llm === null) {
      sendJson(res, 503, { error: 'llm 服务尚未就绪，请稍后再试' })
      return
    }
    readBody(req).then(
      (text) => {
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          sendJson(res, 400, { error: 'body is not valid JSON' })
          return
        }
        const provider = parsed !== null && typeof parsed === 'object' && typeof parsed.provider === 'string'
          ? parsed.provider.trim()
          : ''
        const model = parsed !== null && typeof parsed === 'object' && typeof parsed.model === 'string'
          ? parsed.model.trim()
          : ''
        if (provider === '' || model === '') {
          sendJson(res, 400, { error: 'provider 与 model 都是必填的' })
          return
        }
        // Any id the panel listed may be tested. The registry advertises fewer
        // ids than the panel draws — ledger-only channel rows and free-lane
        // aliases never appear in `llm.listProviders()` — so requiring registry
        // membership here hid the button on rows and returned 404 on them. An id
        // the adapter cannot serve still fails honestly, with its own error,
        // which is a more useful answer than "清单里没有".
        const known = lastKnownRoutes.size === 0 || lastKnownRoutes.has(`${provider}|${model}`)
        if (!known) {
          sendJson(res, 404, { error: `清单里没有 ${provider} / ${model}` })
          return
        }
        const request = { provider, model }
        if (typeof parsed.effort === 'string' && parsed.effort !== '') request.effort = parsed.effort
        if (typeof parsed.timeoutMs === 'number') request.timeoutMs = parsed.timeoutMs
        return runTest(llm, request).then(
          (result) => {
            rememberTest(`${provider}|${model}`, result)
            sendJson(res, 200, result)
          },
          (error) => sendJson(res, 500, { error: errorText(error) }),
        )
      },
      (error) => sendJson(res, 400, { error: String((error && error.message) || error) }),
    )
  }
}

/**
 * Build the route handler.
 * @param connection - the composition's trust fence.
 * @returns the route handler.
 */
function stateHandler(connection) {
  return (req, res) => {
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) {
      res.statusCode = rejection
      res.end()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('allow', 'GET, HEAD')
      res.end()
      return
    }
    snapshot().then(
      (body) => {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(body))
      },
      (error) => {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({ error: String((error && error.message) || error) }))
      },
    )
  }
}

/**
 * Host plugin body: register the read-only snapshot route and keep the provider
 * catalog warm.
 * @param ctx - the host root context carrying the route table and trust fence.
 */
function apply(ctx) {
  // Record the loaded build immediately, so a live install can be told from a
  // stale one even before the panel is opened for the first time.
  writeHeartbeat({ build: BUILD, phase: 'apply', at: Date.now() })

  ctx.inject(['llm'], (scope) => {
    llmOf = () => scope.llm
    // Warm the registry as soon as the service exists, so the first panel open
    // already lists the channels.
    refreshCatalog()
  })

  ctx.effect(() => {
    const timer = setInterval(() => { refreshCatalog() }, CATALOG_TTL_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'ofm-health: provider catalog refresh')

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: STATE_ROUTE,
      handler: stateHandler(ctx.connection),
    }),
    `ofm-health: GET ${STATE_ROUTE}`,
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ORDER_ROUTE,
      handler: orderHandler(ctx.connection),
    }),
    `ofm-health: POST ${ORDER_ROUTE}`,
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: TEST_ROUTE,
      handler: testHandler(ctx.connection),
    }),
    `ofm-health: POST ${TEST_ROUTE}`,
  )
}

export {
  apply,
  inject,
  name,
  snapshot,
  stateHandler,
  orderHandler,
  testHandler,
  runTest,
  readOrder,
  writeOrder,
  cleanOrder,
  STATE_ROUTE,
  ORDER_ROUTE,
  TEST_ROUTE,
  ORDER_FILE,
  BUILD,
  displayState,
  dataDirCandidates,
  resolveDataDir,
  resolveChannelDir,
  parseLedger,
  refreshCatalog,
  variantKey,
  familyOf,
  FAMILIES,
}
