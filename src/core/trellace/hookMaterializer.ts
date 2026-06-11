/**
 * Trellace hook materialization.
 *
 * The synced vault file args/claudian-hooks.yaml is the single source of
 * truth for team hooks (it rides Obsidian Sync; .claude/ does not). At
 * plugin load, Claudian reads it and MERGES the hooks into the machine's
 * local .claude/settings.json, the file the CLI loads natively on every
 * surface (Claudian, Claude Code desktop, terminal). One registration
 * path, no in-memory-only hooks, no desktop gap.
 *
 * Merge rules:
 * - Only the hooks key is touched; permissions and every other key are
 *   preserved byte-for-byte.
 * - Dedup is by exact command string: an identical hand-carried hook is
 *   adopted, never duplicated (no double-fire).
 * - Commands this layer added are tracked in .claude/trellace-hooks-state.json
 *   so edits and removals in the yaml propagate, while hooks the team added
 *   by hand are never removed.
 * - If python cannot be resolved, settings.json is left untouched; a
 *   command containing a raw {{PY}} is never written.
 */

import { parseYaml } from 'obsidian';

import type { VaultFileAdapter } from '../storage/VaultFileAdapter';

export const TRELLACE_HOOKS_SOURCE_PATH = 'args/claudian-hooks.yaml';
export const TRELLACE_HOOKS_STATE_PATH = '.claude/trellace-hooks-state.json';
const SETTINGS_PATH = '.claude/settings.json';
const DEFAULT_PLACEHOLDER = '{{PY}}';

export interface TrellaceHookDefinition {
  event: string;
  matcher: string;
  command: string;
  timeout?: number;
  statusMessage?: string;
}

export interface TrellaceHooksConfig {
  interpreterPlaceholder: string;
  definitions: TrellaceHookDefinition[];
}

/** Commands previously written by this layer, keyed by hook event. */
export type ManagedHooks = Record<string, string[]>;

export interface MergeResult {
  settings: Record<string, unknown>;
  managed: ManagedHooks;
  changed: boolean;
  materializedCount: number;
}

export type MaterializeStatus =
  | 'ok'
  | 'no-source'
  | 'malformed-source'
  | 'no-python'
  | 'settings-unreadable'
  | 'error';

export interface MaterializeResult {
  status: MaterializeStatus;
  hooksMaterialized: number;
  pythonPath: string | null;
}

interface CCHookCommand {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

interface CCHookMatcher {
  matcher?: string;
  hooks?: CCHookCommand[];
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parses the claudian-hooks.yaml text into hook definitions.
 * Returns null when the document is unparseable or has no hooks block.
 * Individual malformed entries are skipped, not fatal.
 */
export function parseTrellaceHooksConfig(yamlText: string): TrellaceHooksConfig | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || !isRecord(parsed.hooks)) return null;

  const placeholder =
    typeof parsed.interpreter_placeholder === 'string' && parsed.interpreter_placeholder
      ? parsed.interpreter_placeholder
      : DEFAULT_PLACEHOLDER;

  const definitions: TrellaceHookDefinition[] = [];
  for (const [event, entries] of Object.entries(parsed.hooks)) {
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      if (typeof entry.command !== 'string' || !entry.command) continue;

      const definition: TrellaceHookDefinition = {
        event,
        matcher: typeof entry.matcher === 'string' ? entry.matcher : '',
        command: entry.command,
      };
      if (typeof entry.timeout === 'number') definition.timeout = entry.timeout;
      if (typeof entry.statusMessage === 'string') definition.statusMessage = entry.statusMessage;
      definitions.push(definition);
    }
  }

  return { interpreterPlaceholder: placeholder, definitions };
}

/**
 * Replaces the interpreter placeholder with the quoted absolute python path.
 * Backslashes become forward slashes: hook commands execute under git-bash
 * on Windows, where backslashes are escape characters.
 */
export function substituteInterpreter(
  definitions: TrellaceHookDefinition[],
  placeholder: string,
  pythonPath: string
): TrellaceHookDefinition[] {
  const quoted = `"${pythonPath.replace(/\\/g, '/')}"`;
  return definitions.map((d) => ({
    ...d,
    command: d.command.split(placeholder).join(quoted),
  }));
}

function getHookCommands(matcherEntry: CCHookMatcher): CCHookCommand[] {
  return Array.isArray(matcherEntry.hooks) ? matcherEntry.hooks : [];
}

function eventContainsCommand(entries: CCHookMatcher[], command: string): boolean {
  return entries.some((m) => getHookCommands(m).some((h) => h.command === command));
}

function removeCommands(entries: CCHookMatcher[], commands: Set<string>): CCHookMatcher[] {
  if (commands.size === 0) return entries;
  return entries
    .map((m) => {
      const inner = getHookCommands(m);
      if (!inner.some((h) => typeof h.command === 'string' && commands.has(h.command))) {
        return m;
      }
      return {
        ...m,
        hooks: inner.filter((h) => !(typeof h.command === 'string' && commands.has(h.command))),
      };
    })
    .filter((m) => getHookCommands(m).length > 0);
}

/**
 * Pure merge of Trellace hook definitions into a settings.json object.
 * Returns a new object; the input is not mutated.
 */
export function mergeTrellaceHooks(
  settings: Record<string, unknown>,
  definitions: TrellaceHookDefinition[],
  previouslyManaged: ManagedHooks
): MergeResult {
  const result = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
  const hooks: Record<string, unknown> = isRecord(result.hooks) ? result.hooks : {};
  result.hooks = hooks;

  const desiredByEvent = new Map<string, TrellaceHookDefinition[]>();
  for (const def of definitions) {
    const list = desiredByEvent.get(def.event) ?? [];
    list.push(def);
    desiredByEvent.set(def.event, list);
  }

  const allEvents = new Set([...desiredByEvent.keys(), ...Object.keys(previouslyManaged)]);
  const managed: ManagedHooks = {};

  for (const event of allEvents) {
    const desired = desiredByEvent.get(event) ?? [];
    const desiredCommands = new Set(desired.map((d) => d.command));
    const stale = new Set(
      (previouslyManaged[event] ?? []).filter((cmd) => !desiredCommands.has(cmd))
    );

    let entries: CCHookMatcher[] = Array.isArray(hooks[event])
      ? (hooks[event] as CCHookMatcher[])
      : [];
    entries = removeCommands(entries, stale);

    for (const def of desired) {
      if (eventContainsCommand(entries, def.command)) continue;

      const inner: CCHookCommand = { type: 'command', command: def.command };
      if (def.timeout !== undefined) inner.timeout = def.timeout;
      if (def.statusMessage !== undefined) inner.statusMessage = def.statusMessage;
      entries.push({ matcher: def.matcher, hooks: [inner] });
    }

    if (entries.length > 0) {
      hooks[event] = entries;
    } else {
      delete hooks[event];
    }
    if (desired.length > 0) {
      managed[event] = desired.map((d) => d.command);
    }
  }

  if (Object.keys(hooks).length === 0 && settings.hooks === undefined) {
    delete result.hooks;
  }

  return {
    settings: result,
    managed,
    changed: JSON.stringify(result) !== JSON.stringify(settings),
    materializedCount: definitions.length,
  };
}

async function readJson(
  adapter: VaultFileAdapter,
  path: string
): Promise<Record<string, unknown> | null | 'unreadable'> {
  if (!(await adapter.exists(path))) return null;
  try {
    const parsed: unknown = JSON.parse(await adapter.read(path));
    return isRecord(parsed) ? parsed : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

function countManagedPresent(settings: Record<string, unknown>, managed: ManagedHooks): number {
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  let count = 0;
  for (const [event, commands] of Object.entries(managed)) {
    const entries = Array.isArray(hooks[event]) ? (hooks[event] as CCHookMatcher[]) : [];
    for (const command of commands) {
      if (eventContainsCommand(entries, command)) count++;
    }
  }
  return count;
}

/**
 * Reads args/claudian-hooks.yaml and merges its hooks into
 * .claude/settings.json. Designed to run at plugin load; never throws.
 */
export async function materializeTrellaceHooks(
  adapter: VaultFileAdapter,
  pythonPath: string | null
): Promise<MaterializeResult> {
  try {
    if (!(await adapter.exists(TRELLACE_HOOKS_SOURCE_PATH))) {
      return { status: 'no-source', hooksMaterialized: 0, pythonPath };
    }

    const config = parseTrellaceHooksConfig(await adapter.read(TRELLACE_HOOKS_SOURCE_PATH));
    if (!config) {
      return { status: 'malformed-source', hooksMaterialized: 0, pythonPath };
    }

    const rawState = await readJson(adapter, TRELLACE_HOOKS_STATE_PATH);
    const state = rawState === 'unreadable' || rawState === null ? {} : rawState;
    const previouslyManaged: ManagedHooks = isRecord(state.managed)
      ? (state.managed as ManagedHooks)
      : {};

    const rawSettings = await readJson(adapter, SETTINGS_PATH);
    if (rawSettings === 'unreadable') {
      return { status: 'settings-unreadable', hooksMaterialized: 0, pythonPath };
    }
    const settings = rawSettings ?? {};

    if (pythonPath === null) {
      // Never write a command with a raw placeholder. Previously
      // materialized hooks are left in place and reported.
      return {
        status: 'no-python',
        hooksMaterialized: countManagedPresent(settings, previouslyManaged),
        pythonPath: null,
      };
    }

    const definitions = substituteInterpreter(
      config.definitions,
      config.interpreterPlaceholder,
      pythonPath
    );

    const merge = mergeTrellaceHooks(settings, definitions, previouslyManaged);
    if (merge.changed) {
      await adapter.write(SETTINGS_PATH, JSON.stringify(merge.settings, null, 2));
    }

    await adapter.write(
      TRELLACE_HOOKS_STATE_PATH,
      JSON.stringify(
        {
          schemaVersion: 1,
          pythonPath,
          managed: merge.managed,
          materializedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );

    return { status: 'ok', hooksMaterialized: merge.materializedCount, pythonPath };
  } catch {
    return { status: 'error', hooksMaterialized: 0, pythonPath };
  }
}
