const Ajv = require('ajv');
const { createHash, randomUUID } = require('node:crypto');
const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });
const validators = new WeakMap();

function fault(code, message) { return Object.assign(new Error(message), { code }); }
function strictSchema(schema) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object' && schema.properties) schema.additionalProperties = false;
  for (const child of Object.values(schema.properties || {})) strictSchema(child);
  if (schema.items) strictSchema(schema.items);
}
function decorateTool(tool) {
  strictSchema(tool.inputSchema);
  const writeCapable = !!tool.inputSchema.properties?.confirm;
  if (writeCapable) tool.inputSchema.properties.idempotency_key = {
    type: 'string', minLength: 1, maxLength: 128,
    description: 'Reuse the same key when retrying a confirmed operation. Use a new key only for a deliberately new operation.',
  };
  tool.annotations = { readOnlyHint: !writeCapable, destructiveHint: writeCapable,
    idempotentHint: !writeCapable, openWorldHint: true };
  tool.outputSchema = { type: 'object', required: ['_meta'], properties: {
    _meta: { type: 'object', required: ['status', 'request_id', 'duration_ms', 'errors'], properties: {
      status: { enum: ['success', 'partial_success', 'error'] }, request_id: { type: 'string' },
      duration_ms: { type: 'number' }, errors: { type: 'array', items: { type: 'object' } },
    }, additionalProperties: true },
  }, additionalProperties: true };
  return tool;
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function validateArgs(tool, args) {
  if (!tool) throw fault('UNKNOWN_TOOL', 'Unknown tool');
  let validate = validators.get(tool);
  if (!validate) { validate = ajv.compile(tool.inputSchema); validators.set(tool, validate); }
  if (!validate(args)) throw fault('INVALID_ARGUMENT', ajv.errorsText(validate.errors, { dataVar: 'arguments' }));
  for (const field of ['account_name', 'account', 'name']) {
    if (args[field] !== undefined && typeof args[field] === 'string' && !args[field].trim())
      throw fault('INVALID_ARGUMENT', `${field} must not be empty`);
  }
  const custom = args.date_range === 'CUSTOM' || args.start_date !== undefined || args.end_date !== undefined;
  if (custom) {
    if (!validDate(args.start_date) || !validDate(args.end_date) || args.start_date > args.end_date)
      throw fault('INVALID_DATE_RANGE', 'Provide valid start_date and end_date (YYYY-MM-DD), with start_date <= end_date');
    if (args.date_range && args.date_range !== 'CUSTOM')
      throw fault('INVALID_DATE_RANGE', 'Use date_range=CUSTOM when supplying start_date and end_date');
  }
  for (const field of ['flight_start', 'flight_end']) {
    if (args[field] !== undefined && !validDate(args[field]))
      throw fault('INVALID_DATE_RANGE', `${field} must be a valid YYYY-MM-DD date`);
  }
  if (args.flight_start && args.flight_end && args.flight_start > args.flight_end)
    throw fault('INVALID_DATE_RANGE', 'flight_start must be on or before flight_end');
  // Enforce financial types before any provider call, including nested campaign/ad-set inputs.
  const moneyFields = new Set(['budget', 'nc_budget', 'daily_budget', 'lifetime_budget', 'spend_cap', 'bid_amount', 'roas_control',
    'daily_min_spend_target', 'daily_spend_cap', 'lifetime_min_spend_target', 'lifetime_spend_cap',
    'target_cpa', 'target_roas', 'cpc_bid_ceiling']);
  const walk = (value, parent = '') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, v] of Object.entries(value)) {
      if (moneyFields.has(key) && (typeof v !== 'number' || !Number.isFinite(v) || v < 0))
        throw fault('INVALID_ARGUMENT', `${parent}${key} must be a finite, non-negative number`);
      walk(v, `${parent}${key}.`);
    }
  };
  walk(args);
}
function uniqueName(items, search, label = 'target') {
  const s = (search || '').trim().toLowerCase();
  if (!s) throw fault('INVALID_ARGUMENT', `${label} name is required`);
  const exact = items.filter(x => x.name?.toLowerCase() === s);
  const matches = exact.length ? exact : items.filter(x => x.name?.toLowerCase().includes(s));
  if (matches.length > 1) throw fault('AMBIGUOUS_TARGET', `Ambiguous ${label}: ${matches.map(x => `${x.name} [${x.id || x.resource_name || 'no ID'}]`).join(', ')}. Use an exact unique name or resource ID.`);
  return matches[0];
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function writeIdentity(name, args) {
  const { confirm, idempotency_key, ...payload } = args;
  const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const payloadHash = digest([name, canonical(payload)]);
  const key = idempotency_key ? digest([name, args.account_name || '', idempotency_key]) : payloadHash;
  return { key, payloadHash };
}
function errorInfo(error, path = '$', account) {
  const message = typeof error === 'string' ? error : error?.message || 'Tool failed';
  const code = (typeof error === 'object' && error?.code) || message.match(/^([A-Z][A-Z_]+):/)?.[1] || 'TOOL_ERROR';
  return { path, ...(account ? { account } : {}), code, message,
    retryable: /TIMEOUT|RATE_LIMIT|RESOURCE_EXHAUSTED|UNAVAILABLE/.test(code) };
}
function annotateResult(result, context) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) result = { data: result ?? null };
  // Normalize the few legacy branches that returned an MCP result inside the tool data.
  if (result.content?.[0]?.type === 'text') {
    try { result = JSON.parse(result.content[0].text); } catch (_) { /* preserve non-JSON content */ }
  }
  const errors = [];
  function scan(v, at = '$', account) {
    if (!v || typeof v !== 'object') return;
    const a = typeof v.account === 'string' ? v.account : account;
    if (v.error) errors.push(errorInfo({ message: typeof v.error === 'string' ? v.error : JSON.stringify(v.error), code: v.code }, at, a));
    for (const [key, child] of Object.entries(v)) {
      if (key === '_meta' || key === 'error') continue;
      if (key === 'errors' && Array.isArray(child)) {
        child.forEach((error, i) => {
          if (typeof error === 'string' || error?.message) errors.push(errorInfo(error, `${at}.errors.${i}`, a));
          else scan(error, `${at}.errors.${i}`, a);
        });
      } else scan(child, `${at}.${key}`, a);
    }
  }
  scan(result);
  let status = result.error ? 'error' : errors.length ? 'partial_success' : 'success';
  const asRows = value => Array.isArray(value) ? value : [];
  const rows = result.accounts || result.results || (result.google || result.meta ? [...asRows(result.google), ...asRows(result.meta), ...asRows(result.stackadapt), ...asRows(result.linkedin)] : null);
  let coverage;
  if (Array.isArray(rows) && rows.length) {
    const failed = rows.filter(r => r.error).length;
    const skipped = asRows(result.skipped).length;
    coverage = { total: rows.length + skipped, succeeded: rows.length - failed, failed, ...(skipped ? { skipped } : {}) };
    if (failed === rows.length) status = 'error';
  }
  return { ...result, _meta: { status, request_id: context.requestId || randomUUID(),
    duration_ms: Date.now() - context.started, timezone: process.env.REPORT_TIMEZONE || 'America/New_York',
    build_sha: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.BUILD_SHA || 'local',
    ...(coverage ? { coverage } : {}), errors } };
}

module.exports = { fault, decorateTool, validateArgs, uniqueName, writeIdentity, annotateResult, validDate };
