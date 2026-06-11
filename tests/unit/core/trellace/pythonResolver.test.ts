import type { PythonResolverDeps } from '@/core/trellace/pythonResolver';
import { resolvePythonPath } from '@/core/trellace/pythonResolver';

function createDeps(overrides: Partial<PythonResolverDeps> = {}): PythonResolverDeps {
  return {
    platform: 'win32',
    env: {},
    fileExists: () => false,
    listDir: () => [],
    execText: () => null,
    ...overrides,
  };
}

describe('resolvePythonPath', () => {
  describe('TRELLACE_PYTHON override', () => {
    it('uses TRELLACE_PYTHON when the file exists', () => {
      const deps = createDeps({
        env: { TRELLACE_PYTHON: 'D:\\tools\\python\\python.exe' },
        fileExists: (p) => p === 'D:\\tools\\python\\python.exe',
      });

      expect(resolvePythonPath(deps)).toBe('D:\\tools\\python\\python.exe');
    });

    it('ignores TRELLACE_PYTHON when the file does not exist', () => {
      const deps = createDeps({
        env: { TRELLACE_PYTHON: 'D:\\missing\\python.exe' },
      });

      expect(resolvePythonPath(deps)).toBeNull();
    });

    it('falls through to auto-detection when TRELLACE_PYTHON is missing on disk', () => {
      const deps = createDeps({
        platform: 'win32',
        env: { TRELLACE_PYTHON: 'D:\\missing\\python.exe', SystemRoot: 'C:\\Windows' },
        execText: (file) =>
          file === 'C:\\Windows\\py.exe' ? 'C:\\Python312\\python.exe' : null,
        fileExists: (p) => p === 'C:\\Windows\\py.exe' || p === 'C:\\Python312\\python.exe',
      });

      expect(resolvePythonPath(deps)).toBe('C:\\Python312\\python.exe');
    });
  });

  describe('on Windows', () => {
    it('uses the py launcher result when the reported path exists', () => {
      const deps = createDeps({
        platform: 'win32',
        env: { SystemRoot: 'C:\\Windows' },
        execText: (file, args) =>
          file === 'C:\\Windows\\py.exe' && args[0] === '-3'
            ? 'C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python312\\python.exe'
            : null,
        fileExists: (p) =>
          p === 'C:\\Windows\\py.exe' ||
          p === 'C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
      });

      expect(resolvePythonPath(deps)).toBe(
        'C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python312\\python.exe'
      );
    });

    it('falls back to scanning install roots when the launcher fails', () => {
      const localAppData = 'C:\\Users\\me\\AppData\\Local';
      const pythonDir = `${localAppData}\\Programs\\Python`;
      const expected = `${pythonDir}\\Python313\\python.exe`;

      const deps = createDeps({
        platform: 'win32',
        env: { LOCALAPPDATA: localAppData },
        listDir: (p) => (p === pythonDir ? ['Python39', 'Python313', 'Launcher'] : []),
        fileExists: (p) => p === expected || p === `${pythonDir}\\Python39\\python.exe`,
      });

      expect(resolvePythonPath(deps)).toBe(expected);
    });

    it('picks the highest version across install roots', () => {
      const localAppData = 'C:\\Users\\me\\AppData\\Local';
      const userDir = `${localAppData}\\Programs\\Python`;
      const programFiles = 'C:\\Program Files';

      const deps = createDeps({
        platform: 'win32',
        env: { LOCALAPPDATA: localAppData, ProgramFiles: programFiles },
        listDir: (p) => {
          if (p === userDir) return ['Python310'];
          if (p === programFiles) return ['Python312', 'Git'];
          return [];
        },
        fileExists: (p) =>
          p === `${userDir}\\Python310\\python.exe` ||
          p === `${programFiles}\\Python312\\python.exe`,
      });

      expect(resolvePythonPath(deps)).toBe(`${programFiles}\\Python312\\python.exe`);
    });

    it('returns null when nothing resolves', () => {
      expect(resolvePythonPath(createDeps({ platform: 'win32' }))).toBeNull();
    });
  });

  describe('on POSIX', () => {
    it('prefers the first existing fixed candidate', () => {
      const deps = createDeps({
        platform: 'darwin',
        fileExists: (p) => p === '/opt/homebrew/bin/python3' || p === '/usr/bin/python3',
      });

      expect(resolvePythonPath(deps)).toBe('/opt/homebrew/bin/python3');
    });

    it('falls back to command -v python3 when fixed candidates are missing', () => {
      const deps = createDeps({
        platform: 'linux',
        execText: (file, args) =>
          file === '/bin/sh' && args.join(' ').includes('command -v python3')
            ? '/custom/bin/python3'
            : null,
        fileExists: (p) => p === '/custom/bin/python3',
      });

      expect(resolvePythonPath(deps)).toBe('/custom/bin/python3');
    });

    it('returns null when nothing resolves', () => {
      expect(resolvePythonPath(createDeps({ platform: 'linux' }))).toBeNull();
    });
  });
});
