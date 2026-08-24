import type { NormalizedMessage } from '@larksuite/channel';
import type { Controls } from '../commands';
import type { AccessDecision } from '../policy/access';
import { evaluateRunPolicy } from '../policy/run-policy';
import { resolveWorkingDirectory } from '../policy/workspace';
import type { SessionCatalogIdentity } from '../session/catalog';
import type { WorkspaceStore } from '../workspace/store';
import type { ChatMode } from './chat-mode-cache';

export async function commandSessionCatalogIdentity(input: {
  msg: NormalizedMessage;
  scope: string;
  mode: ChatMode;
  workspaces: WorkspaceStore;
  controls: Controls;
  access: AccessDecision;
}): Promise<SessionCatalogIdentity | undefined> {
  const requestedCwd =
    input.workspaces.cwdFor(input.scope) ?? input.controls.cfg.workspaces.default;
  if (!requestedCwd) return undefined;
  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok) return undefined;
  const policy = evaluateRunPolicy({
    scope: {
      source: 'im',
      chatId: input.msg.chatId,
      actorId: input.msg.senderId,
      ...(input.mode === 'topic' && input.msg.threadId ? { threadId: input.msg.threadId } : {}),
    },
    attachments: [],
    prompt: '',
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: input.access,
    profileConfig: input.controls.cfg,
    now: Date.now(),
  });
  if (!policy.ok) return undefined;
  return {
    scopeId: input.scope,
    cwdRealpath: workspace.cwdRealpath,
    policyFingerprint: policy.policyFingerprint,
  };
}
