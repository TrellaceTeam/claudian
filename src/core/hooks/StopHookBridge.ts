/**
 * Stop Hook Bridge
 *
 * Re-executes project-level Stop hooks defined in .claude/settings.local.json.
 * Claudian's SDK sessions never load the local settings tier
 * (settingSources is ['user','project']), so Stop hooks defined there would
 * silently never run without this bridge.
 *
 * Deliberately does NOT bridge .claude/settings.json: the project tier IS
 * loaded, so the CLI executes those Stop hooks natively. Bridging them too
 * would run each one twice per Stop. This matters since the Trellace layer
 * materializes team Stop hooks into settings.json at plugin load.
 */

import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface StopHookExecOptions {
  cwd: string;
  timeoutMs: number;
  env: Record<string, string | undefined>;
}

export type StopHookExec = (
  command: string,
  options: StopHookExecOptions,
  payload: string
) => Promise<void>;

export interface StopHookBridgeContext {
  getVaultPath: () => string | null;
  /** Injectable for tests; defaults to child_process.exec with stdin payload. */
  execCommand?: StopHookExec;
}

const defaultExec: StopHookExec = (command, options, payload) =>
  new Promise<void>((resolve) => {
    const proc = exec(
      command,
      { cwd: options.cwd, timeout: options.timeoutMs, env: options.env },
      () => resolve()
    );
    if (proc.stdin) {
      proc.stdin.write(payload);
      proc.stdin.end();
    }
  });

/** Settings files whose Stop hooks the bridge executes. Local tier only. */
const BRIDGED_SETTINGS_FILES = ['settings.local.json'];

export function createStopHookBridge(context: StopHookBridgeContext): HookCallbackMatcher {
  const execCommand = context.execCommand ?? defaultExec;

  return {
    hooks: [
      async (input) => {
        const hookInput = input as {
          hook_event_name: string;
          session_id: string;
          transcript_path: string;
          cwd: string;
          permission_mode?: string;
          stop_hook_active: boolean;
          last_assistant_message?: string;
        };

        const vaultPath = context.getVaultPath();
        if (!vaultPath) return { continue: true };

        for (const fileName of BRIDGED_SETTINGS_FILES) {
          const settingsFile = path.join(vaultPath, '.claude', fileName);
          try {
            if (!fs.existsSync(settingsFile)) continue;
            const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
            const stopHooks = settings?.hooks?.Stop;
            if (!Array.isArray(stopHooks)) continue;

            for (const hookDef of stopHooks) {
              const hooks = hookDef?.hooks;
              if (!Array.isArray(hooks)) continue;

              for (const h of hooks) {
                if (h?.type !== 'command' || !h?.command) continue;

                const payload = JSON.stringify({
                  session_id: hookInput.session_id,
                  transcript_path: hookInput.transcript_path,
                  cwd: hookInput.cwd,
                  permission_mode: hookInput.permission_mode,
                  hook_event_name: 'Stop',
                  stop_hook_active: hookInput.stop_hook_active,
                  last_assistant_message: hookInput.last_assistant_message || '',
                });

                const cmd = (h.command as string).replace(/\$CLAUDE_PROJECT_DIR/g, vaultPath);
                const timeoutMs = (h.timeout || 30) * 1000;

                try {
                  await execCommand(
                    cmd,
                    {
                      cwd: vaultPath,
                      timeoutMs,
                      env: { ...process.env, CLAUDE_PROJECT_DIR: vaultPath },
                    },
                    payload
                  );
                } catch {
                  // Hook errors must never break the conversation
                }
              }
            }
          } catch {
            // Settings parse errors are non-fatal
          }
        }

        return { continue: true };
      },
    ],
  };
}
