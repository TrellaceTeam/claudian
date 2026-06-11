/**
 * Trellace layer orchestration: runs at plugin load (Claudian code, not a
 * hook, so it works even when zero hooks are registered) and provides the
 * status line surfaced by the "Trellace layer status" command.
 */

import type { VaultFileAdapter } from '../storage/VaultFileAdapter';
import { type MaterializeResult,materializeTrellaceHooks } from './hookMaterializer';
import { createDefaultPythonResolverDeps, resolvePythonPath } from './pythonResolver';
import { readTrellaceRemoteEnv } from './trellaceEnv';

/**
 * Resolves the machine's python and materializes the synced hook
 * definitions into .claude/settings.json. Never throws.
 */
export async function initializeTrellaceLayer(
  adapter: VaultFileAdapter
): Promise<MaterializeResult> {
  try {
    const deps = createDefaultPythonResolverDeps();
    // Org-pushed TRELLACE_PYTHON (remote settings) also feeds the resolver.
    const pythonPath = resolvePythonPath({
      ...deps,
      env: { ...deps.env, ...readTrellaceRemoteEnv() },
    });
    return await materializeTrellaceHooks(adapter, pythonPath);
  } catch {
    return { status: 'error', hooksMaterialized: 0, pythonPath: null };
  }
}

const STATUS_SUFFIXES: Partial<Record<MaterializeResult['status'], string>> = {
  'no-python': ' (python not found)',
  'no-source': ' (args/claudian-hooks.yaml not found)',
  'malformed-source': ' (source yaml malformed)',
  'settings-unreadable': ' (settings.json unreadable)',
  error: ' (materialization error)',
};

export function formatTrellaceLayerStatus(
  envVarCount: number,
  hooks: MaterializeResult
): string {
  const envPart = envVarCount > 0 ? 'yes' : 'no';
  const suffix = STATUS_SUFFIXES[hooks.status] ?? '';
  return `Trellace layer: env injected ${envPart} | hooks materialized ${hooks.hooksMaterialized}${suffix}`;
}
