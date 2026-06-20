#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const hooksDir = resolve(repoRoot, '.githooks');

function runGit(args) {
  return spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function main() {
  if (!existsSync(hooksDir)) {
    console.warn('Skipping git hook setup: .githooks directory not found.');
    return;
  }

  const gitDir = runGit(['rev-parse', '--git-dir']);
  if (gitDir.status !== 0) {
    console.warn('Skipping git hook setup: not inside a git repository.');
    return;
  }

  const currentHooksPath = runGit(['config', '--get', 'core.hooksPath']);
  const normalizedCurrent = currentHooksPath.stdout.trim();

  if (normalizedCurrent && normalizedCurrent !== '.githooks') {
    console.warn(`Leaving existing core.hooksPath untouched: ${normalizedCurrent}`);
    console.warn('Run `git config core.hooksPath .githooks` manually if you want to use this repo hook set.');
    return;
  }

  const setHooksPath = runGit(['config', 'core.hooksPath', '.githooks']);
  if (setHooksPath.status !== 0) {
    throw new Error(setHooksPath.stderr.trim() || 'Failed to configure core.hooksPath');
  }

  console.log('Configured git hooks: core.hooksPath=.githooks');
}

main();
