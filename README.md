# dsh-ofm-health

Show **dsh-our-free-model** connectivity and measured speed next to the composer's
model selector, so a model's health is visible **while choosing** instead of after
the first failed request.

## What it adds

One control in the composer toolbar (`conversation.input.right`): a pill reading
`OFM 12/47`, where the number is how many models have positive evidence of working.
Clicking it opens a panel listing **every** model this DSH can offer — the plugin's
own free lane, the Kilo pool, the EAC rows, and every account channel.

### Grouped by model family, not by lane

The lane is an implementation detail. What a chooser actually compares is *which
DeepSeek*, never *which free lane* — so rows are grouped by the model family and the
sections keep a **fixed order**:

```
▾ DeepSeek 3/9
  ● DeepSeek-V4.1-Flash · x0.05   LobsterAI (有道)   首字 1.2s · 322 tok/s · 41/43
  ● Deepseek-V4.1-Flash · x0.11   CodeBuddy (腾讯)    首字 2.5s · 244 tok/s · 88/88
  ● DeepSeek-V4.1-Flash · x0.25   Raccoon (商汤)     首字 2.7s · 231 tok/s · 120/121
  ● EAC DeepSeek V4.1 Flash Free  Our Free Model   首字 4.0s · 1/1
    实测失败 deepseek-v4.1-flash   CodeArts Agent   0/2
  ○ DeepSeek-V41-Flash            DeepSeek
▾ GLM 1/3
  ● EAC GLM 5.3                   Our Free Model   首字 1.4s · 1/1
  ...
▾ Kimi 0/3 全部不可用
▾ HY (Hunyuan) 1/3
▾ GPT 0/1 全部不可用
▾ Qwen 1/2
```

The first six sections are `DeepSeek → GLM → Kimi → HY → GPT → Qwen`; anything else
follows. **A family never moves because its models changed health** — health only
reorders rows *inside* a family:

1. the versions of one model (the same `v4.1-flash` through Qoder, WorkBuddy,
   CodeArts) stay adjacent, so the comparison is one glance;
2. inside a family, variant clusters that have anything usable sort above clusters
   that have nothing usable, and working rows come first inside a cluster.

A section with no usable model says so on its header (`0/3 全部不可用`) and dims.

### One line, in the order that decides a choice

```
模型名 · xNN   厂商   首字 · tok/s · 成功/总数
```

- `· x0.11` is the channel's price multiplier, shown apart from the name
- the provider is what distinguishes two rows of the same model, so it sits next
- `成功/总数` counts real requests (`0/3` means three attempts, none worked)
- a healthy row carries no status word — the dot says it; a broken one names why
- a long model name **wraps** rather than being truncated: it is the field the
  panel exists to show, so it may take a second line before it loses a character

### No freshness column

Each row used to end with how old its evidence was (`刚刚` / `5m` / `今天` …). It
was honest — `token-ledger.json` is bucketed by calendar day and records no time —
but it was also the least actionable column in the row: a channel is either
answering now or it is not, and an age cannot tell you which.

The display is gone. The Host still records the timestamps (`lastEvidenceAt`,
`lastDay`, `probeAt`) and still puts them in the snapshot; the panel simply no
longer draws them. "Is it working right now?" is answered by the `测试` button,
which asks the channel instead of inferring from the past.

## Active testing

The panel used to be strictly read-only, which is why some rows could never
change: `dsh-our-free-model` deliberately never probes the Kilo pool, the EAC
rows, aggregates or combos, so those rows only ever move when *you* happen to
send a real turn through them.

Each row has a `测试` button, and the header has `测试展开项`. Both make one real
request through the same `llm` service the agent uses — same adapter, same
credentials, same route — with the prompt `请从 1 数到 40，只输出数字，用英文逗号分隔。`,
200 output tokens, and a 125s deadline (the client gives up 15s later than the
Host, so a slow channel is reported by the Host rather than cut off here).

The sweep covers **only the expanded sections**, narrowed by the search box.
Folding a group is how you say "not this one", and the old behaviour — sweeping
`data.models` regardless of folds and cutting it off after twelve — spent most of
its time on rows nobody was looking at. A `停止` button appears while it runs; it
finishes the row in flight and then stops, because abandoning a live POST would
keep burning a channel slot.

The answer is reported as:

- `首字` — time to first token, which is what a chooser actually feels
- `tok/s` — decode throughput: `usage.outputTokens / decodeMs`, where `decodeMs`
  runs from the first token to the last. The first-token wait is deliberately
  **not** in the denominator — see below
- pass/fail, and the adapter's own error text when it fails

### Why the old tok/s read "a few tok/s"

The test used to ask for `Reply with exactly: OK` with 16 tokens, and divide
`outputTokens` by the whole elapsed time. Both halves of that were wrong:

| channel | before | after |
| --- | --- | --- |
| buddy | 58.7 | 292 |
| workbuddy -sg | 44.4 | 336.9 |
| qodercn | 93.6 | 282.8 |
| opencode free | 30.9 | 197.8 |
| raccoon | 54.4 | 101.2 |

Two tokens over a 2.5 s request (of which 2.4 s was waiting for the first token)
is arithmetically 0.8 tok/s, and says nothing about the channel. The ledger's own
figure — `pack.js:32205`, `outputTokens / (duration - ttft)` — was always the right
definition; the panel now uses the same one, computed from `decodeMs` measured on
the Host.

A model that only reasons and never emits text still counts as working: the
request reached it and it produced tokens, which is exactly the kind of model
this machine is full of.

The result is kept in memory on the Host (capped at 500 entries) so the next
snapshot poll folds it in and it survives a page reload — but it is **never
written to the data directory or the ledger**. A test cannot corrupt what the
plugin's own measurements say.

Tests run at most 4 at a time; the rest answer immediately with
`同时进行的测试已达上限（4）`.

### Where the panel goes on a narrow screen

The panel is 620px wide and hangs off the right edge of its trigger, which is right
while the viewport is wider than the panel. A phone is not: at 390px the anchor puts
the panel's left edge far off the screen, so the sheet renders as a clipped strip.

So below `620 + 8×2 = 636px` the panel stops anchoring and centres on the viewport
instead, narrowing to `viewport − 16px`:

| viewport | width | placement | row layout |
| --- | --- | --- | --- |
| 1440×900 | 620 | anchored to the trigger | one line |
| 636×900 | 620 | anchored (last width that fits) | one line |
| 635×900 | 619 | centred | one line |
| 576×900 | 560 | centred | one line (last width that does not wrap) |
| 575×900 | 559 | centred | three cells × two lines |
| 390×844 | 374 | centred | three cells × two lines |
| 320×640 | 304 | centred | three cells × two lines |

620 is the width a row needs to hold a long model name (`Deepseek-V4.1-Flash`), its
multiplier, a provider name (`CodeBuddy (腾讯)`) and four measured columns on one
line without truncating any of them. Below that the name wraps instead of being
clipped, so nothing is ever hidden — the row just gets taller.

### Three cells, two lines each, on a phone

Wrapping alone was not enough. At 374px the row still had to fit four things on one
line, and flexbox did what it always does with a crowded line: it shrank the middle.
The result was `Lobste…` and `CodeBu…` in the one column that tells two rows of
`DeepSeek-V4.1-Flash` apart, and `首字 1.7s · 3…` in the column that holds the answer.

So below `panel width < 560px` — which is any phone, and never a desktop window —
`ModelLine` is laid out as three fixed cells, each allowed two lines:

| cell | width | line 1 | line 2 |
| --- | --- | --- | --- |
| model + `· xNN` | `1 1 0` (the remainder) | `DeepSeek-V4.1-Flash` | `· x0.11` |
| company | `0 0 78px`, centred | `CodeBuddy` | `(腾讯)` |
| numbers | `0 0 88px` | `首字 777ms` | `298 tok/s · 3/3` |

The company column is centred and fixed-width in **both** layouts (`110px` on
desktop, `78px` on a phone). It was auto-width before, which made every row place
the company at a different x — `Qoder` sat left, `CodeArts Agent` pushed right — so
a column of rows had no vertical line to read down and looked ragged even though
each row was individually fine. 110px is the width of the longest name the account
channels actually use, `CodeBuddy (腾讯)`.

Centring the company cell is not enough on its own: its x is decided by the width
of everything to its left, which is what the rest of that row adds up to. So every
cell on a wide row after the model name carries a **fixed** track — `0 0 56px` for
the status word (drawn even when blank, otherwise the broken rows would be the
only ones that shift), `0 0 160px` for the numbers. The numbers cell used to be
`1 1 auto`, sized by its own text; `298 tok/s · 3/3` is wider than `首字 777ms`, so
each row claimed a different share of the line and pushed the company to a
different x. With all the tracks fixed, the model cell is the only flexible one:
620 − 20 padding − 48 gaps − 8 handle − 6 dot − 110 company − 56 status −
160 numbers − 32 button leaves 180px for the name. The narrow layout uses the same
rule (`0 0 88px` for the numbers).

The model and company cells use `-webkit-line-clamp: 2` (a string, not `2` — React
appends `px` to a bare number it does not recognise as unitless, and
`-webkit-line-clamp: 2px` clamps nothing). The numbers cell is a flex column rather
than wrapping text, so the rate can never push the success ratio off the bottom.

An unusable row replaces the numbers with its reason, still in the same two lines.

Vertical alignment moves to `flex-start` for these rows, so the dot and the grab
handle do not float to the middle of a two-line cell.

A centred panel keeps 24px free above and below itself rather than filling the
viewport. Tapping outside is the only way to dismiss it on a phone — the trigger it
hangs off is underneath the panel by then — so that strip is what keeps the panel
closable, and it also leaves the composer in view.

`panelStyle(box, viewport)` is pure and exported on `__test`, so the table above is a
smoke test rather than a manual check.

## Where the numbers come from

Nothing here measures anything itself. Three sources are folded together:

| source | what it supplies |
| --- | --- |
| `llm.listProviders()` / `listModels()` | the authoritative roster — **the only place the account channels appear** |
| `dsh-our-free-model`'s `availability.json` / `catalog.json` / `stats.json` | probe verdicts + real request samples for its own lanes |
| `channel-pack/token-ledger.json` | per-provider/per-model request ledger — the only health evidence the channels ever produce |
| active test (on demand) | one real call, made when you click, with a timestamp that is certainly now |

The Host half folds those into one flat snapshot; the Client half renders it.


### Two kinds of evidence, kept apart

- **`可用` / `不可用` / `地区受限` / `限流`** — a *probe* result, from the plugin's own
  probe run. Only the free lane is probed.
- **`实测可用` / `实测失败`** — no probe happened; this is the outcome of the last
  request this machine actually made. This is the **only** honest evidence for the
  models `dsh-our-free-model` deliberately never probes (the Kilo pool, EAC rows,
  aggregates, combos).

They are never merged, because they mean different things: a probe can be stale or a
model can be intermittent. `未探测` means exactly that — no evidence either way.

## Files

| path | role |
| --- | --- |
| `lib/index.js` | Host half: the snapshot route, the order route, the test route |
| `lib/client.js` | Client half: the composer control and panel |
| `cordis.patch.yml` | Profile bundle patch (`id: dsh-ofm-health`) |

## Routes

```
GET  /api/ofm-health/state    → the snapshot the panel renders
POST /api/ofm-health/order    → { families, models } replacement, per-browser
POST /api/ofm-health/test     → { provider, model, effort?, timeoutMs? } → one measurement
```

All three are same-origin and cookie-authenticated; each is gated by DSH's
`connection` trust fence exactly like the shell's own plugin endpoints.

**Why `/api/` and not `/plugins/`.** The fence admits a request only when its
`Host` looks loopback (or trusted/bind-address). A phone arrives from the LAN or the
relay, so it is never loopback, and its bare request is rejected with `403`. The
`@linxin666/dsh-remote-web-ui` paired channel is the one thing that fixes that: it
reattaches the device credential and replays the call as a loopback-shaped request —
but its rewrite table is hardcoded to `/api/*`, `/sidebar`, `/git`, `/pet` only. A
route under `/plugins/` is never rewritten, so the phone's fetch never enters the
channel, the fence answers `403`, and the panel falls back to `尚无探测记录`. Keeping
these routes under `/api/ofm-health/` puts them inside the table, which makes the
mobile path work with no change to that plugin.

`/test` is the only one that causes network traffic, so it is deliberately narrow:
the body must name a `provider` and `model` that the **last snapshot listed** (`404`
otherwise), and the reply never contains credentials. It does not write to the data
directory, the credentials store, or DSH configuration — the measurement is returned
and kept in memory only.

The gate used to be `llm.listProviders()`, which was the wrong authority: the panel
draws rows the registry never advertises — channel models known only from
`token-ledger.json`, free-lane aliases the plugin discovered itself — so those rows
had no button, and a hand-made request came back `清单里没有 …`. What the panel lists,
the panel may test. An id the adapter cannot serve still fails honestly, with its own
error, which is more useful than a 404 about a catalogue the user never saw.

`timeoutMs` in the body caps the Host's own deadline (clamped to 10 minutes,
default 120s). Even then the abort is advisory — CodeArts retries a queued request
every 10s for up to 30 minutes and its `delay(ms, signal)` resolves on abort rather
than rejecting — so the read loop also races a hard deadline at `timeoutMs + 5s`.
Without that, one stuck row would hold the route open for half an hour and stall any
sweep waiting on it.

The Host half only picks up code changes on a DSH restart (the client half reloads
by itself via `dsh-client-hmr`). Until then the buttons answer with
`宿主端尚未加载测试路由，请重启 DSH` rather than a bare HTTP status.

## Install

```powershell
dsh plugin --profile desktop add file:<path-to-this-package>
```

Or from the Web UI's plugin manager. The package declares `dsh.bundle.patch`, so the
entry is inserted by `cordis.patch.yml`; do not add it to the profile's own
`cordis.patch.yml` by hand.

Installing copies the files into the profile's `node_modules`; re-install to pick up
edits.

## Data directory resolution

Tried in order, first hit wins:

1. `$DSH_OFM_DATA_DIR`
2. `$DSH_HOME/our-free-model`
3. `$DSH_PROFILE_DIR/our-free-model`
4. `~/.dsh/our-free-model`

## Scope

Companion view with an explicit "measure it now" button. It does not change your
model, your default model, or the model list — the shipped selector is untouched, and
this plugin registers a fresh slot id (`ofm-health`) rather than replacing a shipped
cell. The only writes it ever makes are to its own order file
(`~/.dsh/ofm-health/order.json`) and its heartbeat; the test route writes nothing.
