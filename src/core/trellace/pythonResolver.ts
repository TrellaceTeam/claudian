/**
 * Absolute python interpreter resolution for Trellace hook materialization.
 *
 * Hook commands run with the CLI's env plus the Obsidian GUI environment,
 * where a bare `python3` often does not resolve (Windows team machines
 * especially). The materializer therefore substitutes {{PY}} with an
 * absolute path resolved here, per machine.
 *
 * Resolution order:
 * 1. TRELLACE_PYTHON env override (process env or org-pushed remote var),
 *    honored only if the path exists. This is the per-machine escape hatch.
 * 2. Windows: the py launcher (%SystemRoot%\py.exe, then bare `py`) asked
 *    for sys.executable of the default Python 3.
 * 3. Windows: scan known install roots (%LOCALAPPDATA%\Programs\Python,
 *    %ProgramFiles%, %ProgramFiles(x86)%, C:\) for Python3* directories and
 *    pick the highest version that contains python.exe. The WindowsApps
 *    Store stub is never considered (it is not in any scanned root).
 * 4. POSIX: fixed candidates /opt/homebrew/bin/python3,
 *    /usr/local/bin/python3, /usr/bin/python3; then `command -v python3`
 *    through /bin/sh as a login-ish fallback.
 * Returns null when nothing resolves; the materializer then leaves
 * settings.json untouched rather than writing a broken command.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';

export interface PythonResolverDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  fileExists: (p: string) => boolean;
  /** Directory entries, [] on any error. */
  listDir: (p: string) => string[];
  /** Trimmed stdout of a command, null on any error. */
  execText: (file: string, args: string[]) => string | null;
}

const EXEC_TIMEOUT_MS = 5_000;

function defaultExecText(file: string, args: string[]): string | null {
  try {
    const out = execFileSync(file, args, {
      timeout: EXEC_TIMEOUT_MS,
      encoding: 'utf-8',
      windowsHide: true,
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function defaultListDir(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

export function createDefaultPythonResolverDeps(): PythonResolverDeps {
  return {
    platform: process.platform,
    env: process.env,
    fileExists: (p) => {
      try {
        return fs.existsSync(p) && fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    listDir: defaultListDir,
    execText: defaultExecText,
  };
}

const PY_LAUNCHER_ARGS = ['-3', '-c', 'import sys; print(sys.executable)'];

function resolveViaPyLauncher(deps: PythonResolverDeps): string | null {
  const systemRoot = deps.env.SystemRoot || deps.env.windir;
  const launchers = systemRoot ? [`${systemRoot}\\py.exe`, 'py'] : ['py'];

  for (const launcher of launchers) {
    const reported = deps.execText(launcher, PY_LAUNCHER_ARGS);
    if (reported && deps.fileExists(reported)) {
      return reported;
    }
  }
  return null;
}

function pythonDirVersion(name: string): number | null {
  const match = name.match(/^Python(3\d*)$/i);
  return match ? parseInt(match[1], 10) : null;
}

function resolveViaWindowsScan(deps: PythonResolverDeps): string | null {
  const roots = [
    deps.env.LOCALAPPDATA ? `${deps.env.LOCALAPPDATA}\\Programs\\Python` : null,
    deps.env.ProgramFiles || null,
    deps.env['ProgramFiles(x86)'] || null,
    'C:\\',
  ].filter((r): r is string => !!r);

  let best: { version: number; path: string } | null = null;
  for (const root of roots) {
    for (const entry of deps.listDir(root)) {
      const version = pythonDirVersion(entry);
      if (version === null) continue;

      const candidate = `${root.replace(/\\$/, '')}\\${entry}\\python.exe`;
      if (!deps.fileExists(candidate)) continue;

      if (!best || version > best.version) {
        best = { version, path: candidate };
      }
    }
  }
  return best?.path ?? null;
}

const POSIX_CANDIDATES = [
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3',
  '/usr/bin/python3',
];

function resolveViaPosix(deps: PythonResolverDeps): string | null {
  for (const candidate of POSIX_CANDIDATES) {
    if (deps.fileExists(candidate)) return candidate;
  }

  const found = deps.execText('/bin/sh', ['-c', 'command -v python3']);
  if (found && deps.fileExists(found)) return found;

  return null;
}

export function resolvePythonPath(
  deps: PythonResolverDeps = createDefaultPythonResolverDeps()
): string | null {
  // An override pointing at a missing file is ignored (auto-detection
  // continues) so one bad org-pushed path cannot kill hooks on a machine
  // where detection would have worked.
  const override = deps.env.TRELLACE_PYTHON;
  if (override && deps.fileExists(override)) {
    return override;
  }

  if (deps.platform === 'win32') {
    return resolveViaPyLauncher(deps) ?? resolveViaWindowsScan(deps);
  }

  return resolveViaPosix(deps);
}
