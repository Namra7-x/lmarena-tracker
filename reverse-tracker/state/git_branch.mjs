/**
 * Git State Branch Helper (Section 2.1)
 * Manages orphan state branches (state/openai, state/anthropic, etc.)
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Setup or clone the state branch into a target directory.
 */
export function ensureStateDirectory(stateDir, familyId) {
  const branchName = `state/${familyId}`;
  fs.mkdirSync(stateDir, { recursive: true });

  try {
    // Check if remote state branch exists
    const checkBranch = execSync(`git ls-remote --heads origin ${branchName}`, { encoding: 'utf8' }).trim();
    if (checkBranch) {
      console.log(`Found remote state branch ${branchName}. Fetching...`);
      execSync(`git fetch origin ${branchName}:${branchName} --depth=1`, { stdio: 'ignore' });
    }
  } catch (err) {
    console.log(`Remote state branch ${branchName} not found or fetch failed. Proceeding locally.`);
  }

  return stateDir;
}

/**
 * Commit and push state changes with rebase retries.
 */
export function commitAndPushState(stateDir, familyId, commitMessage = 'Update tracker state') {
  const branchName = `state/${familyId}`;

  try {
    execSync('git config user.name "early-signal-tracker-bot"', { stdio: 'ignore' });
    execSync('git config user.email "actions@github.com"', { stdio: 'ignore' });

    // Stage changes in state directory
    execSync(`git add "${stateDir}"`, { stdio: 'ignore' });

    const diffCheck = execSync('git diff --cached --quiet', { stdio: 'ignore' });
    // Exit code 0 means no changes
    return { committed: false, reason: 'No state changes' };
  } catch (err) {
    // Diff found changes, proceed to commit
    try {
      execSync(`git commit -m "${commitMessage}"`, { stdio: 'ignore' });

      // Push with bounded rebase retries
      let pushed = false;
      for (let i = 0; i < 3; i++) {
        try {
          execSync(`git push origin HEAD:${branchName}`, { stdio: 'ignore' });
          pushed = true;
          break;
        } catch (pushErr) {
          execSync('git pull --rebase origin ${branchName}', { stdio: 'ignore' });
        }
      }

      return { committed: true, pushed };
    } catch (commitErr) {
      return { committed: false, error: commitErr.message };
    }
  }
}
