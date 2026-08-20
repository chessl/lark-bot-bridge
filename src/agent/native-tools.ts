import type { ScopeContext } from '../policy/run-policy';

export interface NativeMcpEndpoint {
  name: string;
  url: string;
  bearerToken: string;
}

export interface NativeToolRunContext {
  runId: string;
  scopeId: string;
  scope: ScopeContext;
  policyFingerprint: string;
  allowUserIdentity: boolean;
}

export interface NativeToolProvider {
  openRun(context: NativeToolRunContext): NativeMcpEndpoint;
  closeRun(runId: string): Promise<void>;
}
