---
name: search-query-miner
description: "Analyze Google Ads search term reports to surface negative keyword opportunities, converting queries, and wasted spend. Use this skill whenever someone asks about search terms, query analysis, what people are searching for, wasted spend, irrelevant clicks, or finding negatives. Also trigger when someone says 'what searches are triggering my ads', 'search query report', or 'mine for negatives'."
---

# Search Query Miner

You are analyzing a Google Ads search term report to help eliminate wasted spend and double down on what's working.

## What to pull

Call `get_search_terms` with the account name and date range. Default to `LAST_30_DAYS` unless the user specifies otherwise.

## How to analyze the results

The report comes back with three buckets: `wasted`, `converting`, and `all_terms`. Work through them in this order:

### 1. Wasted spend (high priority)

These are searches that cost more than $3 with zero conversions. For each:
- Group by theme (e.g., job-seeker terms, wrong-geography terms, competitor names, DIY/how-to intent)
- Flag the match type that let it through — broad match terms sneaking through are a pattern worth calling out
- Note the cost and impressions so the client understands the dollar impact

### 2. Converting queries

These are gold. For each converting search term:
- Check whether it's already an exact-match keyword. If not, recommend adding it as one.
- Flag any converting terms that look like they could anchor a new ad group
- Note CPA if conversions > 1

### 3. Intent patterns across the full term list

Scan `all_terms` for recurring themes that don't convert:
- Information-seeking terms ("how to", "what is", "diy", "cost of")
- Competitor brand terms (if not intentionally targeted)
- Geographic mismatches
- Plural/singular variations that indicate product browsing vs. buying intent

## Output format

Lead with a dollar figure: **"$X in identified wasted spend"** so the value of the analysis is immediately clear.

Then structure your response as:

**Recommended negatives** — grouped by theme, with match type recommendation (exact vs. phrase). Give the rationale for each group in one sentence. Format as ready-to-paste lists.

**Queries to add as keywords** — converting search terms not yet captured as exact match. Include the term, match type, and which ad group it belongs in.

**Observations** — 2–3 broader patterns worth noting (e.g., "Broad match is generating a lot of informational traffic — consider switching to phrase match on [keyword]").

## Tone

Be direct and specific. Dollar amounts, not percentages. Name the actual search terms. The client should be able to hand this output straight to someone to implement.
