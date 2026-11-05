/**
 * Cloudflare Worker: Minute-by-Minute Fast Tracker (Section 2)
 * Performs cheap API checks and fires repository_dispatch only on real changes.
 */

const REPO_OWNER = 'Namra7-x';
const REPO_NAME = 'lmarena-tracker';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCronCheck(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/check') {
      const results = await handleCronCheck(env);
      return new Response(JSON.stringify(results, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('Early Feature & Signal Finder Worker is Running.');
  },
};

async function handleCronCheck(env) {
  const checks = [
    { id: 'codex-cli', family: 'openai', url: 'https://registry.npmjs.org/@openai/codex', type: 'npm' },
    { id: 'claude-code', family: 'anthropic', url: 'https://registry.npmjs.org/@anthropic-ai/claude-code', type: 'npm' },
    { id: 'opencode-cli', family: 'other', url: 'https://registry.npmjs.org/@opencode/cli', type: 'npm' },
    { id: 'droid-cli', family: 'other', url: 'https://registry.npmjs.org/droid', type: 'npm' },
    { id: 'devin-cli', family: 'devin', url: 'https://static.devin.ai/cli/current/manifest.json', type: 'json_version' },
    { id: 'antigravity-cli', family: 'google', url: 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json', type: 'json_version' },
    { id: 'antigravity-desktop', family: 'google', url: 'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/releases', type: 'json_array_first' },
  ];

  const results = [];

  for (const check of checks) {
    try {
      let currentVersion = null;
      const res = await fetch(check.url, { headers: { 'User-Agent': 'Cloudflare-Worker' } });

      if (res.ok) {
        if (check.type === 'npm') {
          const data = await res.json();
          currentVersion = data['dist-tags']?.latest;
        } else if (check.type === 'json_version') {
          const data = await res.json();
          currentVersion = data.version;
        } else if (check.type === 'json_array_first') {
          const data = await res.json();
          currentVersion = data[0]?.version;
        }
      }

      if (currentVersion) {
        // Compare against KV stored version if KV is bound
        let previousVersion = null;
        if (env?.TRACKER_KV) {
          previousVersion = await env.TRACKER_KV.get(`ver:${check.id}`);
        }

        if (previousVersion && previousVersion !== currentVersion) {
          console.log(`Change detected for ${check.id}: ${previousVersion} -> ${currentVersion}`);

          // Trigger GitHub repository_dispatch
          if (env?.GITHUB_TOKEN) {
            await triggerRepositoryDispatch(env.GITHUB_TOKEN, check.family, check.id, currentVersion);
          }

          results.push({ id: check.id, status: 'changed', from: previousVersion, to: currentVersion });
        } else {
          results.push({ id: check.id, status: 'unchanged', version: currentVersion });
        }

        if (env?.TRACKER_KV) {
          await env.TRACKER_KV.put(`ver:${check.id}`, currentVersion);
        }
      }
    } catch (err) {
      results.push({ id: check.id, status: 'error', error: err.message });
    }
  }

  return results;
}

async function triggerRepositoryDispatch(githubToken, family, componentId, version) {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/dispatches`;
  await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Cloudflare-Worker',
    },
    body: JSON.stringify({
      event_type: 'tracker',
      client_payload: {
        family,
        componentId,
        version,
      },
    }),
  });
}
