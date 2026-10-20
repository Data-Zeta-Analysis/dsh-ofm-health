// Behavioural test for pointer-driven reordering.
//
// The drag state machine is exercised as the browser would: a press on a grab
// handle, then `pointermove`/`pointerup` on `document`. Rows and headers are
// fake DOM nodes that answer `closest()` the way the real ones do.
//
//   node tests/drag.test.mjs
import { loadClient, collectHandles } from './_harness.mjs'

const { api: T, store, listeners, setHitTest, fire } = await loadClient()
const failures = []
const check = (name, ok, detail) => {
  if (!ok) failures.push(detail ? `${name}: ${detail}` : name)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`)
}

const models = [
  { provider: 'buddy', id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', family: 'deepseek', familyName: 'DeepSeek', state: 'measured-ok', calls: 1, failed: 0 },
  { provider: 'codearts', id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', family: 'deepseek', familyName: 'DeepSeek', state: 'available', calls: 0, failed: 0 },
  { provider: 'raccoon', id: 'sn-deepseek-v4-1-flash', name: 'DeepSeek-V4.1-Flash', family: 'deepseek', familyName: 'DeepSeek', state: 'available', calls: 0, failed: 0 },
  { provider: 'buddy', id: 'glm-5.3', name: 'GLM-5.3', family: 'glm', familyName: 'GLM', state: 'available', calls: 0, failed: 0 },
]
const data = { models, counts: {}, egress: { ip: '1.2.3.4' }, order: { families: [], models: {} } }

// The panel owns order + persist; mirror that so startPointerDrag can be
// driven directly — it takes all its state as arguments by design.
let curOrder = data.order
const persist = (next) => {
  curOrder = next
  store.set(T.ORDER_KEY, JSON.stringify(next))
}
const dragRef = { current: null }
const dragCleanup = { current: null }
const dragTimer = { current: null }

const handles = (() => {
  const toggle = {
    drag: null, order: curOrder, tests: {}, saveState: null,
    collapsed: false, allCollapsed: false, testingAll: false,
    search() {}, group() {}, collapseAll() {}, expandAll() {},
    refresh() {}, testAll() {}, test() {}, resetOrder() {},
  }
  return collectHandles(T.panelChildren(data, null, '', {}, toggle))
})()

// Rebuild handles with a real beginDrag bound to the state machine.
const beginDrag = (event, kind, key, family) => T.startPointerDrag({
  event, kind, key, family,
  dragCleanup, dragRef, dragTimer, setDrag: () => {},
  wrapRef: { current: null },
  listModels: () => models,
  listOrder: () => curOrder,
  applyDrop: (kind2, from, to, family2, visibleFamilies, visibleRows) => {
    if (from === null || to === null || from === to) return
    const next = curOrder ?? { families: [], models: {} }
    // The same merge the panel uses: a row missing from the saved order is
    // appended rather than making the drop a no-op.
    if (kind2 === 'group') {
      const current = T.mergeRows(next.families, visibleFamilies)
      const fromIndex = current.indexOf(from)
      const toIndex = current.indexOf(to)
      if (fromIndex === -1 || toIndex === -1) return
      persist({ ...next, families: T.moveItem(current, fromIndex, toIndex) })
      return
    }
    const current = T.mergeRows(next.models[family2], visibleRows)
    const fromIndex = current.indexOf(from)
    const toIndex = current.indexOf(to)
    if (fromIndex === -1 || toIndex === -1) return
    persist({ ...next, models: { ...next.models, [family2]: T.moveItem(current, fromIndex, toIndex) } })
  },
})

const node = (attrs) => ({ closest: (sel) => (sel in attrs ? { getAttribute: (a) => attrs[sel][a] } : null) })
const makeEvent = (x, y, extra = {}) => ({
  clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0,
  currentTarget: { setPointerCapture() {}, releasePointerCapture() {} },
  preventDefault() {}, stopPropagation() {}, ...extra,
})
const savedOrder = () => {
  const raw = store.get(T.ORDER_KEY)
  return raw ? JSON.parse(raw) : null
}

// Two section headers (deepseek, glm) + four rows.
check('every row and header exposes a grab handle', Object.keys(handles).length === 6,
  `got ${Object.keys(handles).join(', ')}`)

// 1. drag row 0 down onto row 1
setHitTest(() => node({
  '[data-ofm-row]': { 'data-ofm-row': 'codearts|deepseek-v4.1-flash', 'data-ofm-family': 'deepseek', 'data-ofm-section': 'deepseek' },
}))
beginDrag(makeEvent(10, 10), 'model', 'buddy|deepseek-v4.1-flash', 'deepseek')
check('press installs the document listeners', (listeners.get('pointermove') ?? []).length === 1,
  `${(listeners.get('pointermove') ?? []).length} pointermove listeners`)
fire('pointermove', makeEvent(11, 30))
fire('pointermove', makeEvent(11, 60))
fire('pointerup', makeEvent(11, 60))
check('dragging a row down reorders its family',
  JSON.stringify(savedOrder()?.models?.deepseek) === JSON.stringify([
    'codearts|deepseek-v4.1-flash', 'buddy|deepseek-v4.1-flash', 'raccoon|sn-deepseek-v4-1-flash',
  ]),
  JSON.stringify(savedOrder()?.models?.deepseek))
check('drop removes every document listener', (listeners.get('pointermove') ?? []).length === 0,
  `${(listeners.get('pointermove') ?? []).length} left`)

// 1b. a row the saved order has never seen must still be draggable — this is
// the "Qoder cannot be dragged up" case: its key was absent from the stored
// list, `indexOf` answered -1, and the drop was silently discarded.
store.delete(T.ORDER_KEY)
curOrder = { families: [], models: { deepseek: ['buddy|deepseek-v4.1-flash', 'codearts|deepseek-v4.1-flash'] } }
setHitTest(() => node({
  '[data-ofm-row]': { 'data-ofm-row': 'buddy|deepseek-v4.1-flash', 'data-ofm-family': 'deepseek', 'data-ofm-section': 'deepseek' },
}))
beginDrag(makeEvent(10, 60), 'model', 'raccoon|sn-deepseek-v4-1-flash', 'deepseek')
fire('pointermove', makeEvent(10, 40))
fire('pointermove', makeEvent(10, 10))
fire('pointerup', makeEvent(10, 10))
check('a row missing from the saved order can be dragged up',
  JSON.stringify(savedOrder()?.models?.deepseek) === JSON.stringify([
    'raccoon|sn-deepseek-v4-1-flash', 'buddy|deepseek-v4.1-flash', 'codearts|deepseek-v4.1-flash',
  ]),
  JSON.stringify(savedOrder()?.models?.deepseek))

// 2. a press with no movement must not reorder
store.delete(T.ORDER_KEY)
curOrder = { families: [], models: {} }
beginDrag(makeEvent(10, 10), 'model', 'buddy|deepseek-v4.1-flash', 'deepseek')
fire('pointerup', makeEvent(10, 10))
check('a plain click writes no order', savedOrder() === null)

// 3. a row may not cross into another family
store.delete(T.ORDER_KEY)
curOrder = { families: [], models: {} }
setHitTest(() => node({
  '[data-ofm-row]': { 'data-ofm-row': 'buddy|glm-5.3', 'data-ofm-family': 'glm', 'data-ofm-section': 'glm' },
}))
beginDrag(makeEvent(10, 10), 'model', 'buddy|deepseek-v4.1-flash', 'deepseek')
fire('pointermove', makeEvent(10, 60))
fire('pointerup', makeEvent(10, 60))
check('a row cannot be dropped into another family', savedOrder() === null)

// 4. drag a section header onto another header
store.delete(T.ORDER_KEY)
curOrder = { families: [], models: {} }
setHitTest(() => node({
  '[data-ofm-group]': { 'data-ofm-group': 'glm', 'data-ofm-section': 'glm' },
}))
beginDrag(makeEvent(10, 10), 'group', 'deepseek', null)
fire('pointermove', makeEvent(10, 80))
fire('pointerup', makeEvent(10, 80))
check('dragging a section reorders sections',
  JSON.stringify(savedOrder()?.families) === JSON.stringify(['glm', 'deepseek']),
  JSON.stringify(savedOrder()?.families))

// 5. a second press while one drag is live is ignored
store.delete(T.ORDER_KEY)
curOrder = { families: [], models: {} }
beginDrag(makeEvent(10, 10), 'group', 'deepseek', null)
beginDrag(makeEvent(10, 10), 'group', 'glm', null)
check('a second press does not stack listeners', (listeners.get('pointermove') ?? []).length === 1,
  `${(listeners.get('pointermove') ?? []).length} pointermove listeners`)
fire('pointercancel', makeEvent(10, 10))
check('pointercancel tears the drag down', (listeners.get('pointermove') ?? []).length === 0)

console.log(failures.length === 0 ? '\nDRAG PATH OK' : `\n${failures.length} FAILURE(S):\n  ${failures.join('\n  ')}`)
process.exit(failures.length === 0 ? 0 : 1)
