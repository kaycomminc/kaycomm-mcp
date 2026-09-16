# KayComm MCP — Review Fix Plan (2026-09-14)

Execute tasks in order. One commit per task (one-line message ending with the
Co-Authored-By trailer below). **Never `git push`** (push = Railway deploy).
**Never call mutation tools against client accounts** (anything with
`confirm: true`). Read-only verification only.

Commit trailer:
```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

Style: 4-space indent in server.js, 2-space in src/, match surrounding code,
section banners `// ── Title ──`. No new npm dependencies.

Verification commands (read-only):
- `npm test`
- `node test.js health_check`
- `node test.js get_full_pacing`
- `node test.js run_health_check '{"platform":"google","account":"Woca"}'`

If a verification fails and the fix isn't obvious within two attempts, stop
that task, `git checkout -- .` for its files, note it in the final report, and
move on.

---

## Task 1 — Fix `run_health_check` crash (`cid is not defined`)

server.js ~line 9484, inside `name === "run_health_check"` → Google checks:
```js
const { token, error: authErr } = await getGoogleAccessToken(cid);
if (authErr) { errors.push(...) } else { for (const [cid, gAcct] of pickAccounts(GOOGLE_ACCOUNTS)) { ...
```
`cid` isn't in scope yet. Restructure so the token is fetched **per account
inside the loop** (accounts can use different `refresh_token_env`):
- remove the outer token fetch / `if (authErr) ... else` wrapper,
- at the top of the loop body: `const { token, error: authErr } = await getGoogleAccessToken(cid);`
  `if (authErr) { errors.push(\`${gAcct.name} (Google): Auth: ${authErr}\`); continue; }`
- keep everything else identical; fix brace balance.

Verify: `node test.js run_health_check '{"platform":"google","account":"Woca"}'`
returns findings JSON (not ERROR). Also run with `'{"platform":"both"}'`.

## Task 2 — Per-account pacing tolerance + fix failing test

- `getPacingLabel(spent, budget, dom, dim, tolerancePct = PACING_TOLERANCE_PCT)`:
  use `tolerancePct` in the status comparison. Same for the second label
  function using `PACING_TOLERANCE_PCT` at ~line 258 (add a trailing param) and
  `buildDailyBudgetRec` at ~line 284 if it takes the tolerance there.
- Callers (~lines 547, 549, 550, 567, 603, and getFlightPacing callers 528, 588,
  2935 if applicable): pass `getHealthConfig(info)?.pacing_tolerance_pct ?? PACING_TOLERANCE_PCT`.
  Note `getHealthConfig` returns null for `health:false` — the `?.` handles it.
- **Precedence problem:** `health_defaults.pacing_tolerance_pct` in accounts.json
  is 15, which would silently undo the 5% tightening for every account. Change
  `health_defaults.pacing_tolerance_pct` in accounts.json AND
  `BUILTIN_HEALTH_DEFAULTS.pacing_tolerance_pct` in server.js to **5**. Keep
  CTSC's explicit override of 10.
- Update `tests/pacing.test.js` "last day of month" test: with default 5%,
  950/1000 on day 31 is UNDERPACING — assert that, and add a test that passing
  `tolerancePct = 15` returns "ON PACE".

Verify: `npm test` all pass; `node test.js get_full_pacing` runs.

## Task 3 — Archiver uses retired API version + wrong timezone

- `src/archive/change_collector.js:52`: replace `process.env.GOOGLE_API_VERSION || "v19"`
  with `process.env.GOOGLE_API_VERSION || "v24"` and add a comment: keep in sync
  with GOOGLE_API_VERSION in server.js. (Don't require server.js — circular.)
- server.js archiver cron (~line 11138): timezone `"America/New_York"`, log
  message "6:00 AM ET".

Verify: `node -e 'require("./src/archive/change_collector.js")'` loads.

## Task 4 — Digest derives accounts from accounts.json

`src/digest/config.js` is a hand list that has drifted (DPoH ended 8/26, FAMU
platforms wrong, PHQ/La Loma/FSG/DPG/Charlie's Soap/Gulf Coast missing).
- Replace the static `ACCOUNTS` with a builder that reads `../../accounts.json`
  (fs.readFileSync + JSON.parse at require time) and produces one entry per
  unique account **name**, `platforms` = the platforms (google/meta) it appears in,
  `flight` = has flight_start/flight_end, `label` = name.
- Exclude entries whose `flight_end` < today (ET, `YYYY-MM-DD` via
  `new Date().toLocaleDateString("en-CA", {timeZone:"America/New_York"})`).
- Keep a small `OVERRIDES` object keyed by name for the existing quirks:
  Summit Express `{ecommerce:true, note}`, Eye Associates note, CTSC label/note,
  Boulevard Carroll label/note. Keep `EXCLUDE` list: Warrior Advocates, Axis Office.
  Remove the stale Spartan Meta note and the DPoH entry.
- Keep `ignoreUnlisted` behavior working (build it from EXCLUDE as
  `google:Name`/`meta:Name`).
- `src/digest/digest.js` `buildPrompt`: delete the hard-coded "Denver Parade of
  Homes" section rule; replace with a generic rule: "Then a 'Flight accounts'
  section for accounts with flight: true — flight to date spend vs flight budget
  and recommended daily." Replace "For Summit Express, include ROAS" with "For
  accounts with a performance block, include ROAS."
- Fix the stale comment in config.js thresholds ("+5% / -15%") → "±5% (per-account override via health.pacing_tolerance_pct)".

Verify: `node -e 'console.log(require("./src/digest/config.js").CONFIG.accounts.map(a=>a.name+":"+a.platforms))'`
lists current accounts; `MCP_TEST=1 node src/digest/digest.js --dry-run` only if
ANTHROPIC_API_KEY is unset or it's acceptable — **skip the dry run** (it calls
the Anthropic API); instead `node -e 'const d=require("./src/digest/digest.js"); console.log(typeof d.buildPrompt)'`.

## Task 5 — Duplicate-write guard + machine-readable guard errors

In `handleToolCall` (server.js ~line 6458), before the dispatch chain:
- Module-level `const RECENT_WRITES = new Map();` (key → timestamp).
- If `args.confirm === true`: key = `name + JSON.stringify(sorted args)`. If
  the same key was seen < 30s ago **and the previous result was ok**, return
  `{ error: "DUPLICATE_WRITE_BLOCKED: identical confirmed call ran <N>s ago. Re-issue after 30s if intentional.", code: "DUPLICATE_WRITE_BLOCKED" }`
  without executing. Record the key after execution only when the result has no `error`.
  Prune entries older than 60s on each call.
- `update_meta_object` budget guard (~line 10883): add `code: "NEEDS_BUDGET_CONFIRMED"`
  to that error object and append to message: "Do not retry without budget_confirmed=true."
- Grep other `BUDGET CHANGE REQUIRES CONFIRMATION` / similar guard errors and add
  a `code` the same way.

Verify: `npm test`; `node test.js health_check`. Do NOT test with a real write.

## Task 6 — Richer write log

`logWriteAction` (~line 164): add to the entry, when available:
- `account`: `args.account_name || args.name || null`
- `summary`: if `result` is an object, a shallow copy of up to these keys present
  on it: `account, campaign, ad_group, updated, resource_name, resource_names,
  previous, previous_budget, old_budget, new_budget, message` (strings truncated
  to 300 chars).
- `code`: `result.code` if present.
Keep the try/catch. `readWriteLog` should still work (it filters on
`args.account_name`; also match `e.account`).

Verify: `npm test`; `node test.js get_write_log '{"days":3}'`.

## Task 7 — Exact-match account resolution for write tools

- Add helper near other helpers:
```js
// Exact name match wins; otherwise a unique substring match. Ambiguous → error.
function resolveAccount(store, search) {
    const s = (search || "").toLowerCase().trim();
    if (!s) return { error: "account_name is required" };
    const entries = Object.entries(store);
    const exact = entries.filter(([, i]) => i.name.toLowerCase() === s);
    if (exact.length === 1) return { match: exact[0] };
    const partial = entries.filter(([, i]) => i.name.toLowerCase().includes(s));
    if (partial.length === 1) return { match: partial[0] };
    if (!partial.length) return { error: `No account matching '${search}'` };
    return { error: `Ambiguous account '${search}' matches: ${partial.map(([, i]) => i.name).join(", ")} — use the exact name` };
}
```
- Apply ONLY inside handlers of tools whose dispatch branch reads `args.confirm`
  (the write tools). Pattern to replace:
  `const match = Object.entries(GOOGLE_ACCOUNTS).find(([, i]) => i.name.toLowerCase().includes(search));`
  → `const { match, error: acctErr } = resolveAccount(GOOGLE_ACCOUNTS, args.account_name);`
  and make the existing `if (!match)` branch return `{ error: acctErr }`.
  Same for META_ACCOUNTS. Leave read-only tools untouched. If a site's shape
  differs, skip it rather than improvise.
- Add unit tests for `resolveAccount` (export it) in `tests/pacing.test.js` or a
  new `tests/accounts.test.js`: exact wins over partial, unique partial, ambiguous, none.

Verify: `npm test`; `node test.js update_ad_url '{"account_name":"Woca","campaign_name":"zzz-nonexistent"}'`
(no final_url → read-only listing / not-found error, never writes).

## Task 8 — Parallelize monitoring loops

Add helper:
```js
// Run fn over items with at most `limit` in flight; preserves order.
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}
```
Convert the serial per-account loops (limit 5) in: `get_conversion_health`
(~7655), `get_ad_disapprovals` (~7686), the next targets loop (~7710), and
`check_anomalies` Google + Meta loops (~7728 onward). Each iteration must
return its own row/flags instead of pushing to shared arrays mid-await where
order matters; push results after `mapLimit` resolves, preserving account order.
Do NOT touch any loop that performs writes.

Verify: `node test.js get_conversion_health` and `node test.js check_anomalies`
return the same shape as before (compare keys against a run captured BEFORE the
change — capture it first to scratch files).

---

## Task 9 — Routines (no git; files under ~/.claude/scheduled-tasks)

Use the scheduled-tasks MCP tools (`update_scheduled_task`, `create_scheduled_task`).

### 9a. Rewrite daily watchdog `kaycomm-pacing-alert`
Schedule: weekdays 8:05 ET (`5 8 * * 1-5`). Replace its prompt (SKILL.md) with
a lean version:
- Data (kaycomm-pacing MCP only, never Supermetrics):
  1. `run_health_check` `{"platform":"both"}` (daily checks incl. pacing drift,
     conversion dry spell, CPA/ROAS vs target, anomalies, zero impressions,
     budget exhaustion).
  2. `get_full_pacing` — for each account compare current daily budget vs
     required daily; recommend a daily budget change only if projected month-end
     miss > $50 AND > 5%.
  3. `get_ad_disapprovals` (all), `get_meta_ad_issues` (each Meta account),
     `get_conversion_health` (all).
  4. `get_write_log` `{"days":14}` — for changes made 7 and 14 days ago, note
     them in a "Change follow-ups" section (what changed, prompt to review impact
     with `compare_periods`).
- State: read `~/.claude/scheduled-tasks/kaycomm-pacing-alert/state.json`
  (create if missing) — map finding key (`account|check|campaign`) → first_seen
  date. Classify each finding NEW / STILL OPEN (N days) / RESOLVED (in state but
  not today). Write the updated state back.
- Rules: CPA/ROAS judged against `cpa_target`/`roas_target` when set; ignore
  swings on < 15 conversions or < $300 spend; treat last 2 days' conversions as
  incomplete (say so); flight accounts use flight pacing; ramping accounts
  (budget_schedule) — note label may be misleading.
- Output: short brief — 🔴 Needs action today (NEW first), 🟡 Still open,
  ✅ Resolved, 🔁 Change follow-ups, ⚠️ Errors. Each action item specific and
  executable (account, campaign, $ amounts).
- End: send a push notification (PushNotification tool) with one line:
  "KayComm: N need action — Acct1, Acct2, Acct3". If nothing, "KayComm: all clear".

### 9b. Create weekly `kaycomm-weekly-optimization`
Schedule Mondays 8:30 ET (`30 8 * * 1`). Prompt:
- For each Google account with search campaigns: `get_search_terms`
  (LAST_7_DAYS, summary_only) → negatives + keyword adds; `get_keyword_performance`
  non_converting (LAST_30_DAYS, > $15 spend) and low_quality_score.
- `run_health_check` `{"platform":"both","weekly":true,"structural":true}`.
- `compare_periods` last_7_days_vs_prior_7_days per account, but only report
  changes that clear the volume floor (≥15 conv or ≥$300 spend) and note
  conversion lag.
- LinkedIn: `get_full_pacing` LinkedIn rows for Florida State Guard.
- Change impact: `get_write_log` days 30 → for budget/bidding/pause changes
  older than 7 days, run `compare_periods` for that account and say whether the
  change helped.
- Skip negatives already recommended last week unless still spending (keep
  `~/.claude/scheduled-tasks/kaycomm-weekly-optimization/state.json`).
- Output per-account action items (same format as old watchdog Part 2). Push
  notification summary at the end. Remind to log applied changes with /track-change.

### 9c. Disable `charlies-soap-audit` if it is a scheduled task (it was a one-off
manual audit). Disable, don't delete. (It may not appear in list_scheduled_tasks —
then just leave the file.)

---

## Deferred (not in this pass)
- Meta token from URL query → Authorization header (many call sites).
- `if/else` dispatch → handler map.
- ESLint `no-undef` (needs a dev dependency).
- Server-side `get_daily_brief` tool + Postgres snapshots/write log.
- Retiring one morning monitor: after this pass Railway = pacing email,
  local routine = actions/state brief; revisit after a week.

## Final report
List each task: done / skipped (why), commit hash, verification output summary.
