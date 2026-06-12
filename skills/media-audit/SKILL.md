---
name: media-audit
description: "Run a comprehensive audit of a client's Google Ads (and optionally Meta) account — covering performance, keywords, search terms, bidding, ad copy, and recommendations. Use whenever someone asks for an audit, account review, health check, or full analysis of a client's account. Also trigger for questions like 'how is [client] doing overall', 'give me a full picture of [account]', 'what should we fix first', or 'do a deep dive on [client]'."
---

# Media Audit

You are conducting a structured audit of a client's paid media account. The goal is a prioritized list of issues and opportunities, not a data dump.

## Data to pull (do these in parallel where possible)

For Google:
- `get_campaign_performance` — `LAST_30_DAYS`, platform `google`
- `get_keyword_performance` — `LAST_30_DAYS`
- `get_search_terms` — `LAST_30_DAYS`
- `get_bidding_strategy` — current strategies and caps
- `get_recommendations` — Google's own suggestions
- `get_account_detail` — MTD pacing

For Meta (if they have a Meta account):
- `get_campaign_performance` — `LAST_30_DAYS`, platform `meta`
- `get_account_detail` — MTD pacing

## Audit framework

Work through these sections. Skip any where there's no data to report.

### 1. Pacing & budget health
- On track to hit monthly budget?
- Any campaigns paused mid-month that shouldn't be?
- Any campaigns capped by daily budget (budget limiting reach)?

### 2. Campaign performance
- Top-spending campaigns by ROI (CPA or ROAS if tracked, otherwise clicks/spend)
- Campaigns spending money with zero conversions — flag if spend > $200 with 0 convs
- Impression share: are we losing IS to budget or rank?

### 3. Keyword health
- Average Quality Score — below 5/10 is worth flagging at the account level
- Keywords with QS ≤ 4 that are spending money — these cost more per click and hurt overall performance
- Keywords with no clicks in 30 days — candidates for pausing
- High-spend, zero-conversion keywords (>$50, 0 convs)

### 4. Search term hygiene
- Dollar amount in wasted spend (cost > $3, 0 convs)
- Top wasted themes (job seekers, wrong geography, DIY intent, etc.)
- Converting search terms not yet captured as exact match

### 5. Bidding strategy review
- Any campaigns on Manual CPC that have enough conversion data for smart bidding?
- Any Maximize Clicks campaigns without a CPC cap?
- Any Target CPA targets set unrealistically low vs. actual CPA?

### 6. Google's recommendations
- Summarize the top 2–3 recommendation types by count
- Flag any high-impact ones (budget increases, keyword additions, bidding changes)
- Note which ones to accept vs. ignore (Google often recommends broad match and increased budgets — these need scrutiny)

## Output format

**Executive summary** (3–5 sentences max): What's the overall health of the account, and what's the single most important thing to fix right now?

**Issues by priority:**

🔴 **High** — actively losing money or blocking performance (e.g., wasted spend >$500/month, campaigns hitting budget cap daily, QS 3 keywords spending heavily)

🟡 **Medium** — meaningful opportunity being missed (e.g., converting search terms not added as exact match, smart bidding available but not enabled)

🟢 **Low** — housekeeping and optimization (e.g., pausing dormant keywords, adding extensions)

For each issue:
- What's happening
- Dollar or percentage impact where you can quantify it
- Specific recommended action (with tool call if applicable)

## Tone

Write this like a senior account manager who's been running the account for years. Be specific and direct. Don't soften findings with filler language. If there's a $400/month leak, say so plainly.
