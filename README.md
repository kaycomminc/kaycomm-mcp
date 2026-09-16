# KayComm MCP

Custom MCP server (Node.js, HTTP/SSE, deployed on Railway) connecting Claude to
the Google Ads API and Meta Graph API across accounts under MCC `8621281595`.

- Entry point: `server.js`
- Account config: `accounts.json` — **committed to git**; Railway picks up config
  changes on deploy, so an account edit is not live until it is pushed.
- Local tool runs: `node test.js <tool_name> '<json args>'`
- Unit tests: `npm test`

API versions are pinned at the top of `server.js`
(`GOOGLE_API_VERSION`, `META_API_VERSION`) and surfaced with an age warning by
`health_check`.

---

## Shopping / product-level reporting

These tools answer product-level questions on ecommerce accounts, where
campaign-level reporting is too coarse to diagnose anything.

### `get_shopping_performance`

Product-level performance from `shopping_performance_view`, which covers both
Shopping and Performance Max **retail** campaigns.

| Param | Notes |
| --- | --- |
| `account_name` | required, partial match |
| `date_range` | `LAST_30_DAYS` (default), `THIS_MONTH`, `LAST_7_DAYS`, `LAST_90_DAYS`, `LAST_MONTH`, `YEAR_TO_DATE`, `CUSTOM` |
| `start_date` / `end_date` | required with `CUSTOM`, `YYYY-MM-DD` |
| `group_by` | `item_id` (default), `title`, `product_type`, `brand`, `custom_label_0`–`custom_label_4` |
| `top_n` | default 50, max 500 |

Each row returns the grouping dimension plus spend, impressions, clicks, CTR,
avg CPC, conversions, conv value, CPA and ROAS. Alongside the rows:

- `totals` — every row in the period, not just the returned ones.
- `returned` — how many rows came back and what **share of total spend** they
  represent, so a truncated report is never mistaken for the whole account.
- `reconciliation` — campaign-level spend for `SHOPPING` + `PERFORMANCE_MAX`
  campaigns over the same dates, with the difference against the product view.

**Reading the reconciliation.** `product_serving_campaign_spend` is the sum of
the Shopping and PMax campaigns you would see in `get_campaign_performance` for
the same period. Two expected sources of difference:

- A positive difference is normal for PMax. Asset groups without a product feed
  serve non-product ads that never appear in `shopping_performance_view`.
- Impressions and clicks are counted differently in this view (per product shown
  in an ad, not per ad) and are **not** expected to tie out. Only spend should
  reconcile, and only for product-serving inventory.

Two field-naming traps, both verified against the v24 resource definitions:

- There is **no** `segments.product_custom_label*` field. Merchant Center custom
  labels come back as `segments.product_custom_attribute0`–`4`; `group_by`
  translates the friendlier `custom_label_N` name onto them.
- Product type is levelled (`product_type_l1`…`l5`); plain `product_type` is not
  a field. `group_by: product_type` groups on level 1.

### `get_pmax_listing_groups`

The listing group (product partition) tree per Performance Max asset group —
how inventory is actually split up inside PMax.

Structure comes from `asset_group_listing_group_filter`; metrics are only
exposed through `asset_group_product_group_view`, joined back on the filter
resource name. If that view returns nothing usable, the tool returns the
**structure only** with `metrics_available: false` and a `metrics_note`
explaining why, rather than failing the call.

Per asset group it reports node counts (subdivisions / included / excluded),
max depth, per-node metrics, and `is_single_catch_all` — the flag worth looking
for, meaning the entire feed sits in one undifferentiated bucket so bidding and
reporting cannot separate products.

Rollups sum **leaf (unit) nodes only**; subdivision nodes report the aggregate
of their children, so summing every node would double-count.

---

## Response size

`get_pmax_search_terms` used to return payloads large enough to overflow a model
context window. All product/term reporting tools now:

- cap rows with `top_n` (default 50, hard max 500),
- sort by spend descending,
- and return aggregate rollups (totals, wasted-spend totals, share of spend)
  that cover **every** row, not just the returned ones.

A truncated response always says so via `truncated` / `note`.

---

## Merchant Center (future)

Everything above is Ads-side: a product only appears once it has served. Feed
attributes that only Merchant Center knows are **not** available here:

- full product titles, GTIN / MPN, price, availability
- product status and **disapproval reasons**

Adding these needs the Merchant Center Content API and the separate
`https://www.googleapis.com/auth/content` OAuth scope — a different credential
grant than the Google Ads scope this server currently holds, which is why it is
a follow-up rather than part of this pass.

**Where it slots in:** `fetchShoppingPerformance()` in `server.js` (see the
`SHOPPING_GROUP_DIMENSIONS` block, which carries the same note). A
`fetchMerchantProducts()` would fetch feed rows and join to the product report
on `item_id`, letting `get_shopping_performance` flag products that are
disapproved or out of stock rather than just low-spend.

---

## Google Ads API v24 notes

Field availability changes between versions; verify against the resource
definitions for the pinned version before adding GAQL.

- `asset_group_asset` has **no** `performance_label`. Google removed aggregate
  asset performance labels for asset groups; in v24 `performance_label` survives
  only on `ad_group_ad_asset_view` (Search/Display RSAs), which PMax asset
  groups do not report into. `get_pmax_asset_groups` with `include_assets=true`
  returns per-asset **serving status** instead — `primary_status`,
  `primary_status_reasons` and policy `approval_status` — which answers the
  question the flag was really for: which assets are held back. The response
  carries a `note` saying labels are unavailable, and a `needs_attention` list
  of assets whose primary status is not `ELIGIBLE`.

---

## Write safety

`resolveAccount` settles which account a write lands in. Two things extend it.

**Ambiguity is an error inside the account too.** Campaign, ad group, adset and
list lookups still called `.find()` on a substring, which silently takes the
first match — `campaign_name: "Brand"` against "Brand - Search" /
"Brand - Shopping" paused whichever Google returned first. `matchByName` applies
the same rules `resolveAccount` uses to the object being mutated: prefer an
exact (case-insensitive) name, return the candidates rather than guess when
several match.

**A confirmed write must name its target exactly.** Partial names still resolve
for discovery and dry runs, but `confirm=true` requires the full name, for both
the account and the object. The dry run echoes it, so the flow is: call without
`confirm`, read the exact name back, re-run with it. This closes the path where
one call both chose the target by substring and mutated it, with no preview in
between.

Read-only tools are unchanged — partial matching is what makes them convenient,
and they cannot damage anything.

## Inactive accounts

An account we can no longer reach — cancelled, or access revoked at the MCC —
returns an error row on every pacing call. Two permanent errors train you to skim
past error rows, which is exactly when a new one needs to stand out.

Mark it in `accounts.json`:

```json
"6754409854": {
  "name": "Axis Office",
  "budget": 10000,
  "mcc": "7631184147",
  "inactive": "CUSTOMER_NOT_ENABLED — account disabled in Google Ads"
}
```

The pacing tools skip the API call and report it under a top-level `skipped`
list with its budget and reason, so the roster stays complete while `accounts`
carries only live rows. `"inactive": true` works too, with a generic reason. A
row carrying `error` is still a live row — a real failure is never filed away as
an expected skip. Remove the key when access is restored.

## Lifetime budgets and pacing confidence

`current_daily_budget` sums enabled **daily** budgets, so a Meta campaign on a
lifetime budget contributes nothing to it and the account reads as underfunded.
Every RAISE / LOWER recommendation derives from that number, so acting on one
would double-fund the account.

When lifetime budgets are present, `daily_budget` carries `confidence: "reduced"`
and a `REDUCED_CONFIDENCE` recommendation naming the shortfall without advising a
change, rather than a confident RAISE beside a note that is easy to read past.

## MCP hardening and client compatibility

Node.js 22–24 is required. Every tool call is validated against its published
JSON schema before any provider request: confirmation must be the boolean
`true`, dates must be real and ordered, and financial inputs cannot be negative.
Unknown arguments are rejected rather than silently ignored. Tool annotations
are client hints, not a substitute for server-side validation or user approval.

Known raw Meta object references are checked against the selected ad account;
Google customer-qualified resource names must match the selected customer.
Account and named-object matching protections from the earlier release remain.

Confirmed operations reserve an atomic idempotency record **before** execution.
The store uses Postgres when `DATABASE_URL` is configured; otherwise it uses
`WRITE_STATE_DIR`, or `.mcp-write-state` beside `WRITE_LOG_FILE`. Use persistent
storage in production. Initialization status is exposed by `health_check`.
Never bypass a storage failure: writes fail closed. Postgres coordinates replicas;
filesystem storage only coordinates processes sharing the same directory.

- Reuse `idempotency_key` when retrying the same requested operation.
- Without a key, the canonical tool arguments identify the operation.
- Completed and uncertain operations do **not** automatically expire. A new
  key means a deliberately new operation, not an automatic retry workaround.
- A timeout or partial failure can mean the provider already applied some or
  all changes. Reconcile the account before authorizing another operation.
- This prevents concurrent/replayed calls with the same identity; it cannot
  provide transactional rollback across multiple Google/Meta requests.

New audit entries use an operational metadata allowlist and mode `0600`.
Audience data, media uploads, webhook secrets, targeting payloads, creative copy,
and provider error bodies are excluded. Existing historical logs are not erased
by deployment and should be reviewed separately for older sensitive entries.

Responses preserve existing data fields and add `_meta` with status, request ID,
duration, build SHA, errors, and account coverage when applicable. The MCP result
also includes `structuredContent` and sets `isError` for complete failures.
Partial failures remain usable but must not be interpreted as complete coverage.

HTTP bodies are capped at 10 MiB, malformed requests are contained, and legacy
SSE sessions use separate server instances. Upstream calls default to 30 seconds
(`MCP_UPSTREAM_TIMEOUT_MS`); a complete tool defaults to 150 seconds
(`MCP_TOOL_TIMEOUT_MS`). Configure clients for at least 180 seconds. Slow or
aborted confirmed writes must be reconciled, never blindly retried.

Google/Meta pacing uses at most five concurrent accounts per platform, isolates
row failures, and shares flight/monthly calculations with account detail.
Meta daily-budget inputs follow every page; missing budget data is reported as
`daily_budget_error` and never generates a RAISE recommendation. PMax listing
groups expose parent IDs and distinguish hierarchical metrics from additive
leaf totals. Search-term `wasted` fields are compatibility labels for review
candidates, not automatic negative-keyword instructions.

### Client credentials

Prefer a token-free `/mcp` URL with `Authorization: Bearer …`. The local Codex
plugin uses `bearer_token_env_var: "KAYCOMM_MCP_TOKEN"` and a 180-second timeout;
no secret belongs in a distributable plugin. Legacy query/path authentication
remains for existing Claude connectors. Removing a secret from a plugin does
not revoke previously exposed copies: rotate the shared server token only after
all connected clients have a coordinated migration path. Do not share old
token-bearing plugin archives, logs, or conversation links.

### Meta image enhancement workflow

`manage_meta` → `get_creative_details` now returns `degrees_of_freedom_spec`,
`image_crops`, image/thumbnail URLs, and effective post identity alongside existing
placement asset rules. A missing enhancement is **unspecified**, not disabled.

`prepare_meta_image_enhancements` takes an account, a source `creative_id`, and
an `enhancements` map. Supported features are `image_uncrop` (image expansion),
`image_auto_crop`, `image_touchups`, and `image_brightness_and_contrast`, each
with `OPT_IN` or `OPT_OUT`. Omit `confirm` for a read-only payload preview.
`confirm=true` creates an **unattached replacement creative** and reads its
settings back; it never changes a live ad. Keep the returned ID if readback fails,
and reconcile rather than repeating creation. Confirmed retries are protected
by the existing persistent idempotency guard.

Preview the replacement with `preview_meta_ad` for each relevant placement.
Only after visual review, use `update_meta_object` at ad level with
`updates: {creative: {creative_id: "replacement ID"}}` to attach it. Retain the
original creative ID for rollback. Replacing a creative can create a new post
identity and trigger Meta review. Enrollment alone cannot guarantee that Meta
will generate an expanded image or that text/logos will fit every placement.

Preparation currently supports unpublished single-image link creatives only.
Video, existing-post, catalog, carousel and placement-asset creatives are rejected
rather than flattened. Their settings can still be inspected. This tool controls
Meta rendering enhancements; it does not export AI-edited bitmap files.

API references: [Meta image expansion example](https://www.postman.com/meta/facebook-marketing-api/request/f4q2498/8-creating-single-image-ad-with-image-uncrop)
and [Meta feature schema](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adcreativefeaturesspec.py).

### Resize artwork for individual Meta placements

`prepare_meta_placement_images` creates real resized PNG assets, uploads them to
the selected account, and builds a new unattached creative with explicit
`asset_customization_rules`. Example dry-run arguments:

```json
{
  "account_name": "Summit Express",
  "creative_id": "SOURCE_CREATIVE_ID",
  "variants": [
    { "width": 1080, "height": 1350, "placements": ["instagram_feed", "facebook_feed"], "padding": 50 },
    { "width": 1080, "height": 1080, "placements": ["instagram_explore", "facebook_right_column"] },
    { "width": 1080, "height": 1920, "placements": ["instagram_stories", "instagram_reels", "facebook_stories", "facebook_reels"], "padding": 100 }
  ]
}
```

Each variant supports `fit: "contain"` (default; preserves all artwork) or
`fit: "cover"` (explicit center crop), a six-digit hex `background` (default
white), and optional pixel `padding` on all edges. Sizes are configurable from
100 to 4096 pixels per side. Placement names cannot overlap across variants.
The selected ad set must already allow the placements; this tool does not
change targeting. Story/Reel UI overlays still require visual safe-area review.

Unspecified placements use the original image. Automatic image cropping is
explicitly opted out on the new creative. Other enhancement settings are
preserved; their rendering effects should be reviewed in previews. The source
must be an unpublished single-image link creative with a headline and primary
text. Specialized CTA destinations, existing placement-asset creatives and
unsupported link fields fail closed rather than silently losing content.

`confirm=true` uploads the rendered assets and creates an unattached creative;
returned `verified` checks the image labels, placement routing, and auto-crop
opt-out returned by Meta. A partial failure includes uploaded image hashes and
any known creative ID for reconciliation. Do not blindly retry a failed write.
Use `preview_meta_ad` before attaching through `update_meta_object`; keep the
original creative ID for rollback. No live ad is modified by preparation.

The server downloads only HTTPS Meta CDN image URLs obtained from the account's
media library, rejects redirects and oversized downloads, limits decoded pixels,
and accepts only still JPEG/PNG/WebP source images. Resizing uses Sharp; it does
not invent missing text, logos or photographic content.

For recovery, a variant may include `image_hash` to reuse an existing image from
this account instead of resizing/uploading again. Its stored dimensions must
match the variant. `manage_meta` → `list_creatives` with optional `target` name
filter finds unattached creatives for reconciliation. The retired
`standard_enhancements` bundle is omitted when Meta returns individual feature
settings alongside it; those individual settings are retained. Bundle-only
legacy creatives require explicit migration.
