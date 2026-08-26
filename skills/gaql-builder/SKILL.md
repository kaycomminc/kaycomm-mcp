---
name: gaql-builder
description: "Translate natural-language questions about Google Ads data into valid GAQL queries and execute them. Use when someone asks an ad-hoc question about their Google Ads data that isn't covered by the specialized tools — e.g. 'what ad groups have the highest CPA', 'show me impression share by campaign', 'which keywords have quality score below 5'."
---

# GAQL Builder

You are translating a natural-language question about Google Ads data into a valid GAQL query, validating it, and returning the results.

## Step 1: Understand what they're asking

Map the user's question to:
- **Resource**: which Google Ads resource has the data? (campaign, ad_group, ad_group_ad, keyword_view, search_term_view, ad_group_criterion, geographic_view, etc.)
- **Fields**: which attributes, metrics, and segments answer the question?
- **Filters**: date range, campaign type, status, name patterns, metric thresholds
- **Ordering**: what should be sorted and in which direction?

If you're unsure which fields exist on a resource, call `inspect_google_ads_resource` first. Don't guess field names.

## Step 2: Build the GAQL query

GAQL rules to follow:
- SELECT must list specific fields — no `SELECT *`
- Metrics and segments can only be selected with compatible resources (use `inspect_google_ads_resource` to check if unsure)
- Date filtering uses `segments.date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'` or `segments.date DURING LAST_30_DAYS` (and similar presets)
- `WHERE` clauses on metrics use the field name directly: `WHERE metrics.clicks > 100`
- String matching: `campaign.name LIKE '%brand%'` (case-sensitive)
- Enum values are unquoted: `WHERE campaign.status = ENABLED`
- ORDER BY supports `ASC` and `DESC`
- LIMIT caps the result count

Common resource/field patterns:
- Campaign performance: `SELECT campaign.name, campaign.status, metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.conversions FROM campaign`
- Ad group performance: `SELECT ad_group.name, campaign.name, metrics.clicks, metrics.cost_micros FROM ad_group`
- Keyword performance: `SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, metrics.clicks, metrics.quality_info.quality_score FROM keyword_view`
- Search terms: `SELECT search_term_view.search_term, metrics.clicks, metrics.conversions FROM search_term_view`
- Geographic: `SELECT geographic_view.country_criterion_id, metrics.clicks FROM geographic_view`

## Step 3: Validate before executing

Always call `validate_gaql` with the query first. If validation fails, read the error, fix the query, and validate again. Common mistakes:
- Using fields that don't exist on the resource
- Mixing incompatible segments with certain metrics
- Forgetting that `cost_micros` is in millionths (divide by 1,000,000 for dollars)
- Using `CONTAINS` instead of `LIKE '%text%'`

## Step 4: Execute and present

Once validation passes, call `run_gaql` to execute the query.

When presenting results:
- Convert `cost_micros` to dollars (÷ 1,000,000) and round to 2 decimal places
- Calculate derived metrics the user likely wants (CPA = cost/conversions, CTR = clicks/impressions, CPC = cost/clicks)
- Sort and highlight the answer to their original question
- If the result set is large, summarize the key findings and show the top/bottom entries
