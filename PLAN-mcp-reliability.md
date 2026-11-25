# KayComm MCP reliability plan

Protect the morning pacing digest from misleading results first, then make those checks run on every proposed change. The baseline is 357 passing tests on Node.js 24.14.0. The review used repository code and local tests with mocked data. Advertising data for analysis and any later smoke test must come exclusively from kaycomm-pacing.

## 1. Make the pacing digest report data gaps accurately

**Observed.** `src/digest/config.js` builds the roster and filters expired flights at module load. A GitHub refresh updates the server's account registry while the digest retains the original roster. An in-process tool failure can return `{error, code, _meta}` with no platform arrays. The digest marks the expected accounts as missing and can produce “all on pace, N no data.” In standalone `--http` mode, the client calls `res.json()` on a response that the server's Streamable HTTP transport sends as an event stream by default. Scheduled runs use the in-process client.

**Change.** Pass an injectable account snapshot and clock to the digest and resolve both at run time. Scheduled runs use the server's current registry. Standalone runs read the configured account file per run. Preserve digest overrides, the current Google/Meta scope, pacing windows, thresholds, and delivery destinations. Keep `--http` and use the MCP SDK SSE client against the server's authenticated `/sse` route. The stateless `/mcp` route creates a fresh server per POST, which does not complete the SDK initialization handshake. Bound requests and close the client after use.

Normalize the current result fields in both client paths. Check top-level `error`, `isError`, `_meta.status`, `_meta.errors`, and platform error rows. Prefer structured content when available and support legacy text content. Retain usable rows on partial failure, mark missing rows as unknown, and emit a clear unavailable outcome for total failure. Retry only transient read failures, including result-level failures with retryable metadata. Return partial data directly.

**Done when.** Injected fixtures cover a roster change between runs, a flight expiring between runs, mixed success and failure, a top-level `error` without platform arrays, skipped accounts, and a successful empty result. Empty coverage and complete failures get distinct subjects without a healthy claim. Test retryable and permanent result-level failures and exercise standalone HTTP against a local authenticated SDK SSE server. All tests use fixture data without provider calls or notifications.

## 2. Define how reporting tools communicate coverage

**Observed.** `src/mcp/contracts.js` infers coverage from generic arrays. For full pacing, a platform-wide error without an account identity can enter the same row count as individual accounts. Empty or skipped-only results may have no coverage object. `server.js` also emits reporting errors in multiple shapes, including platform-specific keys, which generic error traversal does not necessarily see.

**Change.** Start with `get_full_pacing` and `get_campaign_performance`. Define what account coverage counts, how platform-wide failures are represented, and how zero rows differ from complete failure. Add explicit empty and complete coverage flags to report results, while omitting coverage from tools that return no account rows. Preserve legacy fields and verify text and structured responses agree. Update the digest to use the richer coverage when present while continuing to handle older results.

**Done when.** Fixture tests prove that a failed platform appears in errors without being presented as an account, skipped accounts are represented accurately, and partial results retain valid data. Cover healthy reports with zero campaign rows and mixed Google/Meta results.

## 3. Run the existing tests automatically and exercise real MCP transports

**Observed.** The repo has no tracked CI workflow. Current coverage includes MCP handlers, mocked requests through the real `/mcp` route, and a socket test for the HTTP body reader. The full suite runs quickly enough to be a practical prerequisite for PRs.

**Change.** Add CI with `npm ci` and `npm test` on Node 22 and 24, the LTS releases within the current engine range. Add loopback smoke tests using an SDK client against the actual server entry point in isolated test mode. Use mocked or provider-independent reads. Test authenticated Streamable HTTP and stdio initialization, tool discovery, and a read-only response. Confirm which clients still use legacy SSE before extending or changing that transport.

**Done when.** CI passes on both LTS releases with no live credentials. Wire tests verify authentication, tool discovery, and agreement between text and structured results. Existing Railway deployment and connector setup remain compatible.

## 4. Extract one reporting tool to simplify future changes

**Observed.** `server.js` is over 15,000 lines. Tool schemas and dispatch branches live far apart, so a contract change can require edits in several locations.

**Change.** After the preceding contracts are covered, pick one read-only tool with existing regression fixtures. Keep its schema and handler together in a small module and connect it to the existing validated dispatcher. Use the resulting diff and tests to decide whether the pattern is worth expanding.

**Done when.** The pilot preserves its tool name, published schema and annotations, input validation, output, and failure behavior. It appears exactly once in the validated catalog and the catalog test still reports 102 tools. Existing mutation safeguards and routing remain intact.

## Sequencing and release verification

Fix the digest using the current result fields first. Develop CI in parallel where it can land independently. Refine the reporting coverage contract after the digest regression tests land, then extract one tool as a pilot. Verify an authorized release against the expected Railway revision, `/healthz`, and a read-only MCP smoke check. Roll back the affected code revision if the digest or tool contract regresses, and preserve account configuration and existing write state.
