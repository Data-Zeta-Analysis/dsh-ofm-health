// Unit tests for the panel's pure helpers: ordering, throughput, sanitising.
//
//   node tests/unit.test.mjs
import { loadClient } from './_harness.mjs'

const { api: T } = await loadClient()
const failures = []
const check = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want)
  if (!same) failures.push(`${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`)
  console.log(`${same ? 'ok  ' : 'FAIL'} ${name}`)
}

const list = ['a', 'b', 'c', 'd']

// moveItem: `to` is the slot under the pointer in the *original* array.
check('moveItem down 1', T.moveItem(list, 0, 1), ['b', 'a', 'c', 'd'])
check('moveItem up 1', T.moveItem(list, 2, 1), ['a', 'c', 'b', 'd'])
check('moveItem first→last', T.moveItem(list, 0, list.length), ['b', 'c', 'd', 'a'])
check('moveItem last→first', T.moveItem(list, 3, 0), ['d', 'a', 'b', 'c'])
check('moveItem same slot', T.moveItem(list, 1, 1), ['a', 'b', 'c', 'd'])
check('moveItem does not mutate input', list, ['a', 'b', 'c', 'd'])
check('moveItem out-of-range clamps', T.moveItem(list, 0, 99), ['b', 'c', 'd', 'a'])

// decodeTps: generation window only, first-token wait excluded.
check('decodeTps 2 tok in 100ms of decode', T.decodeTps(2, 2400, 2500), 20)
check('decodeTps without a ttft reading', T.decodeTps(2, undefined, 2000), 1)
check('decodeTps ttft covers whole request', T.decodeTps(2, 2000, 2000), null)
check('decodeTps undefined tokens', T.decodeTps(undefined, 100, 200), null)
check('decodeTps zero decode window', T.decodeTps(1, 500, 500), null)

// testResultTps: the Host measures decodeMs itself, and that value wins.
check('testResultTps uses decodeMs', T.testResultTps({ decodeMs: 500, usage: { outputTokens: 100 } }), 200)
check(
  'testResultTps ignores a 95s wait for the first token',
  T.testResultTps({ decodeMs: 666, ttftMs: 95000, elapsedMs: 95666, usage: { outputTokens: 100 } }),
  150.2,
)
check(
  'testResultTps falls back for an older Host',
  T.testResultTps({ ttftMs: 2000, elapsedMs: 2500, usage: { outputTokens: 10 } }),
  20,
)
check('testResultTps with a zero window', T.testResultTps({ decodeMs: 0, usage: { outputTokens: 1 } }), null)
check('testResultTps without usage', T.testResultTps({ decodeMs: 500 }), null)
check('testResultTps on a null result', T.testResultTps(null), null)

// sanitizeOrder: junk in, clean order out.
check(
  'sanitizeOrder drops junk',
  T.sanitizeOrder({ families: ['a', 'a', 5, ''], models: { x: ['m1', 'm1', null] } }),
  { families: ['a'], models: { x: ['m1'] } },
)

// splitName: the price multiplier is not part of the model name.
check(
  'splitName peels off the multiplier',
  T.splitName('Deepseek-V4.1-Flash · x0.11', 'deepseek-v4.1-flash'),
  { model: 'Deepseek-V4.1-Flash', price: 'x0.11' },
)
check('splitName without a multiplier', T.splitName('GLM-5.3', 'glm-5.3'), { model: 'GLM-5.3', price: null })

// filteredModels: the renderer and the sweep must narrow identically.
const catalogue = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', provider: 'buddy', providerName: 'CodeBuddy', family: 'deepseek', familyName: 'DeepSeek' },
  { id: 'glm-5.3', name: 'GLM-5.3', provider: 'codearts', providerName: 'CodeArts', family: 'glm', familyName: 'GLM' },
]
check('filteredModels with an empty filter', T.filteredModels({ models: catalogue }, '').length, 2)
check('filteredModels matches the display name', T.filteredModels({ models: catalogue }, 'deepseek').map((m) => m.id), ['deepseek-v4.1-flash'])
check('filteredModels matches the provider name', T.filteredModels({ models: catalogue }, 'codebuddy').map((m) => m.id), ['deepseek-v4.1-flash'])
check('filteredModels tolerates a missing snapshot', T.filteredModels(null, 'x'), [])

// sectionExpanded: a search forces every section open.
check('sectionExpanded open by default', T.sectionExpanded('deepseek', {}, false), true)
check('sectionExpanded honours a fold', T.sectionExpanded('deepseek', { deepseek: true }, false), false)
check('sectionExpanded ignores folds while filtering', T.sectionExpanded('deepseek', { deepseek: true }, true), true)

// mergeRows: rows missing from the saved order must stay draggable.
check(
  'mergeRows appends rows the order has never seen',
  T.mergeRows(['a', 'b'], ['b', 'c', 'd']),
  ['a', 'b', 'c', 'd'],
)
check('mergeRows keeps the stored order intact', T.mergeRows(['c', 'a'], ['a', 'b']), ['c', 'a', 'b'])
check('mergeRows copes with an empty order', T.mergeRows([], ['a']), ['a'])
check('mergeRows copes with a missing order', T.mergeRows(undefined, ['a', 'b']), ['a', 'b'])

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURE(S):\n  ${failures.join('\n  ')}`)
process.exit(failures.length === 0 ? 0 : 1)
