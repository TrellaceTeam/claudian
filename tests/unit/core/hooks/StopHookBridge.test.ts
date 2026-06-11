import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { StopHookExecOptions } from '@/core/hooks/StopHookBridge';
import { createStopHookBridge } from '@/core/hooks/StopHookBridge';

interface RecordedExec {
  command: string;
  options: StopHookExecOptions;
  payload: string;
}

function createRecordingExec() {
  const calls: RecordedExec[] = [];
  const exec = async (command: string, options: StopHookExecOptions, payload: string) => {
    calls.push({ command, options, payload });
  };
  return { calls, exec };
}

const HOOK_INPUT = {
  hook_event_name: 'Stop',
  session_id: 'session-1',
  transcript_path: '/transcripts/session-1.jsonl',
  cwd: '/vault',
  permission_mode: 'bypassPermissions',
  stop_hook_active: false,
  last_assistant_message: 'done',
};

function writeSettings(vaultPath: string, fileName: string, content: unknown): void {
  const claudeDir = path.join(vaultPath, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, fileName), JSON.stringify(content));
}

function stopHooksSettings(command: string, timeout?: number) {
  return {
    hooks: {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command, ...(timeout ? { timeout } : {}) }] }],
    },
  };
}

async function runBridge(
  vaultPath: string | null,
  exec: (command: string, options: StopHookExecOptions, payload: string) => Promise<void>
) {
  const matcher = createStopHookBridge({ getVaultPath: () => vaultPath, execCommand: exec });
  return matcher.hooks[0](HOOK_INPUT as never, undefined, { signal: new AbortController().signal });
}

describe('createStopHookBridge', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-bridge-'));
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('executes Stop hook commands from settings.local.json', async () => {
    writeSettings(vaultPath, 'settings.local.json', stopHooksSettings('echo local-hook', 5));
    const { calls, exec } = createRecordingExec();

    const result = await runBridge(vaultPath, exec);

    expect(result).toEqual({ continue: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('echo local-hook');
    expect(calls[0].options.cwd).toBe(vaultPath);
    expect(calls[0].options.timeoutMs).toBe(5000);
    expect(calls[0].options.env.CLAUDE_PROJECT_DIR).toBe(vaultPath);
  });

  it('substitutes $CLAUDE_PROJECT_DIR in the command text', async () => {
    writeSettings(
      vaultPath,
      'settings.local.json',
      stopHooksSettings('cd "$CLAUDE_PROJECT_DIR" && echo hi')
    );
    const { calls, exec } = createRecordingExec();

    await runBridge(vaultPath, exec);

    expect(calls[0].command).toBe(`cd "${vaultPath}" && echo hi`);
  });

  it('passes the Stop payload on stdin with the session fields', async () => {
    writeSettings(vaultPath, 'settings.local.json', stopHooksSettings('echo x'));
    const { calls, exec } = createRecordingExec();

    await runBridge(vaultPath, exec);

    const payload = JSON.parse(calls[0].payload);
    expect(payload.hook_event_name).toBe('Stop');
    expect(payload.session_id).toBe('session-1');
    expect(payload.transcript_path).toBe('/transcripts/session-1.jsonl');
    expect(payload.last_assistant_message).toBe('done');
  });

  it('does NOT execute Stop hooks from settings.json (CLI runs those natively)', async () => {
    writeSettings(vaultPath, 'settings.json', stopHooksSettings('echo project-hook'));
    const { calls, exec } = createRecordingExec();

    const result = await runBridge(vaultPath, exec);

    expect(result).toEqual({ continue: true });
    expect(calls).toHaveLength(0);
  });

  it('only bridges the local file when both files define Stop hooks', async () => {
    writeSettings(vaultPath, 'settings.local.json', stopHooksSettings('echo local-hook'));
    writeSettings(vaultPath, 'settings.json', stopHooksSettings('echo project-hook'));
    const { calls, exec } = createRecordingExec();

    await runBridge(vaultPath, exec);

    expect(calls.map((c) => c.command)).toEqual(['echo local-hook']);
  });

  it('does nothing without a vault path', async () => {
    const { calls, exec } = createRecordingExec();

    const result = await runBridge(null, exec);

    expect(result).toEqual({ continue: true });
    expect(calls).toHaveLength(0);
  });

  it('tolerates malformed settings.local.json', async () => {
    const claudeDir = path.join(vaultPath, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.local.json'), '{ bad json');
    const { calls, exec } = createRecordingExec();

    const result = await runBridge(vaultPath, exec);

    expect(result).toEqual({ continue: true });
    expect(calls).toHaveLength(0);
  });

  it('skips non-command hook entries', async () => {
    writeSettings(vaultPath, 'settings.local.json', {
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'other', command: 'echo nope' }, { type: 'command' }] }] },
    });
    const { calls, exec } = createRecordingExec();

    await runBridge(vaultPath, exec);

    expect(calls).toHaveLength(0);
  });

  it('keeps the conversation alive when the exec function throws', async () => {
    writeSettings(vaultPath, 'settings.local.json', stopHooksSettings('echo boom'));
    const exec = async () => {
      throw new Error('exec failed');
    };

    const result = await runBridge(vaultPath, exec);

    expect(result).toEqual({ continue: true });
  });
});
