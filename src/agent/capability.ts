import type { AccessMode } from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from './bridge-system-prompt';

export type AgentCapabilityId = 'claude' | 'codex' | 'omp';
export type AgentSessionKind = 'claude-session' | 'codex-thread' | 'omp-session';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix';

export interface AgentCapability {
  agentId: AgentCapabilityId;
  sessionKind: AgentSessionKind;
  promptInjection: PromptInjectionMode;
  systemPrompt: string;
  supportsNativeHistory: boolean;
  callback: {
    marker: '__bridge_cb';
  };
  permissions: {
    maxAccess: AccessMode;
    supportedAccess?: readonly AccessMode[];
  };
}

export function claudeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'claude',
    sessionKind: 'claude-session',
    promptInjection: 'append-system-prompt',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
    },
    permissions: {
      maxAccess,
    },
  };
}

export function codexCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile.permissions.maxAccess;
  return {
    agentId: 'codex',
    sessionKind: 'codex-thread',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    callback: {
      marker: '__bridge_cb',
    },
    permissions: {
      maxAccess,
    },
  };
}

export function ompCapability(): AgentCapability {
  return {
    agentId: 'omp',
    sessionKind: 'omp-session',
    promptInjection: 'append-system-prompt',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
    },
    permissions: {
      maxAccess: 'full',
      supportedAccess: ['full'],
    },
  };
}

export function capabilityForProfile(
  profile: Pick<ProfileConfig, 'agentKind' | 'permissions'>,
): AgentCapability {
  switch (profile.agentKind) {
    case 'claude':
      return claudeCapability(profile);
    case 'codex':
      return codexCapability(profile);
    case 'omp':
      return ompCapability();
  }
}
