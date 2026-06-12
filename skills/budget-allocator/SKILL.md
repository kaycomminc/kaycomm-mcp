---
name: budget-allocator
description: "Analyze pacing across all accounts and recommend budget adjustments — where to add, cut, or shift spend to hit monthly targets. Use whenever someone asks about budgets, pacing, overspending, underspending, reallocation, or how to adjust spend. Also trigger for questions like 'where should I put more budget', 'which accounts are behind', 'how are we tracking to budget', or any variation of monthly spend management."
---

# Budget Allocator

You are helping optimize budget distribution across client accounts to hit monthly targets without overspending or leaving money on the table.

## Step 1: Pull current pacing

Call `get_full_pacing` to get the current picture across all Google and Meta accounts. Note the date, day of month, and days remaining in the month — these set the context for every recommendation.

## Step 2: Triage the accounts

Sort accounts into three groups:

**Overpacing** — pct_expected > 105%. These accounts are ahead of where they should be given elapsed days. Risk: they'll exhaust the monthly budget early.

**Underpacing** — pct_expected < 85%. These accounts are behind. Risk: they'll underspend and the client won't get full value from their investment.

**On pace** — 85–105%. No action needed unless something specific prompted the review.

## Step 3: For each troubled account, diagnose why

For overpacing accounts:
- Is it a one-time spike (weekend, promotion) or sustained trend?
- How many days are left? If <5, overpacing is less urgent.
- Is the remaining budget still meaningful (>$50)?

For underpacing accounts:
- How far behind are they in dollar terms? (remaining vs. what should be remaining)
- What's the most likely cause: paused campaigns, impression share loss, budget caps being hit and resetting, or a new campaign that hasn't ramped up?

You won't always have visibility into the cause from pacing data alone — flag it as a hypothesis to investigate, not a confirmed diagnosis.

## Step 4: Make specific recommendations

For each recommendation, include:
- **Account name and platform**
- **The specific action** (e.g., "Increase daily budget from $33/day to $45/day", "Pause [Campaign Name] until the 25th")
- **Why** in one sentence
- **Expected impact** (e.g., "should recover ~$200 of underspend over 8 remaining days")

If you'd need to call `list_campaigns` or `update_budget` to execute the change, say so and offer to do it.

## Step 5: Summarize the month

End with a one-paragraph summary:
- Total managed budget this month (sum of all account budgets)
- Projected total spend at current pace
- Dollar gap (over or under)
- Top priority action

## Constraints to keep in mind

- Never recommend increasing a budget past the client's monthly cap without flagging that you're doing so
- If an account has `no_cap` status (no budget set), don't try to calculate pacing — just report the spend and move on
- Flight-based budgets (like Florida DOH Monroe County with a `flight_end` date) may have different logic — note if a campaign is near its flight end
