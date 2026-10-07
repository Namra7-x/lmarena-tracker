# AI Artifact Tracker — Implementation Plan

## 0. Goal

Build a production-grade tracker for six independent components across three product families:

- ChatGPT / Codex: Codex CLI + Codex Desktop/App
- Gemini / Antigravity: Antigravity CLI + Antigravity Desktop
- Claude: Claude Code + Claude Desktop

This tracker is for personal use only (single user).
Notifications go through one Telegram bot.

Secrets:
- TELEGRAM_BOT_TOKEN
- TELEGRAM_CHAT_ID
- optional topic IDs (one Telegram group with topics):
  TG_TOPIC_CHATGPT, TG_TOPIC_GEMINI, TG_TOPIC_CLAUDE

CLI and desktop remain independent component states/scans
even when they share a family topic.

Primary engineering goals, in order:

1. Never miss a meaningful artifact/string finding silently.
2. Never falsely report a source/page-only change as a product change.
3. Finish the normal no-change path as quickly as possible.
4. Run changed components and products independently and in parallel.
5. Keep the Git repository lightweight.
6. Never advance a successful baseline from an incomplete or failed scan.
7. Make every expensive operation bounded, observable and recoverable.
8. Keep Discord compact, useful and visually easy to scan while retaining a complete downloadable report.

This is a static-analysis tracker. It must never execute downloaded vendor binaries, applications, installers or vendor scripts.

---

## 1. Core architecture: fast path + deep path

The tracker has two fundamentally different paths.

### Fast path — every minute

Only perform cheap discovery and identity comparison.

```
Cloudflare repository_dispatch
        |
        +--> Arena / Design Arena remain independent
        |
        +--> ChatGPT job
        +--> Gemini job
        +--> Claude job
```

The Cloudflare Worker performs cheap version/identity checks every minute
(npm, GitHub API, official pages). It calls repository_dispatch only when an
identity change is detected. GitHub Actions never runs on quiet minutes.

Each AI product job performs source discovery concurrently, builds identity state, and exits immediately if nothing meaningful changed.

When unchanged:

- no large artifact download,
- no extraction,
- no recursive scanning,
- no native analysis,
- no Discord message,
- no unnecessary state churn.

### Deep path — only after a real change

```
identity change
    |
    +--> classify version/release vs same-version distribution change
    |
    +--> verify when required
    |
    +--> create scanId
    |
    +--> immediate Discord alert when justified
    |
    +--> parallel artifact acquisition
    |
    +--> bounded extraction/analysis workers
    |
    +--> exact diff + structured diff
    |
    +--> correlation + confidence scoring
    |
    +--> complete/incomplete coverage decision
    |
    +--> compact Discord completion message
    |
    +--> full compressed Actions artifact
    |
    +--> isolated state candidate
    |
    +--> transactional persist
```

The fast path is optimized for latency; the deep path is optimized for coverage without unbounded resource use.

---

## 2. Parallelism and isolation

The existing Cloudflare `repository_dispatch` event named `tracker` is reused.

The existing Arena workflow remains separate and must not become a dependency of the AI tracker.

The AI workflow uses three independent product jobs:

- `chatgpt`
- `gemini`
- `claude`

Matrix `fail-fast: false`.

Each product uses its own concurrency group:

- `ai-chatgpt`
- `ai-gemini`
- `ai-claude`

Use `cancel-in-progress: false` so an in-progress deep scan is not killed by the next minute's trigger.

Required behavior:

1. Arena, Design Arena, ChatGPT, Gemini and Claude can run independently.
2. No product waits for another product.
3. Within each product, discovery sources are concurrent.
4. Within a changed component, downloads/extraction use a bounded worker pool.
5. One failed source, artifact or extractor does not cancel unrelated work.
6. One slow product cannot serialize another product.
7. Telegram sends are sequential per chat, so no extra queue is needed.
8. If CLI and desktop change together, both scans run independently and
   both post to the same family topic, distinguished by scanId.

---

## 3. Fingerprint contract — critical

Never use volatile metadata as the deep-scan trigger.

Use two fingerprints.

### 3.1 Identity fingerprint

This is the only fingerprint allowed to trigger a deep scan.

It contains only stable product/artifact identity information:

- normalized component,
- selected release/channel identity,
- normalized version,
- authoritative release ID where available,
- normalized official artifact URLs,
- vendor-provided artifact checksums/integrity values when available,
- normalized artifact distribution/inventory identity.

Do NOT include:

- page HTML,
- changelog digest,
- npm metadata JSON digest,
- ETag,
- Last-Modified,
- Content-Length,
- generated page timestamps,
- unrelated metadata fields.

Identity fingerprint must be canonicalized and deterministically hashed.

### 3.2 Diagnostic fingerprint

May contain volatile observations:

- page/source digest,
- changelog digest,
- ETag,
- Last-Modified,
- Content-Length,
- npm metadata changes,
- source availability,
- redirect observations.

Diagnostic changes produce a `SOURCE_DRIFT` observation only.

They must not trigger a deep artifact scan by themselves.

This prevents repeated deep scans caused by vendor website deployments, edited changelogs or regenerated metadata.

---

## 4. Change classification

After discovery, classify the result before doing expensive work.

### A. No identity change

```
identity == successful baseline
```

Action:

- stop,
- no Discord,
- no large download,
- no deep analysis.

### B. Authoritative version/release change

Example:

```
2.1.291 -> 2.1.292
```

If the version/release identity is authoritative, send the immediate Discord change alert before expensive artifact analysis.

### C. Same-version distribution change

Example:

```
version: 2.1.292
URL: A -> B
checksum/integrity: changed or unavailable
```

Do NOT immediately announce a product change.

First:

1. download the affected artifact(s),
2. verify vendor integrity/checksum where available,
3. compute local SHA-256,
4. compare bytes/content identity.

If bytes are identical:

- classify as distribution/source drift,
- do not send a product-change alert,
- do not replace the successful artifact baseline with an unverified observation.

If bytes genuinely differ:

- create a real change event,
- send the change alert,
- deep scan the changed content.

This prevents CDN URL swaps and mirror changes from creating false alarms.

---

## 5. Scan identity and Discord correlation

Every real deep scan receives a unique `scanId`.

Example:

```
CX-20261007-004
```

The same `scanId` appears in:

- immediate Discord alert,
- deep-analysis completion message,
- report metadata,
- raw artifact manifest,
- state candidate,
- logs.

This is mandatory because CLI and desktop messages can interleave in one family channel.

Example:

```
🚨 CODEX CLI — NEW RELEASE
Scan: CX-20261007-004
        |
        +--> 🔬 CODEX CLI — ANALYSIS COMPLETE
             Scan: CX-20261007-004
```

---

## 6. Telegram presentation

Notifications use Telegram sendMessage with parse_mode=HTML and an
inline_keyboard of URL buttons.

Limits: message text 4096 chars, document caption 1024 chars.

Immediate alert:
🚨 CODEX CLI 0.160.1 → 0.160.2
Scan: CX-20261007-004
[Official Release]

Completion message (reply to the alert via reply_to_message_id):
🔬 ANALYSIS COMPLETE · Scan CX-20261007-004
12 commands · 7 flags · 5 config keys · 3 endpoints
⭐ High-confidence: codex resume, CODEX_EXPERIMENTAL_*
Coverage: 100% ✓
[Release] [Run logs]
+ report.zip attached with sendDocument

If incomplete:
⚠️ ANALYSIS PARTIAL · Coverage 87% · 3 artifacts failed

Never present an incomplete scan as complete.
Message generation is deterministic and bounded.
---

## 7. Complete evidence vs compact presentation

The tracker must preserve complete scan evidence without making Git or Discord huge.

### Discord

Show only:

- high-value changes,
- confidence-ranked findings,
- counts,
- coverage,
- scan ID,
- useful links.

### Git repository

Store only compact state:

- successful baselines,
- bounded recent signals,
- permanently important/hot signals,
- compact artifact identity metadata.

Do NOT store:

- downloaded installers,
- application bundles,
- extracted applications,
- millions of raw strings,
- raw binary files,
- every historical scan report.

### Actions artifacts

Store the complete scan evidence as compressed, chunked artifacts:

- raw extraction records,
- normalized records,
- exact hash sets,
- structured diffs,
- artifact manifest,
- summary report,
- coverage/errors report.

Use size and retention limits.

The repository is the control plane; Actions artifacts are the evidence plane.

---

## 8. Historical signal retention

Never allow `seenSignals` or raw records to grow forever inside Git.

Maintain:

- `previous`: immediately previous successful scan for exact release-to-release diffing.
- `seen`: historical union for successful scans, stored as sorted SHA-256 records outside Git.
- Git-visible recent signals: capped at 5,000.
- Git-visible permanent/hot signals: bounded separately.

Use compressed/chunked Actions artifacts for the full historical hash set.

Raw records should use a streaming format such as JSONL rather than one enormous JSON object.

A repeated string must not be stored millions of times.

Instead retain:

- normalized value,
- occurrence count,
- artifact count,
- artifact paths,
- first/last seen,
- provenance,
- confidence.

No evidence is discarded merely because Discord does not display it.

---

## 9. Exact diffing

Do not use Bloom filters as the authoritative diff.

Use exact SHA-256 records.

```
stream normalized records
    |
    +--> SHA-256
    |
    +--> external sort
    |
    +--> sort/comm/join
    |
    +--> exact new/removed/persistent sets
```

This keeps memory bounded even when the number of records is very large.

Classify:

- new,
- first seen,
- reintroduced,
- persistent,
- removed.

Bloom filters may be used only as an optional performance hint, never as the source of truth.

---

## 10. No-missed-data extraction strategy

"No missed strings" means the scanner must use layered extraction and must never silently skip a supported artifact.

Do not depend on one `strings` command.

For text/binary extraction use multiple representations where applicable:

- UTF-8,
- ASCII,
- UTF-16LE,
- UTF-16BE where practical,
- wide/native strings,
- binary-aware string extraction,
- embedded JSON,
- JavaScript,
- source-map `sourcesContent`,
- WASM strings/data,
- native executable data/sections/resources.

For every extracted record preserve provenance:

- component,
- artifact,
- archive path,
- file path,
- extraction method,
- byte/line location where practical,
- original value,
- normalized value,
- context when available.

Normalize for comparison, but retain the original representation in the raw evidence.

---

## 11. Context-aware findings

A raw string alone is weak evidence.

Example:

```
"remote_control"
```

should retain context such as:

- file,
- surrounding code/data,
- object key,
- command registration,
- configuration schema,
- source-map location,
- artifact class.

This allows the classifier to distinguish:

- confirmed,
- high-confidence signal,
- early signal,
- weak signal.

Never call an unconfirmed finding a "leak".

Use terms such as:

- confirmed,
- high-confidence signal,
- early signal,
- weak signal,
- source drift.

---

## 12. Deep static-analysis pipeline

```
artifact discovery
 -> integrity verification
 -> SHA-256
 -> content-addressed deduplication
 -> archive/container extraction
 -> nested archive discovery
 -> ASAR extraction
 -> source-map extraction
 -> package/dependency metadata
 -> text/config/schema parsing
 -> JavaScript analysis
 -> WASM inspection
 -> ELF/PE/Mach-O metadata
 -> multi-encoding string extraction
 -> normalized streaming records
 -> exact external-sort diff
 -> structured diff
 -> signal classification
 -> cross-artifact correlation
 -> confidence scoring
 -> report generation
```

Never execute:

- binaries,
- applications,
- installers,
- downloaded scripts,
- vendor code.

Installer scripts are parsed as text only.

---

## 13. Artifact coverage and priority

Discovery should identify all official relevant artifacts, but analysis should be scheduled by priority.

### Priority 1

- release metadata,
- release notes/changelog,
- manifests,
- config/schema,
- installer scripts,
- npm tarballs,
- source maps,
- unique small text artifacts.

### Priority 2

- ASAR/application bundles,
- native binaries,
- WASM,
- platform-specific libraries.

### Priority 3

- large low-signal resources,
- fonts,
- images,
- localization,
- other assets.

Priority is an execution order, not permission to permanently ignore Priority 3.

If resources permit, scan everything.

If a resource/time limit prevents complete coverage, explicitly record the skipped artifact and mark the scan incomplete.

---

## 14. Per-artifact isolation

Each artifact must have:

- acquisition timeout,
- extraction timeout,
- analysis timeout,
- maximum size,
- maximum extracted expansion,
- error state,
- retry policy.

One corrupt archive must not terminate the entire product scan.

Example:

```
artifact A -> SUCCESS
artifact B -> SUCCESS
artifact C -> ASAR PARSE FAILED
artifact D -> SUCCESS
```

The scan must retain A/B/D results and explicitly report C as failed.

Whether the component baseline may advance depends on required coverage policy; a required artifact failure means the successful baseline must not advance.

---

## 15. Bounded worker pool

Never create unlimited parallel processes.

Use a bounded worker pool for:

- artifact downloads,
- archive extraction,
- CPU-heavy analysis,
- hashing.

Separate network concurrency from CPU concurrency where useful.

Example conceptual limits:

```
network workers = N
CPU workers     = M
```

The actual values should be configurable and tuned to the GitHub-hosted runner rather than hard-coded around a single runner assumption.

Use backpressure so a huge artifact cannot create an unbounded extraction queue.

---

## 16. Content-addressed artifact deduplication

The strongest available content identity is used in this order:

1. vendor SHA-256,
2. npm integrity,
3. release checksum/digest,
4. local SHA-256.

If two URLs resolve to identical bytes:

```
URL A ──┐
        +--> SHA256 ABC123
URL B ──┘
```

an artifact is analyzed once.

This prevents duplicate analysis across mirrors, CDN URLs, aliases and repeated releases pointing to identical content.

---

## 17. Integrity and provenance

Before extraction:

- verify vendor checksum when supplied,
- verify npm integrity when supplied,
- verify checksum manifests,
- compute local SHA-256,
- reject mismatched content.

If signature/Sigstore metadata exists, parse it as provenance.

Integrity failures are not silently ignored.

A failed verification must not become the successful baseline.

---

## 18. Resource guards

Before large operations:

- inspect free disk,
- preserve a disk reserve,
- enforce per-artifact size ceilings,
- enforce maximum decompressed expansion,
- enforce per-component/run time budgets,
- enforce total report size limits.

If a guard is reached:

1. finish already-running safe work where possible,
2. prioritize higher-value artifacts,
3. record every skipped item,
4. mark coverage accurately,
5. do not advance a successful baseline if required coverage was not achieved.

The system must fail explicitly rather than silently producing a false "complete" result.

---

## 19. First-run baseline

The first run must not be a cost bomb.

First-run baseline:

- cheap discovery for all components,
- complete artifact inventory,
- one representative artifact per relevant OS/architecture where practical,
- metadata/text/config analysis,
- integrity and identity capture,
- bounded representative static analysis.

Do not perform exhaustive deep cross-platform analysis merely to establish the first baseline.

After a real change, perform the deeper cross-platform scan.

The baseline state must record its coverage level so a later scan can distinguish:

- initial baseline,
- representative baseline,
- full successful baseline.

---

## 20. Source discovery hierarchy

### ChatGPT / Codex

Use verified official sources:

1. OpenAI Codex release metadata / release distribution.
2. OpenAI Codex GitHub releases.
3. npm package `@openai/codex`.
4. official Codex installer scripts.
5. official OpenAI Codex product/desktop distribution surface.

Do not use a generic ChatGPT download page as the primary Codex desktop source.

Stable channel selection must be explicit; newer alpha releases must not accidentally become the stable baseline.

### Gemini / Antigravity

Use only verified official Google/Antigravity surfaces:

1. official Antigravity download page,
2. official CLI install.sh,
3. official CLI install.ps1,
4. official CLI install.cmd,
5. official CLI changelog,
6. official general changelog.

Do not assume an Antigravity GitHub repository unless an official source explicitly links it.

Desktop and CLI versions are independent components.

### Claude

Use verified official Anthropic surfaces:

1. Claude Code GitHub releases,
2. npm package `@anthropic-ai/claude-code`,
3. official Claude download page,
4. official Claude Desktop Linux apt repository,
5. official Claude Code changelog/feed where useful.

Desktop and Claude Code versions are independent components.

---

## 21. Source reliability and volatile pages

Dynamic pages are parsed at runtime.

Do not hard-code volatile CDN URLs unless officially documented as stable.

Use source precedence.

When sources disagree:

1. authoritative release/integrity metadata,
2. official artifact manifest/checksum,
3. official package registry,
4. official GitHub release,
5. official download/changelog page,
6. diagnostic-only observations.

Record disagreement as diagnostics rather than silently choosing a weaker source.

---

## 22. Network safety

Only configured vendor/CDN/GitHub/npm/official package hosts may be downloaded.

Never follow arbitrary URLs discovered inside artifacts as network requests.

A URL found inside a binary is evidence, not permission to fetch it.

This prevents SSRF-style behavior and keeps analysis bounded.

---

## 23. Retry and timeout strategy

Every network source has:

- connection timeout,
- response timeout,
- bounded retries,
- retry classification,
- exponential backoff,
- jitter.

Retry transient failures.

Do not blindly retry permanent failures such as:

- confirmed 404,
- invalid checksum,
- unsupported format.

Telegram 429 responses include parameters.retry_after.
Wait that long, then retry with bounded attempts and jitter.
Do not retry permanent errors (400 bad request, 403 bot blocked).

---

## 24. State transaction and lost-update protection

Each product scan writes an isolated candidate rather than directly modifying the shared baseline.

Every candidate records:

```
basedOnFingerprint
candidateFingerprint
scanId
status
coverage
```

Persist logic:

1. load current successful baseline,
2. compare candidate `basedOnFingerprint` with current baseline,
3. accept only if they match,
4. otherwise reject as stale or re-diff against the current state,
5. merge accepted candidates,
6. commit once,
7. rebase/retry bounded times if Git changed concurrently.

This prevents two parallel runs from silently overwriting a newer baseline.

---

## 25. Successful vs observed state

Do not confuse:

- observed vendor/source state,
- verified artifact state,
- successful deep-analysis baseline.

Example:

```
Observed URL changed
        |
        v
Downloaded bytes identical
        |
        v
No product change
```

The observation can be retained diagnostically without replacing the successful product baseline.

Similarly:

```
New version detected
        |
        v
Deep scan failed
        |
        v
Successful baseline remains old version
```

This guarantees failed scans retry instead of becoming invisible.

---

## 26. Coverage contract

Every deep scan must produce a machine-readable coverage result.

Minimum states:

- `COMPLETE`
- `PARTIAL`
- `FAILED`

Include:

- artifacts discovered,
- artifacts analyzed,
- artifacts skipped,
- artifacts failed,
- extraction failures,
- parser failures,
- resource-limit skips,
- timeout skips,
- integrity failures.

A scan cannot be marked `COMPLETE` while required artifacts remain unprocessed.

---

## 27. High-value signal categories

First-class categories:

- models/model aliases,
- endpoints/domains,
- CLI commands/subcommands,
- CLI flags,
- environment variables,
- config keys/schema,
- feature flags/rollout controls,
- MCP tools/servers,
- plugins/extensions,
- skills/agents/subagents,
- providers/backends,
- protocol/request/response fields,
- sandbox/permission/security controls,
- authentication/identity controls,
- experimental/internal/preview/nightly markers,
- browser/computer-use controls,
- background/scheduling/automation controls,
- remote-control/session/relay controls,
- telemetry/diagnostic controls,
- dependency changes.

---

## 28. Cross-artifact correlation

A finding becomes stronger when independently supported.

Example:

```
model identifier
   |
   +--> JavaScript
   +--> native binary
   +--> desktop bundle
   +--> config/schema
   +--> release notes
```

Store provenance:

- value,
- type,
- first_seen,
- artifacts,
- artifact classes,
- source matches,
- release-note matches,
- confidence.

Cross-artifact agreement should increase confidence; one isolated string should remain a weaker signal.

---

## 29. Deterministic scoring and noise control

Raw analysis may produce millions of records.

Discord must not.

Ranking should consider:

- exact previous-release diff,
- first-ever appearance,
- artifact count,
- artifact-class diversity,
- platform diversity,
- source-code + binary agreement,
- release-note agreement,
- category quality,
- historical false-positive rate.

Collapse duplicates.

Example:

```
api.example.com
Occurrences: 43,221
Artifacts: 6
Confidence: HIGH
```

not 43,221 Discord lines.

Discord output must be deterministic so the same scan does not produce random ordering.

---

## 30. Reports and downloadable evidence

Every successful or partial deep scan produces a compressed report bundle.

Recommended contents:

```
scan/
  summary.json
  findings.json
  coverage.json
  artifacts.json
  diff/
    new.sha256
    removed.sha256
    persistent.sha256
  normalized/
  raw/
  metadata/
```

Use streaming/compressed files for very large record sets.

Full report = report.zip, sent directly with sendDocument (limit 50 MB).
If larger than 45 MB: split into parts or send summary.json only, and keep
the full bundle as a GitHub Actions artifact (90 days max retention).
No public report hosting is needed.
---

## 31. Performance rules

The tracker must optimize for time-to-finish, not merely maximum parallelism.

Rules:

1. Exit immediately on unchanged identity.
2. Do not download unchanged artifacts.
3. Do not analyze identical SHA-256 content twice.
4. Run independent discovery concurrently.
5. Separate network and CPU worker pools.
6. Use bounded concurrency.
7. Stream hashes/records instead of loading millions into RAM.
8. Use external sort for large exact sets.
9. Prioritize high-value artifacts first.
10. Avoid repeatedly parsing the same extracted content.
11. Cache reusable tooling/dependencies where safe.
12. Do not cache arbitrary vendor binaries indefinitely.
13. Apply per-artifact timeouts.
14. Prevent one huge artifact from blocking the entire scan.
15. Generate Discord summary from structured results rather than rescanning raw data.
16. Compress raw reports after analysis.
17. Keep Git state small.
18. Never trade correctness for a silent skip; every skip must be explicit.

The fastest possible tracker is one that does almost no work when nothing changed and performs independent changed work concurrently when something did change.

---

## 32. Caching strategy

Use caching primarily for reusable tooling and dependencies.

Safe candidates:

- npm dependencies,
- parser/tool dependencies,
- stable scanner assets.

Artifact caching should be content-addressed and bounded.

Do not build an unlimited cache of vendor installers.

Cache keys should include tool/runtime versions so stale parser/tool state does not silently affect results.

---

## 33. Electron and application bundles

For Electron-style products:

- inspect `app.asar`,
- inspect `app.asar.unpacked`,
- inspect native `.node` modules,
- inspect JavaScript,
- inspect JSON,
- inspect source maps,
- inspect resource archives,
- inspect nested package manifests/dependencies.

The ASAR parser is read-only and structure-aware.

ASAR extraction failure must be reported and must affect coverage.

---

## 34. JavaScript and source maps

When source maps contain `sourcesContent`, analyze the embedded source.

Extract candidates from:

- string literals,
- object keys,
- property names,
- URL-like values,
- environment/config identifiers,
- command declarations,
- flag declarations,
- feature/rollout identifiers.

Preserve original-to-normalized mapping and source provenance.

---

## 35. Native static analysis

For ELF, PE/COFF and Mach-O inspect:

- architecture,
- sections,
- imports/exports,
- dynamic libraries,
- embedded resources where practical,
- strings,
- URLs/domains,
- protocol names,
- model identifiers,
- feature/config identifiers.

No execution, emulation or dynamic loading.

---

## 36. Dependencies and structured changes

Where manifests are available, identify:

- added dependencies,
- removed dependencies,
- upgrades,
- downgrades,
- major-version jumps,
- native library changes,
- bundled Electron module changes.

Also diff:

- config/schema,
- CLI command registry,
- flags,
- endpoints,
- domains,
- MCP tools/servers,
- model identifiers,
- environment variables,
- protocol fields,
- permissions/security controls,
- artifact inventory.

---

## 37. State layout

Recommended compact Git state:

```
ai-tracker/state/
  chatgpt/
  gemini/
  claude/
```

Each product contains separate component state.

Do not combine CLI and desktop fingerprints into one component baseline.

State must distinguish:

- last successful identity,
- last successful coverage,
- current diagnostic observations,
- bounded recent signals,
- bounded hot signals.

Large historical hash sets and raw evidence remain outside normal Git state.

---

## 38. Implementation modules

Planned modules:

```
ai-tracker/src/
  cli.mjs
  config.mjs

  discover/
    github.mjs
    npm.mjs
    codex-release.mjs
    vendor-page.mjs
    scripts.mjs
    apt.mjs
    changelog.mjs

  fingerprint/
    identity.mjs
    diagnostic.mjs
    canonicalize.mjs

  acquire/
    http.mjs
    integrity.mjs
    artifact-manifest.mjs
    cache.mjs

  extract/
    archive.mjs
    asar.mjs
    sourcemap.mjs
    wasm.mjs
    native.mjs
    strings.mjs
    package-metadata.mjs

  diff/
    exact-set.mjs
    structured.mjs
    dependency.mjs

  signals/
    classify.mjs
    correlate.mjs
    score.mjs

  report/
    discord.mjs
    markdown.mjs
    json.mjs
    artifact-bundle.mjs

  state/
    load.mjs
    candidate.mjs
    merge.mjs
    persist.mjs
    retention.mjs
```

Implementation must follow the contracts above before deep scanners are written.

---

## 39. Tests

Required tests include:

### Fingerprints

- canonical identity fingerprint,
- diagnostic-only drift,
- page/changelog changes do not trigger deep scans,
- version change triggers immediate alert,
- same-version URL change requires byte verification.

### Acquisition

- retries,
- timeouts,
- allowlisting,
- redirects,
- checksum mismatch,
- npm integrity,
- duplicate content,
- cache hits.

### Extraction

- tar/zip/tgz,
- nested archives,
- ASAR,
- source maps,
- WASM,
- ELF,
- PE/COFF,
- Mach-O,
- UTF-8,
- ASCII,
- UTF-16LE/BE where supported,
- wide strings,
- malformed/corrupt inputs.

### Diff

- exact external set diff,
- new/removed/reintroduced/persistent,
- previous vs seen semantics,
- large streaming datasets.

### State

- isolated candidates,
- `basedOnFingerprint`,
- stale candidate rejection,
- failed scan does not advance baseline,
- partial scan does not advance required baseline,
- concurrent Git update/rebase.

Telegram:
- HTML escaping of values
- 4096 / 1024 length limits
- deterministic ranking
- duplicate collapsing
- 429 retry_after handling
- reply threading by scanId
- oversized report fallback

### Coverage

- explicit skipped artifacts,
- extractor failure,
- timeout,
- disk/resource limit,
- incomplete status,
- no false COMPLETE status.

Use fixtures for integration tests. Live vendor downloads must not be required for every CI test.

---

## 40. Acceptance criteria

The implementation is not considered complete unless all of the following are true:

- unchanged minute runs are cheap and produce no Discord noise,
- stable-channel selection is explicit,
- source drift cannot trigger deep scans,
- same-version distribution changes are verified before product alerts,
- all six components have independent state,
- all three families have independent Discord queues,
- products run independently,
- artifact analysis is bounded and parallel,
- duplicate content is analyzed once,
- supported extraction paths preserve raw evidence,
- skipped/failed work is explicitly reported,
- exact diffing does not depend on Bloom filters,
- failed/incomplete scans never replace successful baselines,
- stale state candidates cannot overwrite newer state,
- Git remains compact,
- large evidence is retained outside normal Git state,
- Telegram alerts are compact and actionable
- immediate and completion messages share a scan ID
- report.zip is delivered in the chat
- unchanged minutes send no message
- no downloaded vendor code is executed,
- arbitrary artifact-discovered URLs are never fetched,
- resource exhaustion cannot silently produce a "complete" scan.

---

## 41. Final implementation order

Do not start with deep scanners.

Implement in this order:

1. fingerprint/state contract
2. source adapters + stable-channel selection
3. Worker fast path (dispatch only on change)
4. change classification
5. Telegram alert + scanId
6. isolated candidates + persist
7. acquisition + integrity + dedup
8. extraction + exact diff + scoring
9. report.zip + completion message
10. deep scanners (ASAR, source maps, WASM, native)
