import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import type { AgentKind } from '../config/profile-schema';

export type { AgentKind } from '../config/profile-schema';

export interface DetectedAgent {
  kind: AgentKind;
  binaryPath: string;
}

export async function resolveExecutablePath(command: string): Promise<string> {
  if (isAbsolute(command)) {
    await access(command, constants.X_OK);
    return command;
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error(`executable not found: ${command}`);
}

export async function detectInstalledAgents(): Promise<DetectedAgent[]> {
  const candidates: Array<{ kind: AgentKind; command: string }> = [
    { kind: 'claude', command: process.env.LARK_CHANNEL_CLAUDE_BIN ?? 'claude' },
    { kind: 'codex', command: process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex' },
    { kind: 'omp', command: process.env.LARK_CHANNEL_OMP_BIN ?? 'omp' },
  ];
  const detected: DetectedAgent[] = [];
  for (const candidate of candidates) {
    try {
      detected.push({
        kind: candidate.kind,
        binaryPath: await resolveExecutablePath(candidate.command),
      });
    } catch {
      // Missing agents are reported by the caller based on the final count.
    }
  }
  return detected;
}
