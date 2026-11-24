/**
 * Git State Branch Helper (Section 2.1)
 * Manages orphan state branches (state/openai, state/anthropic, etc.)
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
  });
}

/**
 * Setup or fetch the state branch into a target directory.
 */
export function ensureStateDirectory(stateDir, familyId) {
  const branchName = `state/${familyId}`;
  fs.mkdirSync(stateDir, { recursive: true });

  try {
    const checkBranch = runGit(['ls-remote', '--heads', 'origin', branchName], process.cwd()).trim();
    if (checkBranch) {
      console.log(`Found remote state branch ${branchName}. Fetching...`);
      runGit(['fetch', 'origin', `${branchName}:${branchName}`, '--depth=1'], process.cwd());
    }
  } catch {
    console.log(`Remote state branch ${branchName} not found or fetch failed. Proceeding locally.`);
  }

  return stateDir;
}

/**
 * Commit and push state changes with rebase retries.
 */
export function commitAndPushState(stateDir, familyId, commitMessage = 'Update tracker state') {
  const branchName = familyId ? `state/${familyId}` : (process.env.STATE_BRANCH || 'state/all');

  try {
    runGit(['config', 'user.name', 'early-signal-tracker-bot'], stateDir);
    runGit(['config', 'user.email', 'actions@github.com'], stateDir);
    runGit(['add', '--all', '.'], stateDir);

    try {
      runGit(['diff', '--cached', '--quiet'], stateDir);
      return { committed: false, reason: 'No state changes' };
    } catch {
      // Staged changes exist; proceed to commit.
    }

    runGit(['commit', '-m', `${commitMessage} [skip ci]`, '--no-verify'], stateDir);

    let pushed = false;
    for (let i = 0; i < 3; i++) {
      try {
        runGit(['push', 'origin', `HEAD:refs/heads/${branchName}`], stateDir);
        pushed = true;
        break;
      } catch {
        try {
          runGit(['pull', '--rebase', 'origin', branchName], stateDir);
        } catch {
          // Next attempt or workflow end-of-job persist will retry.
        }
      }
    }

    return { committed: true, pushed };
  } catch (commitErr) {
    return { committed: false, error: commitErr.message };
  }
}
