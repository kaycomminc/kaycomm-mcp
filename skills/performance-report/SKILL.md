---
name: performance-report
description: "Generate a structured performance report for a client — pulling spend, conversions, CPA, ROAS, and key wins/concerns for a given period. Use whenever someone asks for a report, monthly recap, performance summary, client update, or results overview. Also trigger for 'how did [client] perform', 'put together a report for', 'what were the results this month', or any request that involves summarizing campaign results for a client or internal review."
---

# Performance Report

You are building a performance report that could go directly to a client or be used in an internal review. It should tell a clear story — not just show numbers.

## Step 1: Determine scope

Clarify (or infer from context):
- **Which client?** (account name)
- **Which period?** Default to `THIS_MONTH`. Also pull `compare_periods` with `this_month_vs_last_month` so you can show trends.
- **Which platforms?** Check both Google and Meta if the client has both.
- **Is this for the client directly, or internal?** Client-facing = lighter on jargon, more narrative. Internal = can be more technical.

## Step 2: Pull the data

Run these in parallel:
- `get_campaign_performance` — the primary performance source
- `compare_periods` with `this_month_vs_last_month` — for trend context
- `get_account_detail` — for pacing context (how much of the budget has been used)

## Step 3: Build the report

### Header
- Client name, reporting period, date generated

### At-a-Glance Summary (the most important section)
A 3–5 sentence narrative that answers: *How did this month go?* Be direct — if it was a strong month, say so. If there were challenges, name them. Don't bury the lead.

### Key Metrics Table

| Metric | This Month | Last Month | Change |
|--------|-----------|------------|--------|
| Spend | | | |
| Clicks | | | |
| Conversions | | | |
| CPA | | | |
| ROAS (if applicable) | | | |
| Impression Share (Google) | | | |

Fill in actuals. For change, use +/- % and add a brief qualifier if the direction is counterintuitive (e.g., "CPA increased but conversion volume grew 40%").

### Campaign Breakdown
For each platform the client is on, list campaigns and their key metrics. Sort by spend descending. Flag any campaign that's significantly over or underperforming vs. the account average.

### What Worked
2–3 specific, concrete wins. Not vague ("clicks were up") — specific ("Competitor campaign generated 8 leads at $42 CPA, down from $67 last month").

### What to Watch
1–2 areas of concern or things to monitor. Frame constructively — not "this campaign failed" but "the [X] campaign spent $180 with no conversions this month; we're watching it and will pause if it continues."

### Next Steps
3–5 concrete planned actions for the coming month. These should flow logically from the report — if you flagged a concern, the next step addresses it.

## Formatting guidance

- Use dollar amounts with commas for anything over $999
- Round CPAs to the nearest dollar, ROAS to 2 decimal places
- Impression share as a percentage (e.g., 42%)
- Don't show metrics that aren't meaningful for this account (e.g., ROAS if there's no revenue tracking)

## Tone calibration

**Client-facing**: Professional but conversational. Avoid acronyms without spelling them out first. Lead with outcomes, not platform mechanics.

**Internal**: Can be terser. Acronyms fine. Include any account health flags that wouldn't go to the client.

## Optional: Save as a document

If the user wants a Word doc or PDF version, mention that you can generate one with the docx or pdf skill.
