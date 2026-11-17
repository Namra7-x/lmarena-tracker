/**
 * Mid-run state checkpoint.
 *
 * The workflow persists the state branch at the end of the job. That means a
 * job killed during a 900 MB download/extraction can lose the fact that the
 * immediate Telegram alert was already sent, causing a duplicate alert on the
 * next run. This helper commits just the component JSON right after the alert
 * (and after delivery state transitions) so the next run can resume instead of
 * re-alerting.
 *
 * It is a no-op outside GitHub Actions or when state is not a git worktree.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    timeout: 30000,
  });
}

export function checkpointState(stateDir, family, message = 'Checkpoint tracker delivery state') {
  if (process.env.DISABLE_STATE_CHECKPOINT === 'true') {
    return { skipped: true, reason: 'disabled' };
  }
  if (process.env.GITHUB_ACTIONS !== 'true') {
    return { skipped: true, reason: 'not CI' };
  }
  if (!stateDir || !fs.existsSync(path.join(stateDir, '.git'))) {
    return { skipped: true, reason: 'state is not a git worktree' };
  }

  try {
    git(['config', 'user.name', 'early-signal-tracker-bot'], stateDir);
    git(['config', 'user.email', 'actions@github.com'], stateDir);
    git(['add', '--all', '.'], stateDir);

    try {
      git(['diff', '--cached', '--quiet'], stateDir);
      return { skipped: true, reason: 'no changes' };
    } catch {
      // There are staged changes.
    }

    git(['commit', '-m', `${message} [skip ci]`, '--no-verify'], stateDir);

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        git(['push', 'origin', `HEAD:refs/heads/state/${family}`], stateDir);
        return { committed: true, pushed: true, attempt };
      } catch {
        try {
          git(['pull', '--rebase', 'origin', `state/${family}`], stateDir);
        } catch {
          // If rebase fails, the final workflow persistence step can still try.
        }
      }
    }

    // The final workflow step only commits when `git diff --cached` is
    // non-empty. If the checkpoint commit cannot be pushed, undo it (keeping
    // the changes staged) so the workflow's own persistence step can retry.
    try {
      git(['reset', '--soft', 'HEAD~1'], stateDir);
    } catch {
      // If reset fails, leave the commit; the next checkpoint/final step may
      // still recover it.
    }
    return { committed: false, pushed: false, resetForWorkflowPush: true };
  } catch (err) {
    console.warn(`State checkpoint skipped: ${err.message}`);
    return { skipped: true, error: err.message };
  }
}
