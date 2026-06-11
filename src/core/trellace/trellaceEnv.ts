/**
 * Trellace env injection.
 *
 * Reads ~/.claude/remote-settings.json (the org-pushed managed settings cache)
 * directly, bypassing the CLI's auth gate, and exposes only TRELLACE_-prefixed
 * variables for injection into session env. Non-prefixed variables are never
 * injected: a plain ANTHROPIC_API_KEY here would silently switch every team
 * session's own auth to API billing.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const TRELLACE_ENV_PREFIX = 'TRELLACE_';

export function getRemoteSettingsPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.claude', 'remote-settings.json');
}

/**
 * Returns TRELLACE_-prefixed string variables from the remote-settings env
 * block. Silently returns {} if the file is absent, unreadable, or malformed.
 */
export function readTrellaceRemoteEnv(
  remoteSettingsPath: string = getRemoteSettingsPath()
): Record<string, string> {
  try {
    if (!fs.existsSync(remoteSettingsPath)) return {};

    const parsed: unknown = JSON.parse(fs.readFileSync(remoteSettingsPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return {};

    const env = (parsed as Record<string, unknown>).env;
    if (!env || typeof env !== 'object' || Array.isArray(env)) return {};

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (key.startsWith(TRELLACE_ENV_PREFIX) && typeof value === 'string') {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}
