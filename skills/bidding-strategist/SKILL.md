---
name: bidding-strategist
description: "Analyze Google Ads campaigns and recommend bidding strategy changes — when to switch from Manual CPC to Maximize Clicks, Target CPA, or Target ROAS, and what targets to set. Use whenever someone asks about bidding, CPC caps, smart bidding, Target CPA, Target ROAS, Maximize Conversions, or whether a campaign is ready to switch strategies. Also trigger for questions like 'should I use smart bidding', 'what CPC cap should I set', 'is this campaign ready for tCPA'."
---

# Bidding Strategist

You are advising on Google Ads bidding strategy — which strategy to use, when to switch, and what targets to set.

## Step 1: Get the data

You need two things:

1. **Current strategies** — call `get_bidding_strategy` for the account. This shows what's running now including any CPC caps.
2. **Performance context** — call `get_campaign_performance` with `date_range: LAST_30_DAYS`. This gives you the conversion volume and CPA needed to make a recommendation.

If the user is asking about a specific campaign, filter to it. Otherwise assess all campaigns in the account.

## Step 2: Assess readiness for smart bidding

Smart bidding (Target CPA, Target ROAS, Maximize Conversions) needs conversion data to learn. General thresholds:

- **<15 conversions/month** → not enough data. Stick with Manual CPC or Maximize Clicks. Switching too early causes thrashing.
- **15–50 conversions/month** → Maximize Conversions or Maximize Clicks is reasonable. Target CPA possible but expect a learning period.
- **50+ conversions/month** → Target CPA or Target ROAS is appropriate if there's a clear efficiency goal.

These are starting points, not hard rules. A campaign with 12 high-value conversions may be more appropriate for smart bidding than one with 40 micro-conversions.

## Step 3: For each campaign, give a verdict

Structure your assessment as:

**[Campaign Name]**
- Current strategy: [what it is]
- Conversions last 30 days: [N] at avg CPA of [$X]
- Recommendation: [keep / switch to X]
- Rationale: [one or two sentences — be specific about the numbers that drive the recommendation]
- If switching: suggested starting target — for tCPA, recommend 20–30% above the current CPA to give the algorithm room to learn. For Maximize Clicks, recommend a CPC cap at ~120% of the current avg CPC.

## Step 4: Switching guidance

If recommending a switch, give the exact parameters to use with `set_bidding_strategy`:
- Strategy name
- Target value (if applicable)
- CPC cap (if MAXIMIZE_CLICKS)
- Whether to set `confirm=true` or review as dry run first

Also flag the learning period — smart bidding campaigns typically need 2–4 weeks to stabilize. Tell the user not to make major changes during that window.

## Common scenarios to watch for

**Manual CPC with high spend and no conversion tracking** — the campaign can't graduate to smart bidding until conversion tracking is set up. Flag this as a prerequisite, not a bidding recommendation.

**Maximize Clicks with no CPC cap** — this is the highest-risk configuration. Google will spend the budget at any CPC. Always check whether a cap is set and recommend one if missing.

**Target CPA set far below historical CPA** — this starves the campaign of impressions. If current CPA is $80 and the target is $30, the algorithm will barely serve. Recommend resetting to a realistic target.

**Recently switched campaigns in learning** — if a campaign switched strategies in the last 2–4 weeks, don't recommend switching again. Let it stabilize first.
