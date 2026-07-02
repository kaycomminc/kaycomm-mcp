---
name: pmax-anomaly-detector
description: "Detect and diagnose Performance Max campaign issues — budget hogging, cannibalization of Search campaigns, poor asset group performance, and unexpected spend patterns. Use whenever someone mentions Performance Max, PMax, or asks why a campaign is behaving strangely in an account that has both PMax and Search campaigns. Also trigger for 'PMax is taking all the budget', 'my search campaigns dropped after adding PMax', 'what's PMax doing', or any question about campaign cannibalization."
---

# PMax Anomaly Detector

You are diagnosing Performance Max campaign behavior. PMax is a black box by design, but there are reliable patterns to check when something feels off.

## Step 1: Pull the data

- `get_campaign_performance` with `LAST_30_DAYS` — need to see PMax vs. Search campaign spend side by side
- `get_budget_overview` — check daily budget allocations
- `get_keyword_performance` — impression share data for Search campaigns
- `compare_periods` with `last_30_days_vs_prior_30_days` — to detect recent shifts

## Step 2: Identify PMax campaigns

Look for campaigns with `type: PERFORMANCE_MAX` in the campaign list. Note their spend, conversions, and CPA relative to the Search campaigns in the same account.

## Step 3: Run the anomaly checks

### Budget hogging
Is PMax consuming a disproportionate share of the account budget? Calculate PMax spend as % of total account spend. If PMax is >60% of spend but delivering <40% of conversions relative to Search, flag it.

Note: PMax is often given a separate campaign budget, but shared budgets can cause it to crowd out Search. Check the budget structure.

### Search campaign cannibalization
The most common PMax problem. Signs:
- Search campaign impression share dropped after PMax launched
- Search clicks fell while PMax impressions rose
- Brand search terms showing in PMax asset groups instead of dedicated brand campaigns

If IS dropped by more than 10–15 percentage points since PMax launched, that's a red flag.

### Conversion quality
PMax often reports high conversion volume by counting micro-conversions (page views, engagement) if the conversion setup isn't tight. Check:
- Is PMax CPA dramatically lower than Search CPA? (Could indicate different conversion types being counted)
- Is PMax CPA dramatically higher? (Could indicate it's burning budget on low-intent placements)

A healthy PMax CPA is usually within 30% of the Search CPA for the same product/service.

### Spend volatility
PMax spend can swing dramatically day-to-day. If the client noticed sudden spend spikes, check for:
- High-traffic days (holidays, weather events for local service businesses)
- Budget lifting from paused Search campaigns freeing up shared budget
- Seasonal audience signals the algorithm picked up

### Missing brand exclusions
PMax will bid on branded searches unless explicitly excluded. If you see branded terms showing high impressions in PMax, the account may be paying elevated CPCs for searches where organic results would have converted anyway. Recommend adding brand terms as campaign-level negative keywords.

## Step 4: Output format

**Status**: One-line verdict — Healthy / Needs attention / Significant issue detected

**Findings** (bullet each anomaly):
- What's happening
- The evidence (specific numbers)
- Whether it's a PMax problem or a setup problem

**Recommendations**: Ordered by impact. For each:
- The specific action
- Expected outcome
- Whether it can be done with an available tool (negative keywords → `add_negative_keywords`, budget change → `update_budget`, asset group visibility → `get_pmax_asset_groups`)

## Important context

PMax is not inherently bad — it works well for ecommerce accounts with strong asset libraries and clear conversion signals. For local service businesses (most of the KayComm portfolio), PMax is harder to control and may underperform targeted Search campaigns. Be honest about this tradeoff when it's relevant.

If you don't have enough data to diagnose (e.g., PMax only launched recently, or there are <30 days of data), say so clearly rather than speculating.
