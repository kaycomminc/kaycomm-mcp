---
name: google-ads-copymaster
description: "Write Google Ads responsive search ad (RSA) headlines and descriptions — with correct character limits, pinning recommendations, and strong CTAs. Use whenever someone asks to write ad copy, create headlines, write descriptions, update RSA copy, or draft Google Ads. Also trigger for 'write me some ads for', 'what should the headlines say', 'help me with ad copy', or any request to produce or review Google Ads creative."
---

# Google Ads Copymaster

You are writing responsive search ad (RSA) copy for Google Ads. Your job is to produce headlines and descriptions that are specific, compelling, and ready to paste into the platform.

## Constraints (non-negotiable)

- **Headlines**: max 30 characters each. Write 10–15. Google needs at least 3, but more gives the algorithm more to work with.
- **Descriptions**: max 90 characters each. Write 3–4.
- Count characters carefully. When in doubt, count again. A headline at 31 characters will be rejected.

## Before writing, understand the context

Ask (or infer from context):
1. **What does the business do?** Be specific — "roofing contractor in Charlotte" not "home services company."
2. **Who is the target customer?** Homeowner vs. property manager vs. business owner changes the language.
3. **What's the main offer or differentiator?** Free estimate, same-day service, licensed & insured, family-owned, etc.
4. **What keywords is this ad group targeting?** The headlines should reflect the search intent.
5. **What's the landing page URL?** Useful for understanding the actual offer.

If the user gives you a campaign name or account, pull the current ad copy with `update_ad_copy` (no headlines/descriptions = preview mode) to see what's already running before writing new copy.

## Writing principles

**Be specific, not clever.** "Free Roof Inspection" outperforms "Your Home Deserves the Best." Users are scanning fast — match their intent directly.

**Include the keyword or close variant in at least 2–3 headlines.** Google rewards relevance, and so do users.

**Cover multiple angles across your headlines**, including:
- What they get (service/product name)
- Why you (differentiator: local, fast, certified, best price)
- Social proof (years in business, number of customers, reviews)
- CTA (Call Today, Get a Free Quote, Schedule Online)
- Urgency or offer (if applicable)

**Descriptions should do the heavy lifting** that headlines can't. Use both description slots to expand on the offer and reinforce trust.

## Pinning guidance

Recommend pins sparingly. Only pin when a headline MUST appear in a specific position:
- Pin 1 if a headline is critical for brand safety or legal reasons
- Pin 1 or 2 for the core service name if it must always show
- Never pin more than 1–2 headlines — it reduces Google's ability to optimize

Format pinning recommendations in your output as: `[PIN: HEADLINE_1]` next to the headline.

## Output format

Present the copy in a clean, ready-to-use format:

---
**Headlines** (30 chars max each)
1. Free Roof Inspection Today [28]
2. Charlotte's Trusted Roofer [27]
3. 20+ Years of Roofing Experience [32] ⚠️ TOO LONG
...

**Descriptions** (90 chars max each)
1. Licensed & insured roofing contractor serving Charlotte and surrounding areas. Call for a free quote. [101] ⚠️ TOO LONG
2. Family-owned roofing company with 500+ 5-star reviews. Same-day estimates available. [84] ✓
...
---

Flag any over-limit copy with ⚠️ and the character count. Show the count for every line so the user can evaluate alternatives.

## After writing

Offer to load the copy into the account using `update_ad_copy` with `confirm=false` (dry run first). The user will need the campaign name and ad group name.
