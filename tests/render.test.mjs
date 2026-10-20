// Render smoke test: what the panel actually draws, without a browser.
//
// The harness renders `panelChildren` through a fake `react` that calls
// function components immediately, so the tree is real props by the time it is
// handed back. Host elements keep their kids in `node.children` (the stub does
// not copy them into props), which is what the walkers below follow.
//
//   node tests/render.test.mjs
import { loadClient } from './_harness.mjs'

const { api: T } = await loadClient()
const failures = []
const check = (name, ok, detail) => {
  if (!ok) failures.push(detail ? `${name}: ${detail}` : name)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`)
}

const models = [
  {
    provider: 'buddy', id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash · x0.11',
    providerName: 'CodeBuddy (腾讯)', family: 'deepseek', familyName: 'DeepSeek',
    state: 'measured-ok', calls: 1557, failed: 0, lastTps: 244, lastTtftMs: 2490,
  },
  {
    provider: 'qoder', id: 'dfmodel', name: 'DeepSeek-Flash · x0.1',
    providerName: 'Qoder', family: 'others', familyName: '其他',
    state: 'measured-ok', calls: 5, failed: 3,
  },
]
const data = { models, counts: {}, egress: { ip: '1.2.3.4' }, order: { families: [], models: {} } }

const toggle = (overrides = {}) => ({
  drag: null, order: data.order, tests: {}, saveState: null, collapsed: {}, allCollapsed: false,
  testingAll: false, search() {}, group() {}, collapseAll() {}, expandAll() {}, refresh() {},
  testAll() {}, stopTestAll() {}, test() {}, resetOrder() {}, beginDrag() {},
  ...overrides,
})

/** Every node in the rendered tree, depth first. */
const nodes = (tree) => {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    out.push(node)
    const kids = node.children ?? node.props?.children
    if (kids !== undefined) walk(kids)
  }
  walk(tree)
  return out
}

/** The text a host element contains, or '' when it holds a component. */
const text = (node) => (Array.isArray(node.children)
  ? node.children.filter((child) => typeof child === 'string').join('')
  : '')

/** The text of a whole subtree, and also its own children (for host nodes). */
const deepText = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(deepText).join('')
  if (typeof node !== 'object') return ''
  return deepText(node.children ?? node.props?.children)
}

const scan = (tree) => {
  const all = nodes(tree)
  const buttons = all.filter((node) => node.type === 'button')
  return {
    all,
    buttons,
    labels: buttons.map(text),
    titles: all.map((node) => node.props?.title).filter((title) => typeof title === 'string'),
  }
}

const idle = scan(T.panelChildren(data, null, '', {}, toggle()))
const labels = idle.labels

check('the header offers a sweep button', labels.includes('测试展开项'), labels.join(' | '))
check('the sweep button is not the old label', !labels.includes('全部测试'))
check('no stop button while idle', !labels.includes('停止'))
check('every row has its own test button', labels.filter((text) => text === '测试').length === 2,
  `${labels.filter((text) => text === '测试').length} row buttons`)

const running = scan(T.panelChildren(data, null, '', {}, toggle({ testingAll: true })))
check('a running sweep can be stopped', running.labels.includes('停止'), running.labels.join(' | '))
check('the sweep button is disabled while running',
  running.buttons.find((button) => text(button) === '测试中…')?.props.disabled === true)

// ②: no status word, no freshness wording anywhere in the row text.
const text2 = JSON.stringify(idle.all.map((node) => node.children ?? node.props?.children ?? ''))
  + JSON.stringify(idle.titles) + JSON.stringify(running.titles)
check('no "刚测通/刚测失败" anywhere', !text2.includes('刚测'), text2.slice(0, 120))
check('no freshness wording anywhere', !/账本日期|最近实测|分钟前|小时前/.test(text2))

// ④: no row is drawn without a button, whatever its state.
const dead = {
  models: [{ provider: 'x', id: 'y', name: 'Y', providerName: 'X', family: 'others', familyName: '其他', state: 'measured-failed', calls: 2, failed: 2, testable: false }],
  counts: {}, egress: {}, order: { families: [], models: {} },
}
const deadScan = scan(T.panelChildren(dead, null, '', {}, toggle()))
check('a row marked testable:false still gets a button', deadScan.labels.includes('测试'), deadScan.labels.join(' | '))

// ⑤: the model name wraps instead of being clipped.
const labelSpan = idle.all.find((node) => node.props?.style?.overflowWrap === 'anywhere')
check('the model name is allowed to wrap', labelSpan !== undefined)
check('the model name is not truncated',
  labelSpan !== undefined && labelSpan.props.style.textOverflow === undefined
  && labelSpan.props.style.whiteSpace === undefined && labelSpan.props.style.overflow === undefined)
check('the panel is 620 wide', T.panelStyle({ right: 600, top: 700 }, { width: 1440, height: 900 }).width === 620)
check('a narrow viewport still centres', T.panelStyle({ right: 300, top: 700 }, { width: 390, height: 844 }).left === '50%')

// ⑦: a phone row is three cells, each allowed two lines.
check('a phone panel switches to the narrow layout', T.panelNarrow({ width: 390, height: 844 }) === true)
check('a desktop panel keeps one line', T.panelNarrow({ width: 1440, height: 900 }) === false)

const narrow = scan(T.panelChildren(data, null, '', {}, toggle(), true))
const rows = narrow.all.filter((node) => node.props?.['data-ofm-row'] !== undefined)
check('every narrow row is marked narrow', rows.length === 2
  && rows.every((row) => row.props['data-ofm-narrow'] === 'true'), `${rows.length} rows`)

// The three cells: model (wraps, clamped to two lines), provider (same), stats
// (a column of two lines). None of them may clip horizontally to an ellipsis.
const clamped = narrow.all.filter((node) => node.props?.style?.WebkitLineClamp === '2')
check('model and provider cells each clamp to two lines', clamped.length === 4, `${clamped.length} cells`)
check('the clamp value is a string, so React does not add px',
  narrow.all.every((node) => typeof node.props?.style?.WebkitLineClamp !== 'number'))
check('the clamped cells wrap rather than truncate', clamped.every(
  (node) => node.props.style.textOverflow === undefined && node.props.style.whiteSpace === undefined))

const statsCells = narrow.all.filter((node) => node.props?.style?.flexDirection === 'column')
check('the numbers are a two-line column', statsCells.length === 2, `${statsCells.length} cells`)
check('the numbers are not clipped on one line', statsCells.every(
  (node) => node.props.style.textOverflow === undefined))
check('the narrow numbers cell is a fixed track too, so the company cannot drift',
  statsCells.every((node) => /^0 0 \d+px$/.test(node.props.style.flex)),
  JSON.stringify(statsCells.map((node) => node.props.style.flex)))

// The company column is centred inside its strip, in both layouts: an
// auto-width label put every row's company at a different x, so a column of rows
// had no vertical line to read down.
const providerCells = narrow.all.filter((node) => node.props?.title !== undefined
  && node.props.style?.textAlign === 'center')
check('the company column is centred', providerCells.length === 2, `${providerCells.length} cells`)
check('the company column is a fixed strip, so it cannot squeeze the model name',
  providerCells.every((node) => node.props.style.flex === '0 0 78px'))

const wideProviders = idle.all.filter((node) => node.props?.style?.flex === '0 0 110px')
check('the desktop company column is centred too', wideProviders.length === 2, `${wideProviders.length} cells`)
check('the desktop company column is a fixed strip',
  wideProviders.every((node) => node.props.style.textAlign === 'center'))

// The company column only holds one vertical line if every cell that follows the
// model name is fixed-width. A cell that sizes itself to its content — the old
// `1 1 auto` numbers cell, the old collapsed status cell — takes a different
// share of each row, so the company lands at a different x on every line.
const wideRows = idle.all.filter((node) => node.props?.['data-ofm-row'] !== undefined
  && node.props['data-ofm-narrow'] === 'false')
check('desktop rows are drawn wide', wideRows.length === 2, `${wideRows.length} rows`)

// The status cell is drawn even when blank, otherwise a broken row — the ones
// worth scanning for — would be the only rows that shift the company column.
check('a healthy row still reserves its status track',
  wideRows.every((row) => (row.children ?? []).some((cell) => cell?.props?.style?.flex === '0 0 56px')))
check('the status track is centred', wideRows.every((row) => (row.children ?? []).some(
  (cell) => cell?.props?.style?.flex === '0 0 56px' && cell.props.style.textAlign === 'center')))

const afterModel = wideRows.map((row) => {
  const cells = (row.children ?? []).filter((child) => child !== null && typeof child === 'object')
  // handle, dot, model, company, status, numbers, button
  return cells.slice(3).map((cell) => cell.props?.style?.flex ?? 'none')
})
check('nothing after the model name sizes itself to its content',
  afterModel.every((flexes) => flexes.every((flex) => !/^1\s/.test(flex) && !flex.startsWith('0 1'))),
  JSON.stringify(afterModel))
check('the numbers cell is a fixed track, so every row reserves the same width',
  afterModel.every((flexes) => flexes.includes('0 0 160px')), JSON.stringify(afterModel))

// The status track is 56px, which holds the short form and nothing longer. The
// full names from STATES would be clipped to `地区受…` — a different state as far
// as a reader is concerned — so the cell draws the short form, and the full name
// stays in the tooltip.
const statusCells = wideRows.map((row) => (row.children ?? []).find(
  (cell) => cell?.props?.style?.flex === '0 0 56px'))
check('a healthy row leaves its status track empty',
  statusCells.every((cell) => text(cell) === ''), JSON.stringify(statusCells.map(text)))

const deadStatus = (deadScan.all.filter((node) => node.props?.['data-ofm-row'] !== undefined))
  .map((row) => (row.children ?? []).find((cell) => cell?.props?.style?.flex === '0 0 56px'))
check('a broken row names its state in the status track',
  deadStatus.some((cell) => text(cell) === '失败'), JSON.stringify(deadStatus.map(text)))
check('the short form fits the track', deadStatus.every((cell) => text(cell).length <= 3),
  JSON.stringify(deadStatus.map(text)))
check('the full state name is still in the row tooltip',
  [...idle.titles, ...deadScan.titles].some((title) => title.includes('实测失败')),
  deadScan.titles.join(' | ').slice(0, 200))

// Both numbers survive: the rate and the ratio each get their own line, so
// neither can push the other off the edge.
const rated = rows.filter((row) => deepText(row).includes('tok/s'))
check('the rate is still drawn on a phone', rated.length === 1, `${rated.length} rows`)
check('the success ratio is still drawn on a phone', rows.some((row) => /\d+\/\d+/.test(deepText(row))))

console.log(failures.length === 0 ? '\nRENDER OK' : `\n${failures.length} FAILURE(S):\n  ${failures.join('\n  ')}`)
process.exit(failures.length === 0 ? 0 : 1)
