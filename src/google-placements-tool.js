const tool = {
  name: "get_placements",
  description: "Where Google Ads (YouTube / Display / Demand Gen) ads actually showed — placement report. " +
    "view=channel (default) rolls up to YouTube channel, website domain or app; view=detail lists individual YouTube videos and pages (with their parent channel URL). " +
    "Returns spend, impressions, clicks, CTR, conversions, and for video: views, view_rate, avg_cpv, cpv (quartile completion is not available on placement views). Sorted by spend, capped by top_n. " +
    "Use to spot junk placements (kids content, apps, MFA sites) or low-completion channels to exclude. PMax is not covered (use get_pmax_channel_performance).",
  inputSchema: {
    type: "object",
    properties: {
      account_name: { type: "string", description: "Client name (partial match ok)" },
      campaign_name: { type: "string", description: "Campaign name filter (substring). Omit for all campaigns." },
      view: { type: "string", enum: ["channel", "detail"], description: "channel (default) = channel/domain/app level; detail = individual videos/pages" },
      date_range: { type: "string", description: "THIS_MONTH (default), LAST_7_DAYS, LAST_30_DAYS, LAST_90_DAYS, LAST_MONTH, YEAR_TO_DATE, or CUSTOM (requires start_date + end_date)", enum: ["THIS_MONTH", "LAST_7_DAYS", "LAST_30_DAYS", "LAST_90_DAYS", "LAST_MONTH", "YEAR_TO_DATE", "CUSTOM"] },
      start_date: { type: "string", description: "Start date YYYY-MM-DD (only with CUSTOM)" },
      end_date: { type: "string", description: "End date YYYY-MM-DD (only with CUSTOM)" },
      top_n: { type: "integer", description: "Max placements to return, by spend desc (default 50, max 500)" },
      min_impressions: { type: "integer", description: "Drop placements below this many impressions (default 0)" },
    },
    required: ["account_name"],
  },
};

async function handleGetPlacements(args, {
  googleAccounts,
  getGoogleAccessToken,
  resolveGaqlDateClause,
  fetchPlacementPerformance,
  clampTopN,
  placementViews,
}) {
  const search = (args.account_name || "").toLowerCase();
  const dateRange = args.date_range || "THIS_MONTH";
  const view = args.view || "channel";
  const match = Object.entries(googleAccounts).find(([, info]) => info.name.toLowerCase().includes(search));
  if (!match) return { error: `No Google account found matching '${args.account_name}'` };
  if (!placementViews[view]) return { error: `Unknown view '${view}'. Valid: ${Object.keys(placementViews).join(", ")}.` };
  if (dateRange === "CUSTOM" && !(args.start_date && args.end_date)) {
    return { error: "date_range CUSTOM requires both start_date and end_date (YYYY-MM-DD)." };
  }

  const [customerId, info] = match;
  const { token, error } = await getGoogleAccessToken(customerId);
  if (error) return { error: `Auth failed: ${error}` };

  try {
    const dateClause = resolveGaqlDateClause(dateRange, args.start_date, args.end_date);
    const minImpressions = Math.max(0, parseInt(args.min_impressions, 10) || 0);
    const report = await fetchPlacementPerformance(token, customerId, info.mcc, dateClause, view,
      args.campaign_name, clampTopN(args.top_n, 50), minImpressions);
    return {
      account: info.name,
      date_range: dateRange,
      date_clause: dateClause,
      view,
      ...(args.campaign_name ? { campaign_filter: args.campaign_name } : {}),
      ...report,
      ...(report.totals.placements_total === 0
        ? { note: "No placement data in this range (placement views only cover Display/Video/Demand Gen delivery)." }
        : {}),
    };
  } catch (error) {
    return { error: error.message };
  }
}

module.exports = { tool, handleGetPlacements };
