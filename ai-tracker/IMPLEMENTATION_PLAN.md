# AI Artifact Tracker — Implementation Plan

## Scope

Track three product families independently:

- ChatGPT / Codex: Codex CLI + Codex Desktop/App
- Gemini / Antigravity: Antigravity CLI + Antigravity Desktop
- Claude: Claude Code + Claude Desktop

A family has one Discord webhook, but each component has its own version and artifact fingerprint.

The tracker must optimize for a very cheap one-minute no-change path and a deep, static-only change path.

## Parallel execution

The existing Cloudflare repository_dispatch event named tracker is reused unchanged.

The existing Arena workflow remains separate.

The new AI workflow is a matrix of three product jobs:

- chatgpt
- gemini
- claude

Matrix fail-fast is false.

Each product uses its own concurrency group and cancel-in-progress is false.

Required behavior:

1. Arena, Design Arena, ChatGPT, Gemini and Claude can all start independently.
2. No AI product waits for another AI product.
3. Within a product, all lightweight sources are queried concurrently.
4. After a change, artifact acquisition and analysis use a bounded worker pool.
5. One failed source, artifact or extractor does not cancel unrelated work.
6. A slow vendor cannot serialize the other products.

## State-write architecture

Do not let three product jobs push the same state files directly.

Each product job creates an isolated state candidate and uploads it as an Actions artifact.

A final persist-state job:

1. downloads the three candidates,
2. accepts only successful product scans,
3. preserves old baselines for failed products,
4. merges product state,
5. commits once.

The persist job rebases and retries bounded times if the existing Arena workflow has pushed a concurrent commit.

This prevents state corruption and Git push races.

## Fast discovery path

Every trigger performs only lightweight discovery first.

For each component, fetch in parallel:

- authoritative version/release metadata,
- npm metadata where applicable,
- official download-page metadata,
- changelog/release metadata where useful,
- ETag / Last-Modified / Content-Length when useful.

Build a compact component fingerprint from:

- normalized version,
- channel,
- release identity,
- release metadata digest,
- discovered artifact manifest digest,
- installer/download link digest,
- relevant changelog/version metadata digest.

If the fingerprint is unchanged from the last successful scan:

- do not download large files,
- do not extract archives,
- do not run string scanning,
- do not send Discord.

## Stable channel

Never assume the newest timestamped release is stable.

Codex currently demonstrates why this matters: GitHub has alpha releases newer than the stable release, so the adapter must explicitly select the stable channel. The official Codex installer also has a preferred OpenAI release source and GitHub fallback. citeturn560599search3turn932769search13

Initial scope tracks stable only.

Preview, beta and nightly can be added later as explicit channels.

## Distribution-change trigger

A version string is not sufficient.

If a vendor republishes an artifact, changes a CDN target, changes a manifest or changes integrity while keeping the same version, trigger a deep scan as a distribution-change.

This catches silent repacks and replaced binaries.

## Immediate Discord alert

On a confirmed component change:

1. finish lightweight validation,
2. send the Discord change alert immediately,
3. then start expensive artifact downloads.

Example:

CODEX CLI UPDATE
old -> new
Deep artifact analysis started.

Desktop components use their own component name.

Never describe an uncertain string or binary discovery as a leak. Use early signal or change signal.

## Official source hierarchy

### ChatGPT / Codex

Primary official sources:

1. OpenAI Codex release metadata at releases.openai.com/codex.
2. OpenAI Codex GitHub releases.
3. npm package @openai/codex.
4. Official Codex installer scripts.
5. OpenAI Codex product page for desktop distribution discovery.

The official installer logic prefers the OpenAI release host and falls back to GitHub. Codex releases expose checksummed native assets plus useful text/config assets such as config-schema.json and installer scripts. citeturn560599search3turn932769search13turn932117search4

The old generic ChatGPT download page is not the primary Codex desktop source.

### Gemini / Antigravity

Use only verified Google/Antigravity surfaces:

1. official Antigravity download page,
2. official CLI install.sh,
3. official CLI install.ps1,
4. official CLI install.cmd,
5. official CLI changelog,
6. official general changelog.

Do not assume a public Antigravity GitHub repository unless an official source explicitly links it.

The current download page exposes separate desktop and CLI versions. citeturn932769search1turn932769search2

### Claude

Use:

1. Anthropic Claude Code GitHub releases,
2. npm package @anthropic-ai/claude-code,
3. official Claude download page,
4. official Claude Desktop Linux apt repository,
5. official Claude Code changelog/feed where useful.

Claude desktop exposes macOS, Windows, Windows ARM64 and Linux distribution surfaces; the Linux documentation exposes a machine-readable apt repository/package index. citeturn932769search0turn560599search6

## Component model

Treat these as independent components:

- codex-cli
- codex-desktop
- antigravity-cli
- antigravity-desktop
- claude-code
- claude-desktop

A component change may trigger only that component's deep scan plus cross-component correlation.

Related Antigravity IDE and SDK versions may be observed as metadata, but they do not trigger the requested deep scan.

## Artifact descriptors

Discovery adapters return normalized descriptors rather than downloading directly.

Descriptor fields should include:

component
source
url
filename
platform
architecture
format
size
remote checksum or integrity
priority

Dynamic download pages are parsed at runtime. Volatile CDN URLs are not hard-coded unless the vendor explicitly documents them as stable.

Only configured vendor/CDN/GitHub/npm hosts may be followed.

## Artifact selection

Always prioritize:

- release metadata,
- release notes/changelog,
- package manifests,
- config/schema files,
- installer scripts,
- source archives,
- npm tarballs,
- unique small text artifacts.

Then discover all official platform/architecture artifacts.

Deduplicate identical bytes by content fingerprint.

If resources become constrained, prioritize:

1. metadata/text/config,
2. artifacts with new content hashes,
3. one representative native artifact per OS/architecture,
4. remaining distinct large artifacts.

Skipped artifacts must be recorded explicitly.

## Integrity

Before extraction:

- verify vendor checksum when supplied,
- verify npm integrity when supplied,
- verify checksum manifests when supplied,
- compute local SHA-256,
- reject mismatched content.

If Sigstore/signature metadata exists, parse it as provenance.

Never execute downloaded binaries, applications, installers or vendor scripts.

Installer scripts are treated as text only.

## Deep static-analysis pipeline

artifact
-> integrity verification
-> SHA-256 fingerprint
-> archive/container extraction
-> nested archive discovery
-> Electron ASAR extraction
-> source-map extraction
-> dependency/package metadata
-> WASM inspection
-> ELF/PE/Mach-O metadata
-> ASCII + UTF-16LE strings
-> normalization
-> exact external-sort diff
-> structured diff
-> signal classification
-> cross-artifact correlation
-> confidence scoring
-> compact Discord report
-> full Actions report

Supported formats should include tar, compressed tar, zip, npm tgz, 7z where available, ASAR, source maps, WASM, ELF, PE/COFF and Mach-O.

## Electron/app-bundle handling

For Electron-style products:

- inspect app.asar,
- inspect app.asar.unpacked,
- inspect native .node modules,
- inspect JavaScript and JSON,
- inspect source maps,
- inspect resource archives,
- extract nested package.json dependency information.

The ASAR parser is read-only and structure aware.

## JavaScript/source-map handling

If source maps contain sourcesContent, analyze that source directly.

Extract structured candidates from:

- string literals,
- object keys,
- property names,
- URL-like values,
- environment/config identifiers,
- command declarations,
- flag declarations.

Preserve a mapping from normalized value to original value.

## Native static analysis

For ELF, PE/COFF and Mach-O, inspect:

- architecture,
- sections,
- imports/exports,
- dynamic libraries,
- embedded resources when practical,
- strings,
- URLs/domains,
- protocol names,
- model identifiers,
- feature/config identifiers.

No execution, emulation or loading.

## Exact diffing

Do not use only a Bloom filter.

Use exact SHA-256 records and external sorting so memory does not scale with all strings.

Use sort, comm and join for exact set operations.

Maintain:

- previous: immediately previous successful scan,
- seen: union across successful historical scans.

Classify:

- new,
- first seen,
- reintroduced,
- persistent,
- removed.

Raw normalized records remain in the Actions report even when Discord presentation is filtered.

## Structured diffs

Diff more than strings:

- package versions,
- dependency graph,
- config/schema keys,
- CLI commands,
- CLI flags,
- feature flags,
- endpoints,
- domains,
- MCP tools/servers,
- model identifiers,
- environment variables,
- protocol fields,
- permissions/security controls,
- release-note changes,
- artifact inventory.

## High-value signals

First-class categories:

- models and model aliases,
- endpoints and domains,
- CLI commands and flags,
- environment variables,
- config keys,
- feature flags and rollout controls,
- MCP tools/servers,
- plugins/extensions,
- skills/agents/subagents,
- providers/backends,
- protocol/schema fields,
- sandbox/permission/security controls,
- authentication/identity controls,
- experimental/internal/preview/nightly markers,
- browser/computer-use controls,
- background/scheduling/automation controls,
- remote-control/session/relay controls,
- telemetry/diagnostic controls,
- dependency changes.

The Claude Code community tracker is a useful validation of this approach: it independently tracks prompts, feature flags and metadata as structured release artifacts rather than treating them as undifferentiated strings. citeturn560599search0turn560599search5

## Dependency delta

Where manifests are available, identify:

- added dependencies,
- removed dependencies,
- upgrades,
- downgrades,
- major-version jumps,
- native library changes,
- bundled Electron module changes.

## Cross-artifact correlation

A candidate becomes stronger when it appears across independent artifact classes.

Example:

model identifier
-> npm package
-> native binary
-> desktop bundle
-> release notes

Such candidates get higher confidence than one-off strings.

Store provenance such as:

value
type
first_seen
artifacts
source_match
release_notes
confidence

Use confidence labels:

- confirmed
- high-confidence signal
- early signal
- weak signal

## Scoring

Rank using:

- exact previous-release diff,
- first-ever appearance,
- number of artifacts,
- number of artifact classes,
- platform diversity,
- source-code + binary agreement,
- release-note agreement,
- stable/preview origin,
- category quality,
- historical false-positive rate.

## Noise control

Raw analysis can produce millions of discoveries.

Discord must not.

Use:

- category aggregation,
- duplicate collapsing,
- confidence thresholds,
- deterministic top-N ranking,
- repeated-value suppression,
- message chunking.

Normally send:

1. immediate change alert,
2. one compact deep-analysis report,
3. one continuation only if genuinely necessary.

Keep the full raw report as a GitHub Actions artifact.

## Discord reliability

Use a per-product message queue.

On 429:

- honor retry information,
- exponential backoff,
- jitter,
- bounded attempts.

Never let one webhook queue block another product.

## Historical state

Recommended layout:

ai-tracker/state/chatgpt/
ai-tracker/state/gemini/
ai-tracker/state/claude/

Each product state contains component fingerprints and successful baseline metadata.

Keep exact baseline files separate for each component.

Never advance a baseline from an incomplete scan.

## Failure isolation

Every HTTP source has:

- timeout,
- retry classification,
- bounded retries,
- backoff,
- source-local diagnostics.

A failure in one source or artifact does not kill unrelated work.

A deep scan is considered successful only when required phases for that component complete.

If incomplete:

- retain old successful baseline,
- preserve partial report,
- mark scan incomplete,
- retry on a future trigger.

## SSRF/download safety

Only configured source and CDN hosts may be downloaded.

Never make network requests to arbitrary URLs found inside a downloaded artifact.

URLs found inside artifacts are analyzed as data only.

## Resource guards

Before each large download:

- inspect free disk,
- inspect artifact size,
- enforce a per-artifact ceiling,
- enforce product/run resource limits,
- preserve a disk reserve.

If a limit is reached, follow the documented artifact priority tiers and record what was skipped.

## Metadata caching

Prefer ETag and Last-Modified.

Deduplicate artifacts by:

1. vendor SHA-256,
2. npm integrity,
3. release checksum/digest,
4. local SHA-256.

Identical bytes must not be analyzed twice.

## Implementation modules

Planned modules:

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
  acquire/
    http.mjs
    integrity.mjs
    artifact-manifest.mjs
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
  state/
    load.mjs
    merge.mjs
    persist.mjs

## Tests

Required tests:

- version/channel normalization,
- source precedence,
- HTTP retries/timeouts,
- URL allowlisting,
- checksum/integrity validation,
- artifact deduplication,
- ASAR extraction,
- source-map extraction,
- string normalization,
- exact external diff,
- structured diff,
- state transaction/merge,
- Discord chunking and 429 retry.

Use fixtures for integration tests; do not make live vendor downloads mandatory for every CI test.

## Audit conclusion

The previous plan was directionally correct but needed these changes before implementation:

1. separate CLI and desktop version state,
2. remove the unverified Antigravity GitHub repository,
3. use the official OpenAI release metadata path,
4. use the official Codex product page for desktop discovery,
5. add Claude Linux apt metadata,
6. explicitly separate stable from alpha/preview/nightly,
7. detect same-version artifact mutations,
8. make state writes transactional,
9. add dependency/config/schema diffs,
10. make feature flags and metadata first-class signals,
11. preserve exact diffing and full raw evidence,
12. keep all five trackers independently parallel.
