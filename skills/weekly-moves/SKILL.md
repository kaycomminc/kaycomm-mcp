---
name: weekly-moves
description: "Build a ranked shortlist of this week's moves for one client account — find what's burning spend, explain why numbers moved, decide keep/cut/fix/scale for each flagged item, and rank by dollar impact. Nothing is changed until the user approves specific items. Use whenever someone asks 'what should I do this week for [client]', 'weekly moves', 'weekly review', 'what should I change first', 'what's burning budget', 'give me a shortlist', or wants prioritized actions rather than a full audit."
---

# Weekly Moves

You turn a week of account data into a short, ranked list of moves, each with a reason. The output is a shortlist, not a report. If nothing is worth changing, say so.

Run on **one account at a time**. If the user names no account, ask which one. If they say "all", run `check_anomalies` + `get_full_pacing` first and suggest the 3 accounts most worth a pass.

Default window: last 7 days vs prior 7 days.

## Stage 1 — Find (pull in parallel)

Context:
- `manage_accounts` — action `context` (budgets, notes, inactive flags; respect any client notes)
- `get_account_detail` — MTD pacing for this client

Google:
- `compare_periods` — `last_7_days_vs_prior_7_days`, platform `both`
- `get_campaign_performance` — `LAST_7_DAYS`, platform `both`
- `get_keyword_performance` — `LAST_7_DAYS`, filter `non_converting`
- `get_search_terms` — `LAST_7_DAYS`, `summary_only: true`
- `get_conversion_health` — this account

Meta (if the client has Meta):
- `get_meta_ad_performance` — `LAST_7_DAYS`, `sort_by: spend`
- `run_health_check` — `account: <client>`, `weekly: true` (Meta frequency, CTR decay, IS decay)

Flag an item when any of these hold (scale thresholds to account size — a $300/mo account and a $30k/mo account are not the same):
- Spend ≥ 2× account average CPA (or ≥ $100 if no conversion history) with 0 conversions
- CPA ≥ 1.5× the account's 7-day CPA, with spend ≥ 1× account CPA
- CTR down ≥ 30% vs prior 7 days on meaningful volume (≥ 1,000 impr)
- Meta frequency > 3 (prospecting) or creative fatigue flagged by health check
- Wasted search terms (cost > $3, 0 conv) totaling ≥ 5% of Google spend
- Campaign limited by budget while CPA is ≤ account average → scale candidate
- Pacing > 110% or < 85% of expected MTD
- Conversion action GONE_SILENT → always flag first (it corrupts every other number)

Cap at ~15 flags. Drop the smallest by spend.

## Stage 2 — Explain

For each flag, find the cause before recommending anything:
- `get_change_history` — `days: 14` — did someone change bids, budgets, ads, keywords right before the shift?
- `get_performance_breakdown` — segment `device` or `geo` for the affected campaign (Google) when the cause isn't obvious
- Check against `get_conversion_health` — a tracking break looks like a performance drop

Assign one cause: **recent change · creative fatigue · auction/CPC pressure · tracking break · budget cap · audience/query drift · seasonality · normal variance**.

If it's normal variance (low volume, < ~20 clicks or < 3 conversions either side), drop the flag. Don't recommend moves on noise.

## Stage 3 — Qualify

Give each remaining item one verdict and a one-line reason that cites numbers:
- **Cut** — pause the ad, keyword, or ad set; add negatives
- **Fix** — tracking, landing page, ad copy, targeting; needs a human or a separate task
- **Scale** — raise budget; it's efficient and capped
- **Hold** — in learning phase, launched < 7 days ago, or too little data. Note it and move on.

Never recommend cutting the only active ad in an ad group/ad set, or pausing something the client notes say to leave alone.

## Stage 4 — Prioritise

Score = weekly $ impact × confidence ÷ effort.
- **$ impact** — wasted spend recovered, or estimated extra conversions × account CPA
- **Confidence** — High (clear cause, enough data), Med, Low
- **Effort** — 1 (one tool call), 2 (several calls), 3 (needs human work: creative, landing page, client approval)

Tracking breaks always rank #1 regardless of score. Show the top 5–10.

## Output format

```
<Client> — week of <Mon date> · 7d spend $X (±Y% vs prior) · CPA $X (±Y%) · MTD pacing Z%

#  | Move                              | Why                                         | Est. $/wk | Conf | Action
1  | Pause ad "Fall promo v2"          | $410, 0 conv, CTR -45% since Oct 28 edit    | +$410     | High | pause_ad
2  | Add 6 negatives (jobs, free, diy) | $185 on irrelevant terms                    | +$185     | High | add_negative_keywords
3  | Raise "Brand" budget $20→$30/day  | Budget-capped, CPA $18 vs acct $41          | ~+3 conv  | Med  | update_budget
4  | Refresh Meta creative, ad set "X" | Frequency 4.2, CTR -38% w/w                 | —         | Med  | manual
```

Then:
- **Holds:** one line listing items you're watching but not acting on
- **Ask:** "Approve which #? (e.g. `1,2` or `all`)"

Keep the whole response to one screen.

## Stage 5 — Approval gate

**Do not call any write tool until the user approves specific numbers.**

When they approve:
1. Run each approved write as a dry run first (omit `confirm`) and show the preview
2. On a second confirmation, re-run with `confirm: true`
3. If a dry run doesn't match what was proposed (wrong ad matched, multiple matches), stop and show it — don't widen with `all_matches`

Write tools by move type:
- Google ad → `pause_ad` (prefer `ad_resource_names` from `get_ad_copy`)
- Google keyword → `pause_keyword`
- Negatives → `add_negative_keywords` (PHRASE for themes, EXACT for single queries)
- Budget → `update_budget` (Google or Meta campaign)
- Meta ad / ad set status → `update_meta_object` (`level: ad|adset`, `fields: {status: "PAUSED"}`); Meta budget changes also need `budget_confirmed: true`

Finish with `get_write_log` for this account, `days: 1`, and list what was applied.

## Tone

Senior media buyer handing a colleague the week's to-do list. Specific numbers, no filler, no hedging. If the account is healthy, say "No moves worth making this week" and list holds only.
