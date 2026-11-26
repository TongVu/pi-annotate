import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { reviewQuery } from './review-repo.ts';

// Explicitly loaded only by the restricted reviewer launcher.
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'review_repo', label: 'Review repository',
    description: 'Inspect the current Git worktree. Start with scope (branch, comparison base and changes); files lists repository files, diff shows tracked changes for a path, read shows current file contents (including non-ignored new files). Use offset to continue truncated output.',
    parameters: Type.Object({ action: Type.Union(['scope','files','diff','read'].map(v => Type.Literal(v))), path: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
    async execute(_id, { action, path, offset }, _signal, _update, ctx) {
      return { content: [{ type: 'text', text: await reviewQuery(ctx.cwd, action, path, offset) || '(empty)' }], details: undefined };
    },
  });
}
