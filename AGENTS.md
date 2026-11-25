# KayComm MCP development playbook

## Data sources

- Pull advertising data exclusively through the **kaycomm-pacing MCP**. NEVER use Supermetrics for campaign data, pacing, keywords, search terms, or any other data retrieval.
- If kaycomm-pacing is unavailable, report the limitation; do not substitute another connector or bypass it with direct API pulls for analysis.
- Server implementation still integrates with provider APIs; use mocked provider responses for development tests.

## Repository map

- `server.js`: server startup, tool catalog, dispatch, provider integrations, account resolution, and response handling.
- `src/mcp/contracts.js`: strict schemas, argument validation, tool annotations, response metadata, and write identities.
- `src/mcp/ownership.js`: provider resource ownership checks.
- `src/mcp/write-guard.js`: persistent write reservations using Postgres or files.
- `src/mcp/http.js`: HTTP validation and transport helpers.
- `src/google-*.js`, `src/meta-*.js`, `src/drive-creative.js`: extracted feature modules. Follow adjacent module patterns.
- `src/accounts-github.js`: serialized account configuration sync with GitHub.
- `src/digest/`: scheduled pacing digest; `src/archive/`: database and change collection.
- `accounts.json`: tracked account configuration. Do not include client details in unrelated reports or fixtures.
- `tests/`: Node test runner coverage; `skills/`: advertising workflows; `README.md`: tool usage and contracts.

## Commands and validation

- Runtime: Node.js 22–24, CommonJS. Install locked dependencies with `npm ci` when needed.
- Full suite: `npm test`.
- Focused suite: `node --test tests/<file>.test.js`.
- Syntax check: `node --check server.js` (or the changed JavaScript module).
- Server: `npm start`. Starting the server can activate configured background services; prefer tests for verification.
- `node test.js <tool_name> '<json args>'` is a credentialed tool runner, NOT an offline unit test. It loads local credentials and can contact providers or mutate real accounts. Do not use it for routine tests or as an alternate advertising data source.
- Keep automated tests hermetic: use fixtures, mocked fetch, temporary storage, and the existing `MCP_TEST=1` patterns. Never load real credentials into regression tests.
- For behavior changes, run relevant tests, then the full suite before handoff. Documentation-only changes need diff/link checks, not a full test run.

## Adding or changing a tool

1. Inspect a similar tool's catalog entry, dispatcher, module, and tests before editing.
2. Define the input schema and wire dispatch through the existing validated handler. Preserve strict types and rejection of unknown arguments.
3. Reuse account matching and ownership checks; do not resolve ambiguity by selecting the first result.
4. Preserve response fields and `_meta` status/errors/coverage. Partial failures must remain distinguishable from complete results.
5. For reporting, bound returned rows and disclose truncation; compute aggregate totals over the complete result set. Preserve date, currency, timezone, and attribution semantics.
6. Add regression coverage for the changed behavior, including meaningful failure cases. For writes, cover dry runs, exact targets, ownership, and replay protection as applicable.
7. Document user-visible parameters and behavior in `README.md`.

## Mutation safeguards

- Preserve dry-run defaults. A mutation requires the boolean `confirm: true` and authorization covering the actual operation; a coding request alone does not authorize live advertising changes.
- Confirmed writes must use exact target names or supported IDs and verify resource ownership. Partial names are for discovery or previews only.
- Reserve the write identity before execution. Never bypass storage failures or remove idempotency records to make a retry succeed.
- Reuse the same idempotency key for the same operation. Reconcile timeouts and partial/unknown outcomes before retrying; a fresh key represents an intentionally new operation.
- Preserve audit redaction. Never commit credentials, tokens, `.env` contents, audience data, or sensitive provider payloads.

## T3 workflow and collaboration

- Start with `git status --short`; preserve existing user edits. Keep each development task focused on one outcome.
- Keep advertising investigations separate from implementation tasks; carry a minimal, redacted reproduction into a bug fix.
- Use one implementing agent by default. When the user requests multiple agents, T3 can delegate to Codex and Claude from the same parent request.
- Discover available providers/models before delegation. Do not silently substitute an unavailable requested model.
- For implementation plus review, finish a reviewable diff first, then give the other provider a read-only review brief with scope, changed files or commit, test results, and specific risks to check.
- For independent implementation tasks running concurrently, use T3-managed separate worktrees. Avoid concurrent writers to the same checkout or file.
- Give each delegate a self-contained brief and this playbook's path; do not assume it inherits the parent conversation.
- The lead agent resolves findings and verifies the final diff. A second model's approval does not replace tests.

## Deployment and completion

- Railway configuration is in `railway.json`; startup runs `node server.js`, and the deployment health probe is `/healthz`.
- `accounts.json`-only changes are excluded from Railway rebuilds. With `ACCOUNTS_GITHUB_TOKEN` configured, the server syncs with GitHub and refreshes at `ACCOUNTS_REFRESH_MINUTES` (default five minutes). Verify runtime refresh instead of assuming a push caused a deployment.
- Without GitHub sync, account edits persist locally and need the appropriate persistence/deployment path. Railway's ephemeral filesystem is not durable configuration storage.
- For an authorized code deployment, verify the deployed revision, `/healthz`, and the relevant read-only MCP behavior. `health_check` exposes additional diagnostics, including write-store initialization; process health alone does not prove provider access.
- Report separately: local edits/tests, commit/push/PR status, and deployed verification. Do not claim deployment from a passing local test or a push alone.
- Keep handoffs concise: what changed, validation results, remaining limitations, and deployment status. Link the changed files and any PR.
