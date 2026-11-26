import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

// No shell, filters, external diff drivers, optional index writes, or fsmonitor hook.
async function git(cwd: string, ...args: string[]) {
  const { stdout } = await promisify(execFile)('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', ...args], { cwd, maxBuffer: 12 * 1024 * 1024, timeout: 15000 });
  return stdout;
}

export async function reviewScope(cwd: string) {
  const root = (await git(cwd, 'rev-parse', '--show-toplevel')).trimEnd();
  const branch = (await git(root, 'branch', '--show-current')).trim() || 'detached HEAD';
  const remote = (await git(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').catch(() => '')).trim();
  for (const ref of [...new Set([remote, 'main', 'master', 'HEAD'].filter(Boolean))]) {
    const base = (await git(root, 'merge-base', 'HEAD', ref).catch(() => '')).trim();
    if (base) return { root, branch, ref, base };
  }
  throw new Error('Verify agent needs a Git worktree with at least one commit.');
}

export async function reviewQuery(cwd: string, action: string, path = '', offset = 0) {
  const { root, branch, ref, base } = await reviewScope(cwd);
  const start = Math.max(0, Math.trunc(offset));
  const page = (text: string) => text.slice(start, start + 24000) + (text.length > start + 24000 ? `\n[Continue at offset ${start + 24000}]` : '');
  if (action === 'scope') return page(`Worktree: ${root}\nBranch: ${branch}\nBase: ${ref} (${base})\nIncludes staged, unstaged and non-ignored untracked files.\n` + await git(root, 'diff', '--no-ext-diff', '--no-textconv', '--name-status', base, '--') + await git(root, 'ls-files', '--others', '--exclude-standard'));
  if (action === 'files') return page(await git(root, 'ls-files', '--cached', '--others', '--exclude-standard'));
  if (!path || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..' || p === '.git')) throw new Error('Choose a repository-relative file.');
  if (action === 'diff') return page(await git(root, 'diff', '--no-ext-diff', '--no-textconv', base, '--', path));
  if (action !== 'read' || !(await git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', path)).split('\0').includes(path)) throw new Error('Not a reviewable repository file.');
  const file = resolve(root, path);
  if (await realpath(file) !== file || !file.startsWith(root + sep)) throw new Error('Symlinks are not reviewable.');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Not a regular file.');
    const buffer = Buffer.alloc(24001);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    if (buffer.subarray(0, bytesRead).includes(0)) throw new Error('Binary file omitted.');
    return buffer.toString('utf8', 0, Math.min(24000, bytesRead)) + (bytesRead > 24000 ? `\n[Continue at offset ${start + 24000}]` : '');
  } finally { await handle.close(); }
}
