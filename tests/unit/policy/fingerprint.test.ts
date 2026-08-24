import { describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  accessPolicyDigest,
  attachmentPolicyConfigDigest,
  digestCanonical,
  policyFingerprint,
  resourceScopeDigest,
} from '../../../src/policy/fingerprint';

describe('policy fingerprint', () => {
  it('is deterministic and changes with any policy input', () => {
    const base = {
      cwdRealpath: '/repo',
      accessPolicyDigest: digestCanonical('access'),
      resourceScopeDigest: digestCanonical('scope'),
      attachmentPolicyShapeDigest: digestCanonical('attachments'),
    };
    expect(policyFingerprint(base)).toBe(policyFingerprint({ ...base }));
    for (const changed of [
      { cwdRealpath: '/other' },
      { accessPolicyDigest: digestCanonical('other-access') },
      { resourceScopeDigest: digestCanonical('other-scope') },
      { attachmentPolicyShapeDigest: digestCanonical('other-attachments') },
    ]) {
      expect(policyFingerprint({ ...base, ...changed })).not.toBe(policyFingerprint(base));
    }
  });

  it('normalizes set-like access and resource fields', () => {
    const profile = createDefaultProfileConfig({
      app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' },
      omp: { binaryPath: '/usr/local/bin/omp' },
      access: { allowedUsers: ['b', 'a'], allowedChats: ['y', 'x'], admins: ['d', 'c'] },
    });
    expect(accessPolicyDigest(profile.access)).toBe(
      accessPolicyDigest({
        ...profile.access,
        allowedUsers: ['a', 'b'],
        allowedChats: ['x', 'y'],
        admins: ['c', 'd'],
      }),
    );
    expect(resourceScopeDigest({ source: 'comment', resourceBindings: ['b', 'a'] })).toBe(
      resourceScopeDigest({ source: 'comment', resourceBindings: ['a', 'b'] }),
    );
  });

  it('includes executable attachment limits but excludes cache details', () => {
    const profile = createDefaultProfileConfig({
      app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' },
      omp: { binaryPath: '/usr/local/bin/omp' },
    });
    const baseline = attachmentPolicyConfigDigest(profile.attachments);
    expect(
      attachmentPolicyConfigDigest({ ...profile.attachments, cacheTtlMs: 1, cacheMaxBytes: 2 }),
    ).toBe(baseline);
    expect(attachmentPolicyConfigDigest({ ...profile.attachments, maxCount: 1 })).not.toBe(
      baseline,
    );
  });
});
