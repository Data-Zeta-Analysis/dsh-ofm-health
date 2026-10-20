// Loads lib/client.js outside the browser so its pure helpers can be tested.
//
// The client half is a client-plugin module: it registers itself through the
// Host's module loader and imports `react` at runtime. This shim supplies both,
// then hands back the `__test` export block.
//
// Stubs are deliberately dumb: `createElement` calls a function component
// immediately so the render tree can be walked as plain objects, and refs are
// `{ current }` boxes. Anything that needs a real reconciler will not work
// here — that is what the browser is for.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(here, '..', 'lib', 'client.js')

/**
 * Build the global environment, import the module, return its `__test` block.
 *
 * @returns {Promise<{ api: object, restore: () => void, store: Map<string,string>,
 *   listeners: Map<string, Function[]>, setHitTest: (fn: Function) => void,
 *   fire: (name: string, event?: object) => void }>}
 */
export async function loadClient() {
  const source = fs.readFileSync(CLIENT, 'utf8')
  const store = new Map()
  const listeners = new Map()
  let hitTest = () => null

  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
  }

  globalThis.window = {
    __ModuleLoader__: { load: (def) => { globalThis.__DEF = def } },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
  }
  globalThis.document = {
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    removeEventListener(name, fn) {
      const list = listeners.get(name)
      if (!list) return
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    },
    body: { style: {} },
    elementFromPoint: (x, y) => hitTest(x, y),
    querySelector: () => null,
  }
  globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })

  const reactStub = {
    createElement: (type, props, ...children) => {
      const node = { type, props: props ?? {}, children: children.flat() }
      // Call function components immediately: panels become plain trees.
      return typeof type === 'function' ? type(node.props) ?? null : node
    },
    useState: (value) => [value, () => {}],
    useRef: (value) => ({ current: value ?? null }),
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  }

  // Strip the leading block comment so the module can be imported from a data URL.
  const body = source.replace(/^\/\*\*[\s\S]*?\*\//, '')
  await import('data:text/javascript,' + encodeURIComponent(body))

  const api = globalThis.__DEF
    .factory((id) => {
      if (id === 'react') return reactStub
      throw new Error(`unexpected module: ${id}`)
    })
    .__test

  return {
    api,
    store,
    listeners,
    setHitTest: (fn) => { hitTest = fn },
    fire: (name, event = {}) => {
      for (const fn of [...(listeners.get(name) ?? [])]) fn(event)
    },
    restore: () => {
      globalThis.window = saved.window
      globalThis.document = saved.document
      globalThis.fetch = saved.fetch
    },
  }
}

/** Collect every `onPointerDown` handler in a render tree, keyed by drag key. */
export function collectHandles(tree) {
  const handles = {}
  const probe = (node, key) => {
    if (!node || typeof node !== 'object') return
    const props = node.props ?? {}
    if (key && typeof props.onPointerDown === 'function' && !handles[key]) {
      handles[key] = props.onPointerDown
    }
    for (const child of node.children ?? []) probe(child, key)
  }
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    const props = node.props ?? {}
    // The grab handle is a child span: the key lives on the ancestor row.
    const key = props['data-ofm-row'] ?? props['data-ofm-group'] ?? null
    if (key !== null) { probe(node, key); return }
    for (const child of node.children ?? []) walk(child)
  }
  walk({ children: tree })
  return handles
}
