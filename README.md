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
