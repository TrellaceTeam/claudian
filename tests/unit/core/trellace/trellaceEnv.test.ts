import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getRemoteSettingsPath, readTrellaceRemoteEnv } from '@/core/trellace/trellaceEnv';

describe('trellaceEnv', () => {
  let tempDir: string;
  let remoteSettingsPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellace-env-'));
    remoteSettingsPath = path.join(tempDir, 'remote-settings.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('getRemoteSettingsPath', () => {
    it('builds ~/.claude/remote-settings.json from a home directory', () => {
      expect(getRemoteSettingsPath('/home/user')).toBe(
        path.join('/home/user', '.claude', 'remote-settings.json')
      );
    });

    it('defaults to the OS home directory', () => {
      expect(getRemoteSettingsPath()).toBe(
        path.join(os.homedir(), '.claude', 'remote-settings.json')
      );
    });
  });

  describe('readTrellaceRemoteEnv', () => {
    it('returns empty object when the file does not exist', () => {
      expect(readTrellaceRemoteEnv(remoteSettingsPath)).toEqual({});
    });

    it('returns empty object on malformed JSON', () => {
      fs.writeFileSync(remoteSettingsPath, '{ not json');
      expect(readTrellaceRemoteEnv(remoteSettingsPath)).toEqual({});
    });

    it('returns empty object when there is no env block', () => {
      fs.writeFileSync(remoteSettingsPath, JSON.stringify({ permissions: {} }));
      expect(readTrellaceRemoteEnv(remoteSettingsPath)).toEqual({});
    });

    it('returns empty object when env block is not an object', () => {
      fs.writeFileSync(remoteSettingsPath, JSON.stringify({ env: ['not', 'a', 'map'] }));
      expect(readTrellaceRemoteEnv(remoteSettingsPath)).toEqual({});
    });

    it('returns only TRELLACE_-prefixed variables', () => {
      fs.writeFileSync(
        remoteSettingsPath,
        JSON.stringify({
          env: {
            TRELLACE_ANTHROPIC_API_KEY: 'sk-test',
            TRELLACE_PROBE: 'on',
            ANTHROPIC_API_KEY: 'must-not-leak',
            OTHER_VAR: 'nope',
          },
        })
      );

      expect(readTrellaceRemoteEnv(remoteSettingsPath)).toEqual({
        TRELLACE_ANTHROPIC_API_KEY: 'sk-test',
        TRELLACE_PROBE: 'on',
      });
    });

    it('skips TRELLACE_ variables whose values are not strings', () => {
      fs.writeFileSync(
        remoteSettingsPath,
        JSON.stringify({
          env: {
            TRELLACE_GOOD: 'yes',
            TRELLACE_NUMBER: 42,
            TRELLACE_OBJECT: { nested: true },
          },
        })
      );

      expect(readTrellaceRemoteEnv(remoteSettingsPath)).toEqual({ TRELLACE_GOOD: 'yes' });
    });

    it('requires the prefix to match exactly (case-sensitive)', () => {
      fs.writeFileSync(
        remoteSettingsPath,
        JSON.stringify({ env: { trellace_lower: 'no', TRELLACE_OK: 'yes' } })
      );

      expect(readTrellaceRemoteEnv(remoteSettingsPath)).toEqual({ TRELLACE_OK: 'yes' });
    });
  });
});
