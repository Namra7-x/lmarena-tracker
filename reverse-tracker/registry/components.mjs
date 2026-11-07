/**
 * Component Registry
 * Defines all 13 components, their families, scan prefixes, and platform matrices.
 */

export const FAMILIES = {
  openai: {
    id: 'openai',
    displayName: 'OpenAI',
    components: ['codex-cli', 'codex-desktop'],
  },
  anthropic: {
    id: 'anthropic',
    displayName: 'Anthropic',
    components: ['claude-code', 'claude-desktop'],
  },
  google: {
    id: 'google',
    displayName: 'Google',
    components: ['gemini-desktop', 'antigravity-desktop', 'antigravity-cli'],
  },
  cursor: {
    id: 'cursor',
    displayName: 'Cursor',
    components: ['cursor-desktop', 'cursor-cli'],
  },
  devin: {
    id: 'devin',
    displayName: 'Devin',
    components: ['devin-desktop', 'devin-cli'],
  },
  other: {
    id: 'other',
    displayName: 'Other',
    components: ['opencode-cli', 'droid-cli'],
  },
};

export const TARGET_PLATFORMS = {
  MACOS_ARM64: { os: 'darwin', arch: 'arm64', label: 'macOS (Apple Silicon)' },
  MACOS_X64: { os: 'darwin', arch: 'x64', label: 'macOS (Intel)' },
  WINDOWS_X64: { os: 'win32', arch: 'x64', label: 'Windows (x64)' },
  WINDOWS_ARM64: { os: 'win32', arch: 'arm64', label: 'Windows (ARM64)' },
  LINUX_X64: { os: 'linux', arch: 'x64', label: 'Linux (x64)' },
  LINUX_ARM64: { os: 'linux', arch: 'arm64', label: 'Linux (ARM64)' },
};

export const COMPONENTS = {
  'codex-cli': {
    id: 'codex-cli',
    name: 'Codex CLI',
    family: 'openai',
    scanPrefix: 'CX',
    type: 'cli',
    primaryTargets: ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'],
    sources: [
      { type: 'npm', package: '@openai/codex' },
      { type: 'github', repo: 'openai/codex' },
    ],
  },
  'codex-desktop': {
    id: 'codex-desktop',
    name: 'Codex Desktop (ChatGPT Desktop)',
    family: 'openai',
    scanPrefix: 'CD',
    type: 'desktop',
    primaryTargets: ['darwin-arm64', 'darwin-x64', 'win32-x64'],
    sources: [
      { type: 'direct_url', os: 'darwin', url: 'https://persistent.oaistatic.com/codex-app-prod/Codex.dmg' },
    ],
  },
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    family: 'anthropic',
    scanPrefix: 'CC',
    type: 'cli',
    primaryTargets: ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'],
    sources: [
      { type: 'npm', package: '@anthropic-ai/claude-code' },
    ],
  },
  'claude-desktop': {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    family: 'anthropic',
    scanPrefix: 'CA',
    type: 'desktop',
    primaryTargets: ['darwin-arm64', 'darwin-x64', 'win32-x64'],
    sources: [
      { type: 'direct_url', os: 'darwin', arch: 'arm64', url: 'https://downloads.claude.ai/claude-science/latest/mac-arm64.dmg' },
      { type: 'direct_url', os: 'darwin', arch: 'x64', url: 'https://downloads.claude.ai/claude-science/latest/mac-x64.dmg' },
      { type: 'direct_url', os: 'win32', arch: 'x64', url: 'https://downloads.claude.ai/claude-science/latest/windows-x64.exe' },
    ],
  },
  'gemini-desktop': {
    id: 'gemini-desktop',
    name: 'Gemini Desktop',
    family: 'google',
    scanPrefix: 'GD',
    type: 'desktop',
    primaryTargets: ['darwin-arm64', 'win32-x64', 'win32-arm64'],
    sources: [
      { type: 'redirect_url', os: 'darwin', arch: 'arm64', url: 'https://gemini.google/download/mac/' },
      { type: 'redirect_url', os: 'win32', arch: 'x64', url: 'https://gemini.google/download/windows/' },
    ],
  },
  'antigravity-desktop': {
    id: 'antigravity-desktop',
    name: 'Antigravity Desktop',
    family: 'google',
    scanPrefix: 'AD',
    type: 'desktop',
    primaryTargets: ['darwin-arm64', 'win32-x64'],
    sources: [
      { type: 'api', url: 'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/releases' },
    ],
  },
  'antigravity-cli': {
    id: 'antigravity-cli',
    name: 'Antigravity CLI',
    family: 'google',
    scanPrefix: 'AC',
    type: 'cli',
    primaryTargets: ['darwin-arm64', 'win32-x64'],
    sources: [
      { type: 'manifest_base', url: 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests' },
    ],
  },
  'cursor-desktop': {
    id: 'cursor-desktop',
    name: 'Cursor Desktop',
    family: 'cursor',
    scanPrefix: 'CR',
    type: 'desktop',
    primaryTargets: ['darwin-arm64', 'win32-x64'],
    sources: [
      { type: 'todesktop_feed', url: 'https://download.todesktop.com/230313mzl4w4u92' },
    ],
  },
  'cursor-cli': {
    id: 'cursor-cli',
    name: 'Cursor CLI (agent)',
    family: 'cursor',
    scanPrefix: 'CL',
    type: 'cli',
    primaryTargets: ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'],
    sources: [
      { type: 'install_script', os: 'unix', url: 'https://cursor.com/install' },
      { type: 'install_script', os: 'win32', url: 'https://cursor.com/install?win32=true' },
    ],
  },
  'devin-desktop': {
    id: 'devin-desktop',
    name: 'Devin Desktop',
    family: 'devin',
    scanPrefix: 'DD',
    type: 'desktop',
    primaryTargets: ['darwin-arm64', 'win32-x64'],
    sources: [
      { type: 'homebrew_cask', cask: 'devin-desktop' },
    ],
  },
  'devin-cli': {
    id: 'devin-cli',
    name: 'Devin CLI',
    family: 'devin',
    scanPrefix: 'DC',
    type: 'cli',
    primaryTargets: ['darwin-arm64', 'win32-x64'],
    sources: [
      { type: 'manifest', url: 'https://static.devin.ai/cli/current/manifest.json' },
    ],
  },
  'opencode-cli': {
    id: 'opencode-cli',
    name: 'OpenCode CLI (v2)',
    family: 'other',
    scanPrefix: 'OC',
    type: 'cli',
    primaryTargets: ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'],
    sources: [
      { type: 'npm', package: '@opencode/cli' },
      { type: 'github', repo: 'anomalyco/opencode' },
    ],
  },
  'droid-cli': {
    id: 'droid-cli',
    name: 'Droid CLI (Factory)',
    family: 'other',
    scanPrefix: 'DR',
    type: 'cli',
    primaryTargets: ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'],
    sources: [
      { type: 'npm', package: 'droid' },
      { type: 'installer_script', url: 'https://app.factory.ai/cli' },
      { type: 'binary_base', url: 'https://downloads.factory.ai/factory-cli/releases' },
    ],
  },
};

/**
 * Generate a unique deterministic scan ID: PREFIX-YYYYMMDD-SEQ
 */
export function generateScanId(componentId, date = new Date(), sequence = 1) {
  const comp = COMPONENTS[componentId];
  const prefix = comp ? comp.scanPrefix : 'XX';
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const seqStr = String(sequence).padStart(3, '0');
  return `${prefix}-${yyyy}${mm}${dd}-${seqStr}`;
}
