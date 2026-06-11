import * as obsidian from 'obsidian';

import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { TrellaceHookDefinition } from '@/core/trellace/hookMaterializer';
import {
  materializeTrellaceHooks,
  mergeTrellaceHooks,
  parseTrellaceHooksConfig,
  substituteInterpreter,
  TRELLACE_HOOKS_SOURCE_PATH,
  TRELLACE_HOOKS_STATE_PATH,
} from '@/core/trellace/hookMaterializer';

const CC_SETTINGS_PATH = '.claude/settings.json';

/** Parsed shape of the real args/claudian-hooks.yaml. */
const REAL_CONFIG = {
  schema_version: 1,
  interpreter_placeholder: '{{PY}}',
  hooks: {
    SessionStart: [
      {
        matcher: '',
        command: 'cd "$CLAUDE_PROJECT_DIR" && {{PY}} hooks/session_start.py',
        timeout: 10,
      },
    ],
    Stop: [
      {
        matcher: '',
        command: 'cd "$CLAUDE_PROJECT_DIR" && {{PY}} hooks/memory_capture.py',
        timeout: 30,
      },
    ],
    PreToolUse: [
      {
        matcher: 'Bash|Write|Edit',
        command: 'cd "$CLAUDE_PROJECT_DIR" && {{PY}} hooks/guardrail_check.py',
        timeout: 180,
      },
      {
        matcher: 'Bash',
        command: 'cd "$CLAUDE_PROJECT_DIR" && {{PY}} hooks/permission_request_bash.py',
        timeout: 10,
        statusMessage: 'Checking for URLs/API keys...',
      },
    ],
  },
};

function createMemoryAdapter(files: Record<string, string> = {}) {
  const store = new Map(Object.entries(files));
  const adapter = {
    store,
    exists: jest.fn(async (p: string) => store.has(p)),
    read: jest.fn(async (p: string) => {
      const value = store.get(p);
      if (value === undefined) throw new Error(`not found: ${p}`);
      return value;
    }),
    write: jest.fn(async (p: string, content: string) => {
      store.set(p, content);
    }),
  };
  return adapter as unknown as VaultFileAdapter & typeof adapter;
}

describe('parseTrellaceHooksConfig', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('flattens a valid config into definitions with events', () => {
    jest.spyOn(obsidian, 'parseYaml').mockReturnValue(REAL_CONFIG as never);

    const config = parseTrellaceHooksConfig('yaml-text');

    expect(config).not.toBeNull();
    expect(config!.interpreterPlaceholder).toBe('{{PY}}');
    expect(config!.definitions).toHaveLength(4);
    expect(config!.definitions[0]).toEqual({
      event: 'SessionStart',
      matcher: '',
      command: 'cd "$CLAUDE_PROJECT_DIR" && {{PY}} hooks/session_start.py',
      timeout: 10,
    });
    const bashEntry = config!.definitions.find((d) => d.matcher === 'Bash');
    expect(bashEntry?.statusMessage).toBe('Checking for URLs/API keys...');
  });

  it('returns null when parseYaml throws', () => {
    jest.spyOn(obsidian, 'parseYaml').mockImplementation(() => {
      throw new Error('bad yaml');
    });

    expect(parseTrellaceHooksConfig('::bad::')).toBeNull();
  });

  it('returns null when the hooks block is missing', () => {
    jest.spyOn(obsidian, 'parseYaml').mockReturnValue({ schema_version: 1 } as never);

    expect(parseTrellaceHooksConfig('yaml-text')).toBeNull();
  });

  it('returns null when hooks is not an object', () => {
    jest
      .spyOn(obsidian, 'parseYaml')
      .mockReturnValue({ hooks: 'nope' } as never);

    expect(parseTrellaceHooksConfig('yaml-text')).toBeNull();
  });

  it('skips entries without a command and tolerates non-array events', () => {
    jest.spyOn(obsidian, 'parseYaml').mockReturnValue({
      hooks: {
        Stop: [{ matcher: '' }, { matcher: '', command: 'real-cmd' }],
        SessionStart: 'not-an-array',
      },
    } as never);

    const config = parseTrellaceHooksConfig('yaml-text');

    expect(config!.definitions).toEqual([
      { event: 'Stop', matcher: '', command: 'real-cmd' },
    ]);
  });

  it('defaults the placeholder to {{PY}} when not specified', () => {
    jest.spyOn(obsidian, 'parseYaml').mockReturnValue({
      hooks: { Stop: [{ command: 'x' }] },
    } as never);

    expect(parseTrellaceHooksConfig('yaml-text')!.interpreterPlaceholder).toBe('{{PY}}');
  });
});

describe('substituteInterpreter', () => {
  const defs: TrellaceHookDefinition[] = [
    {
      event: 'Stop',
      matcher: '',
      command: 'cd "$CLAUDE_PROJECT_DIR" && {{PY}} hooks/memory_capture.py',
      timeout: 30,
    },
  ];

  it('replaces the placeholder with the quoted interpreter path', () => {
    const result = substituteInterpreter(defs, '{{PY}}', '/usr/bin/python3');

    expect(result[0].command).toBe(
      'cd "$CLAUDE_PROJECT_DIR" && "/usr/bin/python3" hooks/memory_capture.py'
    );
  });

  it('converts Windows backslashes to forward slashes (hooks run under git-bash)', () => {
    const result = substituteInterpreter(
      defs,
      '{{PY}}',
      'C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python312\\python.exe'
    );

    expect(result[0].command).toContain(
      '"C:/Users/me/AppData/Local/Programs/Python/Python312/python.exe" hooks/memory_capture.py'
    );
    expect(result[0].command).not.toContain('\\');
  });

  it('replaces every occurrence and leaves commands without the placeholder unchanged', () => {
    const multi: TrellaceHookDefinition[] = [
      { event: 'Stop', matcher: '', command: '{{PY}} a.py && {{PY}} b.py' },
      { event: 'Stop', matcher: '', command: 'echo no-python-here' },
    ];

    const result = substituteInterpreter(multi, '{{PY}}', '/usr/bin/python3');

    expect(result[0].command).toBe('"/usr/bin/python3" a.py && "/usr/bin/python3" b.py');
    expect(result[1].command).toBe('echo no-python-here');
  });

  it('does not mutate the input definitions', () => {
    substituteInterpreter(defs, '{{PY}}', '/usr/bin/python3');

    expect(defs[0].command).toContain('{{PY}}');
  });
});

describe('mergeTrellaceHooks', () => {
  const stopDef: TrellaceHookDefinition = {
    event: 'Stop',
    matcher: '',
    command: 'cd "$CLAUDE_PROJECT_DIR" && "/usr/bin/python3" hooks/memory_capture.py',
    timeout: 30,
  };
  const guardrailDef: TrellaceHookDefinition = {
    event: 'PreToolUse',
    matcher: 'Bash|Write|Edit',
    command: 'cd "$CLAUDE_PROJECT_DIR" && "/usr/bin/python3" hooks/guardrail_check.py',
    timeout: 180,
    statusMessage: 'Checking...',
  };

  it('adds hooks to empty settings and preserves unrelated keys', () => {
    const settings = {
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      permissions: { allow: ['Bash(ls:*)'], deny: [], ask: [] },
      enabledPlugins: { 'foo@bar': true },
    };

    const result = mergeTrellaceHooks(settings, [stopDef, guardrailDef], {});

    expect(result.changed).toBe(true);
    expect(result.materializedCount).toBe(2);
    expect(result.settings.permissions).toEqual(settings.permissions);
    expect(result.settings.enabledPlugins).toEqual(settings.enabledPlugins);

    const hooks = result.settings.hooks as Record<string, unknown[]>;
    expect(hooks.Stop).toEqual([
      {
        matcher: '',
        hooks: [{ type: 'command', command: stopDef.command, timeout: 30 }],
      },
    ]);
    expect(hooks.PreToolUse).toEqual([
      {
        matcher: 'Bash|Write|Edit',
        hooks: [
          {
            type: 'command',
            command: guardrailDef.command,
            timeout: 180,
            statusMessage: 'Checking...',
          },
        ],
      },
    ]);
    expect(result.managed).toEqual({
      Stop: [stopDef.command],
      PreToolUse: [guardrailDef.command],
    });
  });

  it('is idempotent: re-merging the same definitions changes nothing', () => {
    const first = mergeTrellaceHooks({}, [stopDef, guardrailDef], {});
    const second = mergeTrellaceHooks(first.settings, [stopDef, guardrailDef], first.managed);

    expect(second.changed).toBe(false);
    expect(second.settings).toEqual(first.settings);
    expect(second.materializedCount).toBe(2);
  });

  it('does not duplicate an identical hand-carried hook command', () => {
    const settings = {
      hooks: {
        Stop: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: stopDef.command, timeout: 30 }],
          },
        ],
      },
    };

    const result = mergeTrellaceHooks(settings, [stopDef], {});

    expect(result.changed).toBe(false);
    const hooks = result.settings.hooks as Record<string, { hooks: unknown[] }[]>;
    expect(hooks.Stop).toHaveLength(1);
    expect(result.materializedCount).toBe(1);
    expect(result.managed).toEqual({ Stop: [stopDef.command] });
  });

  it('removes stale managed commands when the source changes', () => {
    const first = mergeTrellaceHooks({}, [stopDef], {});

    const renamedDef = { ...stopDef, command: 'new-command' };
    const second = mergeTrellaceHooks(first.settings, [renamedDef], first.managed);

    const hooks = second.settings.hooks as Record<string, { hooks: { command: string }[] }[]>;
    const allStopCommands = hooks.Stop.flatMap((m) => m.hooks.map((h) => h.command));
    expect(allStopCommands).toEqual(['new-command']);
    expect(second.changed).toBe(true);
  });

  it('removes managed hooks for events no longer in the source, keeping unmanaged ones', () => {
    const userHook = {
      matcher: '',
      hooks: [{ type: 'command', command: 'my-own-hook.sh' }],
    };
    const settings = {
      hooks: {
        Stop: [
          userHook,
          { matcher: '', hooks: [{ type: 'command', command: stopDef.command, timeout: 30 }] },
        ],
      },
    };

    const result = mergeTrellaceHooks(settings, [guardrailDef], { Stop: [stopDef.command] });

    const hooks = result.settings.hooks as Record<string, unknown[]>;
    expect(hooks.Stop).toEqual([userHook]);
    expect(hooks.PreToolUse).toBeDefined();
  });

  it('drops the event key entirely when removal empties it', () => {
    const first = mergeTrellaceHooks({}, [stopDef], {});
    const second = mergeTrellaceHooks(first.settings, [], first.managed);

    const hooks = second.settings.hooks as Record<string, unknown>;
    expect(hooks.Stop).toBeUndefined();
  });

  it('does not mutate the input settings object', () => {
    const settings: Record<string, unknown> = { permissions: { allow: [] } };
    mergeTrellaceHooks(settings, [stopDef], {});

    expect(settings.hooks).toBeUndefined();
  });
});

describe('materializeTrellaceHooks', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function spyRealConfig() {
    jest.spyOn(obsidian, 'parseYaml').mockReturnValue(REAL_CONFIG as never);
  }

  it('reports no-source and writes nothing when the yaml is absent', async () => {
    const adapter = createMemoryAdapter();

    const result = await materializeTrellaceHooks(adapter, '/usr/bin/python3');

    expect(result.status).toBe('no-source');
    expect(result.hooksMaterialized).toBe(0);
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it('reports malformed-source and writes nothing when the yaml does not parse', async () => {
    jest.spyOn(obsidian, 'parseYaml').mockImplementation(() => {
      throw new Error('bad');
    });
    const adapter = createMemoryAdapter({ [TRELLACE_HOOKS_SOURCE_PATH]: ':::' });

    const result = await materializeTrellaceHooks(adapter, '/usr/bin/python3');

    expect(result.status).toBe('malformed-source');
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it('materializes all hooks into settings.json and records state', async () => {
    spyRealConfig();
    const adapter = createMemoryAdapter({
      [TRELLACE_HOOKS_SOURCE_PATH]: 'yaml',
      [CC_SETTINGS_PATH]: JSON.stringify({
        permissions: { allow: ['Bash(ls:*)'], deny: [], ask: [] },
      }),
    });

    const result = await materializeTrellaceHooks(adapter, 'C:\\Python312\\python.exe');

    expect(result.status).toBe('ok');
    expect(result.hooksMaterialized).toBe(4);
    expect(result.pythonPath).toBe('C:\\Python312\\python.exe');

    const written = JSON.parse(adapter.store.get(CC_SETTINGS_PATH)!);
    expect(written.permissions).toEqual({ allow: ['Bash(ls:*)'], deny: [], ask: [] });
    expect(written.hooks.SessionStart[0].hooks[0].command).toBe(
      'cd "$CLAUDE_PROJECT_DIR" && "C:/Python312/python.exe" hooks/session_start.py'
    );
    expect(written.hooks.PreToolUse).toHaveLength(2);

    const state = JSON.parse(adapter.store.get(TRELLACE_HOOKS_STATE_PATH)!);
    expect(state.pythonPath).toBe('C:\\Python312\\python.exe');
    expect(state.managed.Stop).toHaveLength(1);
  });

  it('is idempotent: a second run does not rewrite settings.json', async () => {
    spyRealConfig();
    const adapter = createMemoryAdapter({ [TRELLACE_HOOKS_SOURCE_PATH]: 'yaml' });

    await materializeTrellaceHooks(adapter, '/usr/bin/python3');
    const settingsWritesAfterFirst = adapter.write.mock.calls.filter(
      (c) => c[0] === CC_SETTINGS_PATH
    ).length;

    const second = await materializeTrellaceHooks(adapter, '/usr/bin/python3');
    const settingsWritesAfterSecond = adapter.write.mock.calls.filter(
      (c) => c[0] === CC_SETTINGS_PATH
    ).length;

    expect(second.status).toBe('ok');
    expect(second.hooksMaterialized).toBe(4);
    expect(settingsWritesAfterSecond).toBe(settingsWritesAfterFirst);
  });

  it('reports no-python and leaves settings untouched when python is unresolved', async () => {
    spyRealConfig();
    const adapter = createMemoryAdapter({ [TRELLACE_HOOKS_SOURCE_PATH]: 'yaml' });

    const result = await materializeTrellaceHooks(adapter, null);

    expect(result.status).toBe('no-python');
    expect(result.hooksMaterialized).toBe(0);
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it('counts previously materialized hooks still present when python disappears', async () => {
    spyRealConfig();
    const adapter = createMemoryAdapter({ [TRELLACE_HOOKS_SOURCE_PATH]: 'yaml' });

    await materializeTrellaceHooks(adapter, '/usr/bin/python3');
    const result = await materializeTrellaceHooks(adapter, null);

    expect(result.status).toBe('no-python');
    expect(result.hooksMaterialized).toBe(4);
  });

  it('reports settings-unreadable and never overwrites a corrupt settings.json', async () => {
    spyRealConfig();
    const adapter = createMemoryAdapter({
      [TRELLACE_HOOKS_SOURCE_PATH]: 'yaml',
      [CC_SETTINGS_PATH]: '{ corrupt json',
    });

    const result = await materializeTrellaceHooks(adapter, '/usr/bin/python3');

    expect(result.status).toBe('settings-unreadable');
    expect(adapter.store.get(CC_SETTINGS_PATH)).toBe('{ corrupt json');
  });

  it('tolerates a corrupt state file by treating it as empty state', async () => {
    spyRealConfig();
    const adapter = createMemoryAdapter({
      [TRELLACE_HOOKS_SOURCE_PATH]: 'yaml',
      [TRELLACE_HOOKS_STATE_PATH]: 'not json',
    });

    const result = await materializeTrellaceHooks(adapter, '/usr/bin/python3');

    expect(result.status).toBe('ok');
    expect(result.hooksMaterialized).toBe(4);
  });
});
