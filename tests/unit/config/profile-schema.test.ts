import { describe, expect, it } from 'vitest';
import { accessToClaudePermissionMode, clampAccess } from '../../../src/config/permissions';
import {
  createDefaultProfileConfig,
  normalizeProfileConfig,
} from '../../../src/config/profile-schema';

const app = {
  id: 'cli_test',
  secret: '${APP_SECRET}',
  tenant: 'feishu' as const,
};

describe('profile schema', () => {
  it('defaults deployment mode to personal and parses team', () => {
    const fresh = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } });
    expect(fresh.mode).toBe('personal');

    const team = createDefaultProfileConfig({
      agentKind: 'claude',
      mode: 'team',
      accounts: { app },
    });
    expect(team.mode).toBe('team');

    const missing = normalizeProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });
    expect(missing.mode).toBe('personal');
    const bogus = normalizeProfileConfig({
      agentKind: 'claude',
      mode: 'nonsense',
      accounts: { app },
    });
    expect(bogus.mode).toBe('personal');
  });

  it('requires codex configuration when agentKind is codex', () => {
    expect(() =>
      normalizeProfileConfig({
        agentKind: 'codex',
        accounts: { app },
      }),
    ).toThrow(/codex/i);
  });

  it('requires and normalizes OMP configuration when agentKind is omp', () => {
    expect(() =>
      normalizeProfileConfig({
        agentKind: 'omp',
        accounts: { app },
      }),
    ).toThrow(/omp/i);

    const cfg = createDefaultProfileConfig({
      agentKind: 'omp',
      accounts: { app },
      omp: { binaryPath: '/usr/local/bin/omp', profile: ' work ' },
    });
    expect(cfg.omp).toEqual({ binaryPath: '/usr/local/bin/omp', profile: 'work' });
  });

  it('keeps access at profile top level', () => {
    const cfg = normalizeProfileConfig({
      agentKind: 'claude',
      accounts: { app },
      preferences: {
        messageReply: 'markdown',
      },
      access: {
        allowedUsers: [],
        allowedChats: [],
        admins: [],
      },
    });

    expect(cfg.preferences).not.toHaveProperty('access');
    expect(cfg.access).toEqual({
      allowedUsers: [],
      allowedChats: [],
      admins: [],
      requireMentionInGroup: true,
    });
  });

  it('normalizes workspaces to a default working directory only', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });

    expect(cfg.workspaces).toEqual({});
  });

  it('seeds attachment limits from the runtime policy', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });

    expect(cfg.attachments).toMatchObject({
      maxCount: 10,
      maxBytes: 100 * 1024 * 1024,
      maxFileBytes: 25 * 1024 * 1024,
      imageMaxBytes: 25 * 1024 * 1024,
    });
  });

  it('normalizes Codex binary metadata and user-home defaults', () => {
    const cfg = normalizeProfileConfig({
      agentKind: 'codex',
      accounts: { app },
      codex: {
        binaryPath: '/usr/local/bin/codex',
        realpath: '/opt/codex/bin/codex',
        version: 'codex 1.2.3',
        sha256: 'abc123',
        owner: 501,
        mode: 0o755,
      },
    });

    expect(cfg.codex).toMatchObject({
      binaryPath: '/usr/local/bin/codex',
      realpath: '/opt/codex/bin/codex',
      version: 'codex 1.2.3',
      sha256: 'abc123',
      owner: 501,
      mode: 0o755,
      inheritCodexHome: true,
      ignoreUserConfig: false,
      ignoreRules: true,
    });
  });

  it('preserves explicit Codex home isolation when configured', () => {
    const cfg = normalizeProfileConfig({
      agentKind: 'codex',
      accounts: { app },
      codex: {
        binaryPath: '/usr/local/bin/codex',
        inheritCodexHome: false,
      },
    });

    expect(cfg.codex?.inheritCodexHome).toBe(false);
  });

  it('defaults Claude permissions to full access', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });

    expect(cfg.permissions).toMatchObject({
      defaultAccess: 'full',
      maxAccess: 'full',
    });
  });

  it('defaults Codex permissions to full access', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app },
      codex: { binaryPath: '/usr/local/bin/codex' },
    });

    expect(cfg.permissions).toMatchObject({
      defaultAccess: 'full',
      maxAccess: 'full',
    });
  });

  it('rejects permission defaults that exceed max access', () => {
    expect(() =>
      normalizeProfileConfig({
        agentKind: 'claude',
        accounts: { app },
        permissions: {
          defaultAccess: 'full',
          maxAccess: 'workspace',
        },
      }),
    ).toThrow(/permission/i);
  });

  it('uses Claude permissionMode override when deriving Claude runtime permissions', () => {
    const cfg = normalizeProfileConfig({
      agentKind: 'claude',
      accounts: { app },
      permissions: {
        defaultAccess: 'full',
        maxAccess: 'full',
        claude: {
          permissionMode: 'default',
        },
      },
    });

    expect(accessToClaudePermissionMode('full', cfg.permissions)).toBe('default');
  });

  it('clamps access by both profile and capability maximums', () => {
    expect(clampAccess('full', 'workspace', 'full')).toBe('workspace');
    expect(clampAccess('workspace', 'full', 'read-only')).toBe('read-only');
    expect(clampAccess('read-only', 'full', 'full')).toBe('read-only');
  });

  it('rejects Claude permission overrides wider than max access', () => {
    expect(() =>
      normalizeProfileConfig({
        agentKind: 'claude',
        accounts: { app },
        permissions: {
          maxAccess: 'read-only',
          claude: {
            permissionMode: 'bypassPermissions',
          },
        },
      }),
    ).toThrow(/permission/i);
  });

  it('does not let Claude override exceed the current access at runtime mapping time', () => {
    const cfg = normalizeProfileConfig({
      agentKind: 'claude',
      accounts: { app },
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'full',
        claude: {
          permissionMode: 'bypassPermissions',
        },
      },
    });

    expect(accessToClaudePermissionMode('read-only', cfg.permissions)).toBe('plan');
  });

  it('rejects array-shaped permissions config', () => {
    expect(() =>
      normalizeProfileConfig({
        agentKind: 'claude',
        accounts: { app },
        permissions: [],
      }),
    ).toThrow(/permission/i);
  });

  it('rejects array-shaped Claude permissions config', () => {
    expect(() =>
      normalizeProfileConfig({
        agentKind: 'claude',
        accounts: { app },
        permissions: {
          claude: [],
        },
      }),
    ).toThrow(/permission/i);
  });

  it('clamps default access from full defaults when only canonical max access is explicit', () => {
    const cfg = normalizeProfileConfig({
      agentKind: 'claude',
      accounts: { app },
      permissions: {
        maxAccess: 'workspace',
      },
    });

    expect(cfg.permissions).toMatchObject({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
  });
});
