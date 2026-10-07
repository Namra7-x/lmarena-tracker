# AI Artifact Tracker — Implementation Plan

## Scope

Track three product families:

- ChatGPT / Codex: Codex CLI + Codex desktop surface
- Gemini / Antigravity: Antigravity CLI + Antigravity desktop surface
- Claude: Claude Code + Claude desktop surface

Interpretation: "Cloud Code/Desktop" in the request is implemented as Claude Code/Desktop.

## Trigger architecture

The existing Cloudflare -> GitHub `repository_dispatch` event type `tracker` is reused unchanged.

A new workflow, `.github/workflows/ai-artifact-tracker.yml`, listens to that same event. The existing Arena workflow is not modified.

Every trigger:

1. Fetch lightweight release/version/manifests only.
2. Compare the current product fingerprint with the last successfully completed fingerprint.
3. If unchanged, exit without downloads.
4. If changed, send the product Discord alert before downloading anything.
5. Deep-scan the changed product only.
6. Commit compact baselines/state only after a successful scan.

## Product source strategy

### ChatGPT / Codex

- OpenAI Codex GitHub Releases for CLI/native release assets.
- `@openai/codex` npm registry metadata and tarball.
- Official ChatGPT desktop download page for the current desktop distribution.
- The official Codex installer/download metadata is treated as another distribution surface when discoverable.

### Gemini / Antigravity

- Official Antigravity download page for desktop + CLI versions and installers.
- Official Antigravity installer scripts (`install.sh`, `install.ps1`, `install.cmd`) are inspected as text instead of executed.
- Public Antigravity CLI GitHub source/release surfaces are used when available.

### Claude

- Anthropic Claude Code GitHub Releases for native CLI assets.
- `@anthropic-ai/claude-code` npm registry metadata and tarball.
- Official Claude download page for desktop installers and enterprise installer surfaces.

## Deep-analysis pipeline

artifact
-> fingerprint/deduplicate
-> recursive extraction
-> nested archive discovery
-> Electron ASAR extraction
-> source-map extraction
-> WASM/native inspection where possible
-> ASCII + UTF-16LE strings
-> normalized records
-> external-sort diff
-> signal classification
-> cross-artifact correlation
-> compact Discord summary
-> full GitHub Actions artifact report

Downloaded vendor binaries are never executed.

## Why external sorting is used

The scanner does not load millions of strings into a JavaScript Set.

Instead it writes:

- sorted exact SHA-256 string hashes
- compact string records for changed strings

Then GNU `sort` + `comm` + `join` performs memory-bounded set operations. This preserves exact hashes while keeping RAM predictable.

Two product baselines are maintained:

- `previous`: the immediately previous successfully scanned release
- `seen`: the union across previously scanned releases

This allows the report to distinguish:

- newly changed strings
- first-seen strings
- reintroduced strings

## Filtering rule

Filtering is presentation/scoring only.

Raw extracted discoveries are preserved in the run's report artifact. A string is not discarded merely because it looks noisy today.

High-signal classes include:

- model identifiers
- API URLs/endpoints/domains
- CLI commands and `--flags`
- environment variables
- configuration keys
- feature flags and rollout controls
- MCP/tool/plugin/agent/subagent identifiers
- provider/backend identifiers
- protocol/schema/request fields
- sandbox/permission/security controls
- experimental/internal/preview/nightly signals

Low-value candidates are down-ranked rather than removed from the baseline.

## Artifact deduplication

Each artifact is identified by its strongest available content identity:

- GitHub release SHA-256 digest
- npm package integrity
- installer HTTP ETag/Last-Modified/length fingerprint
- downloaded SHA-256 when no remote identity exists

Previously analyzed identical artifacts can be skipped safely because their content has already contributed to the product baseline.

## Persistence

Only compact state/baselines are committed back to Git:

`ai-tracker/state/ai-tracker.json`
`ai-tracker/state/baselines/<product>-previous.sha256`
`ai-tracker/state/baselines/<product>-seen.sha256`

Large raw reports and changed-string records stay in the GitHub Actions artifact for the run.

## Discord

Exactly three product webhook secrets are used:

- `DISCORD_WEBHOOK_CHATGPT`
- `DISCORD_WEBHOOK_GEMINI`
- `DISCORD_WEBHOOK_CLAUDE`

The first message is the release/change alert. Deep-analysis results are sent afterwards to the same product channel.

## Failure behavior

A failed or incomplete deep scan does not advance the successful baseline. The next minute can retry without pretending the product was fully analyzed.

No downloaded installer/binary is executed.
