# KayComm MCP — Improvement Plan

Self-contained work plan for this repo (`~/kaycomm-mcp`). Execute tasks in order —
Task 1 is the priority. Each task is independent; commit after each one.

## Ground rules

- **Everything lives in `server.js`** (~6,000 lines, single file). Do NOT split it
  into modules, do NOT reformat unrelated code, do NOT upgrade dependencies.
  Match the existing style: 4-space indent, `snake_case` tool names, section
  banners like `// ── Title ──────`.
- **Verify with the local harness**: `node test.js <tool_name> '<json args>'`
  (e.g. `node test.js health_check`). It pulls credentials from Claude Desktop's
  config automatically. `process.env.MCP_TEST=1` prevents `main()` from running
  on require — rely on that in tests too.
- **Commit after each task** with a one-line message. **Do NOT `git push`** —
  pushing triggers a Railway deploy; the user reviews first.
- **Never retry or auto-repeat mutation calls** (anything hitting
  `googleAds:mutate`, `metaPost`, `/copies`, or `saveAccounts`). Writes are
  confirm-gated and audit-logged; a double-fire is worse than a failure.

---

## Task 1 — Streamable HTTP endpoint (makes the MCP work on Claude mobile)

**Problem:** In HTTP mode (Railway, `PORT` set), the server only speaks the
legacy SSE transport (`/sse` + `/messages`, see `main()` near `server.js:5946`).
claude.ai custom connectors — which is how Claude mobile reaches remote MCP
servers — require the Streamable HTTP transport (single `/mcp` endpoint,
JSON-RPC over POST). The installed `@modelcontextprotocol/sdk` is 1.29.0, which
ships `StreamableHTTPServerTransport`.

**Change:**

1. The file currently creates one global `server` and calls
   `server.setRequestHandler(...)` for ListTools and CallTool. Wrap that
   construction in a function `makeServer()` that builds a new `Server`,
   registers both handlers (they are thin wrappers over the `TOOLS` array and
   `handleToolCall`), and returns it. Keep a module-level `const server =
   makeServer()` so stdio mode and the existing SSE mode are unchanged.
2. In the `http.createServer` callback, add a branch for
   `url.pathname === "/mcp"`:
   - Gate it with the existing `isAuthorized(req, url)` (accepts
     `Authorization: Bearer` OR `?token=` — keep both; claude.ai connectors
     can't set headers, so the token rides in the connector URL).
   - Use **stateless** mode: per request, create
     `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`,
     connect it to a **fresh** `makeServer()` instance, parse the JSON body
     (reuse the chunk-reading pattern from the `/messages` branch), and call
     `await transport.handleRequest(req, res, body)`. Close/clean up on
     `res.on("close")`.
   - `GET /mcp` and `DELETE /mcp` should return 405 (stateless mode has no
     session to resume or delete).
   - Import: `require("@modelcontextprotocol/sdk/server/streamableHttp.js")`
     → `{ StreamableHTTPServerTransport }` (CJS path exists in the installed SDK).
3. Leave `/sse` + `/messages` fully intact for backward compatibility.
4. Update the startup `console.error` line to mention both transports.

**Verify** (run locally with `PORT=8788 MCP_AUTH_TOKEN=testtoken node server.js`):

```bash
# initialize handshake must return a JSON-RPC result:
curl -s -X POST 'http://localhost:8788/mcp?token=testtoken' \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
# wrong token must 401:
curl -s -o /dev/null -w '%{http_code}' -X POST 'http://localhost:8788/mcp?token=wrong' \
  -H 'Content-Type: application/json' -d '{}'
# tools/list must return the full tool list (same curl shape, method "tools/list", after an initialize in the same request is NOT needed in stateless mode — each POST stands alone).
```

Also confirm `/sse` still answers 401/200 as before and `node test.js health_check` still works.

**Note for the user (not a code task):** after deploy, add the connector at
claude.ai → Settings → Connectors → Add custom connector, URL
`https://<railway-host>/mcp?token=<MCP_AUTH_TOKEN>`. It then appears on mobile.

---

## Task 2 — Retry with backoff on transient read errors

**Problem:** No retry logic anywhere. Pacing tools fan out to ~25 accounts in
parallel (`buildGoogleRows` / `buildMetaRows`, `server.js:391`), and transient
429/5xx from Google or Meta surface as per-account `error` rows.

**Change:** Add one helper near the other fetch utilities:

```js
async function fetchWithRetry(url, opts, tries = 3) {
    for (let i = 0; ; i++) {
        try {
            const resp = await fetchFn(url, opts);
            if ((resp.status === 429 || resp.status >= 500) && i < tries - 1) {
                await new Promise(r => setTimeout(r, (2 ** i) * 1000 + Math.random() * 250));
                continue;
            }
            return resp;
        } catch (e) {           // network-level failure
            if (i >= tries - 1) throw e;
            await new Promise(r => setTimeout(r, (2 ** i) * 1000 + Math.random() * 250));
        }
    }
}
```

Swap `fetchFn(` → `fetchWithRetry(` **only at read call sites**: `googleSearch`
(`server.js:261`), the Meta insights/GET helpers (`fetchMetaMTD`,
`fetchMetaDailyBudgets`, `metaGet`, `metaGetAll`, and the insights fetches
around lines 804/886/1105), and the GA4 report fetch. Do NOT touch
`googleAds:mutate` call sites, `metaPost`, `/copies` duplication, or the OAuth
token exchange refresh POST (retrying token exchange is fine actually — include
`getGoogleAccessToken`'s fetch too, it's idempotent).

**Verify:** `node test.js get_google_pacing` and `node test.js get_meta_pacing`
return the same shape as before.

---

## Task 3 — Unit tests for the pacing/date math

**Problem:** Pure functions carry the daily-workflow math and have regressed
before (see commit "Fix date/timezone and reliability bugs"). No automated tests.

**Change:**

1. Extend the bottom-of-file export (`module.exports = { handleToolCall }`,
   `server.js:6014`) with the pure helpers: `getPacingLabel`, `getFlightPacing`,
   `buildDailyBudgetRec`, `getDateInfo`, `getEffectiveBudget`, `pctChange`.
2. Create `tests/pacing.test.js` using the built-in `node:test` runner. First
   line: `process.env.MCP_TEST = "1";` then `require("../server.js")`.
3. Add `"test": "node --test tests/"` to package.json scripts.

Cover at minimum: mid-month on-pace / over / under labels; day 1 of month
(no division blowups); last day of month (`days_remaining = 0` — no divide-by-
zero in `buildDailyBudgetRec`); flight window before start, mid-flight, after
end; `budget = 0`; `getEffectiveBudget` with and without `nc_budget` /
flight fields; `pctChange` with prior = 0. Read each function before writing
assertions — assert what the code actually does today; these are regression
locks, not spec changes. If a case reveals a genuine bug (e.g. NaN/Infinity in
output), fix minimally and note it in the commit message.

**Verify:** `npm test` passes; `node test.js get_google_pacing` unchanged.

---

## Task 4 — Loud warning for ephemeral writes on Railway

**Problem:** Railway's filesystem resets on deploy. `manage_accounts`
(`server.js:4562`) writes `accounts.json` via `saveAccounts()`; done against the
Railway instance, the change silently vanishes on the next deploy.

**Change:** In the `manage_accounts` handler, wherever a success result is built
after `saveAccounts()` (the add/update/remove branches around
`server.js:4599–4629`), when `process.env.PORT` is set, add:

```js
result.ephemeral_warning = "⚠️ This server runs on Railway with an ephemeral filesystem — this change will be LOST on the next deploy. Make account changes from the Mac (local server) and commit accounts.json to git.";
```

Keep the existing `note` text as-is.

**Verify:** grep that every `saveAccounts()`-followed result in
`manage_accounts` gets the warning; `node test.js manage_accounts '{"action":"list"}'`
still works (list is read-only — no warning there).

---

## Task 5 — Validate accounts.json on load

**Problem:** `loadAccounts()` (`server.js:63`) accepts anything; a typo like
`"helth"` or a string budget silently misbehaves.

**Change:** After parsing in `loadAccounts()`, warn via `console.error` (never
throw — the server must still boot) when:

- a `google`/`meta` entry lacks a string `name` or has a non-number `budget`;
- a google entry lacks `mcc`;
- `health` is present but neither `false` nor an object;
- a `health` object contains a key not in `BUILTIN_HEALTH_DEFAULTS`
  (`server.js:49`) and not one of the documented per-account extras — check the
  codebase for which extra keys `getHealthConfig`/health checks actually read
  (e.g. `conversion_type`, `cpa_target`, `roas_target`, `impression_share_floor`)
  and whitelist those;
- an entry has an unknown top-level key (whitelist by grepping which `info.*`
  properties the code reads: `name`, `budget`, `mcc`, `nc_budget`, `ga4`,
  `health`, `flight_start`, `flight_end`, plus any others found).

Prefix warnings with `accounts.json:` and the entry id so they're greppable in
Railway logs.

**Verify:** temporarily add `"helth": {}` to one entry, run
`MCP_TEST=1 node -e 'require("./server.js")'`, confirm the warning prints,
revert the temporary edit.

---

## Task 6 — API version age warning in health_check

**Problem:** `GOOGLE_API_VERSION = "v21"` and `META_API_VERSION = "v21.0"`
(`server.js:25–28`) will be sunset by the providers eventually; today that
surfaces only as a surprise 4xx.

**Change:** Next to those constants, add release dates and warn-after horizons:

```js
const API_VERSION_INFO = {
    google: { version: GOOGLE_API_VERSION, released: "2025-08-01", warnAfterMonths: 9 },   // Google sunsets ~12mo after release
    meta:   { version: META_API_VERSION,  released: "2024-10-02", warnAfterMonths: 21 },   // Meta sunsets ~24mo after release
};
```

In the `health_check` tool handler (the one that already reports Meta token
expiry, around `server.js:4528`), compute each version's age and append a
`⚠️ pinned Google Ads API v21 is N months old — check deprecation schedule and bump GOOGLE_API_VERSION`
warning when past the horizon. When bumping versions later, these two dates get
updated by hand — say so in a comment.

**Verify:** `node test.js health_check` runs clean (no warning expected today —
Meta v21.0 hits its 21-month horizon in July 2026, so if it *does* warn, that's
correct behavior; confirm the math rather than suppressing it).

---

## Task 7 — Fix create_campaign INVALID_ARGUMENT (read-only bidding field in create payload)

**Problem:** `create_campaign` with `confirm=true` consistently fails with
"Request contains an invalid argument." (read tools work fine, so auth/access
is not the issue). Root cause, found by inspection 2026-07-21:
`createGoogleCampaignFull` (`server.js:2292`) builds the campaign create op's
bidding fields by reusing `buildBiddingUpdateBody(...).campaignFields`
(`server.js:2229`), which sets `biddingStrategyType` directly. That works for
the **update** path (`set_bidding_strategy`), but per the API docs
`campaign.bidding_strategy_type` is **read-only** — on **create** you must set
the `campaign_bidding_strategy` oneof scheme field instead (`manualCpc: {}`,
`targetSpend: {...}`, `maximizeConversions: {}`, ...). So every create is
rejected regardless of strategy. (The dry-run path never hits the API, which is
why this only surfaces with `confirm=true`. Network settings and geo targeting
were suspected but are NOT the issue — `networkSettings` is already in the
payload and geo targeting is not required.)

**Change (two parts):**

1. In `createGoogleCampaignFull`, stop reusing the update builder. Replace the
   `let biddingFields = ...` block with create-shaped scheme fields:
   - `MANUAL_CPC` (default) → `{ manualCpc: {} }`
   - `MAXIMIZE_CLICKS` → `{ targetSpend: {} }`, plus
     `cpcBidCeilingMicros` inside `targetSpend` when `cpc_bid_ceiling` given
   - `MAXIMIZE_CONVERSIONS` → `{ maximizeConversions: {} }`; when a
     `target_cpa` option is given, set `maximizeConversions: { targetCpaMicros }`
   - `TARGET_CPA` / `TARGET_ROAS` → check current v24 guidance before wiring:
     Google has been migrating standalone TargetCpa/TargetRoas schemes into
     MaximizeConversions/MaximizeConversionValue with targets — prefer the
     migrated form for new campaigns.
   Keep `ENHANCED_CPC` rejected with the existing sunset message (call the
   builder just for validation, or duplicate the check).
2. While in there, fix error surfacing so the next API failure is debuggable:
   `createGoogleCampaignFull` throws `data?.error?.message`, which for Google
   Ads is always the generic "Request contains an invalid argument." — the
   actual field path and error code live in `data.error.details[].errors[]`
   (GoogleAdsFailure). Include those in the thrown message (and `console.error`
   the full JSON so it lands in Railway logs). Apply the same to the other
   `googleAds:mutate` helpers that throw only `error.message`.

**Verify:** `node test.js create_campaign '{"account_name":"<account>", "campaign_name":"ZZZ API Test", "daily_budget":1, "ad_groups":[{"name":"Test AG","keywords":[{"text":"zzz test","match_type":"EXACT"}]}]}'`
(dry run) still works; then ONE confirmed create of the $1/day "ZZZ API Test"
campaign in an account the user names — it starts PAUSED — confirm success,
then remove it in the UI. Do not retry the mutate on failure; capture the (now
detailed) error instead.

---

## Explicitly out of scope

- Splitting server.js into modules.
- Dependency upgrades, new dependencies, or a test framework beyond `node:test`.
- Railway volume for `write-log.jsonl` (infra console change, user does it).
- The morning digest automation (done via Claude scheduled tasks, not this repo).
- `git push` / deploying.

## Done means

`npm test` passes; `node test.js health_check`, `get_google_pacing`, and
`get_meta_pacing` all return normal output; the Task 1 curl checks pass; one
commit per task on the current branch, nothing pushed.
