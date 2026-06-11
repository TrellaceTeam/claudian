import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { MaterializeResult } from '@/core/trellace/hookMaterializer';
import { materializeTrellaceHooks } from '@/core/trellace/hookMaterializer';
import { resolvePythonPath } from '@/core/trellace/pythonResolver';
import { readTrellaceRemoteEnv } from '@/core/trellace/trellaceEnv';
import { formatTrellaceLayerStatus, initializeTrellaceLayer } from '@/core/trellace/TrellaceLayer';

jest.mock('@/core/trellace/hookMaterializer', () => {
  const actual = jest.requireActual('@/core/trellace/hookMaterializer');
  return { ...actual, materializeTrellaceHooks: jest.fn() };
});
jest.mock('@/core/trellace/pythonResolver', () => ({
  resolvePythonPath: jest.fn(),
  createDefaultPythonResolverDeps: jest.fn().mockReturnValue({
    platform: 'win32',
    env: {},
    fileExists: () => false,
    listDir: () => [],
    execText: () => null,
  }),
}));
jest.mock('@/core/trellace/trellaceEnv', () => ({
  readTrellaceRemoteEnv: jest.fn().mockReturnValue({}),
}));

const mockMaterialize = materializeTrellaceHooks as jest.MockedFunction<
  typeof materializeTrellaceHooks
>;
const mockResolvePython = resolvePythonPath as jest.MockedFunction<typeof resolvePythonPath>;
const mockReadEnv = readTrellaceRemoteEnv as jest.MockedFunction<typeof readTrellaceRemoteEnv>;

const adapter = {} as VaultFileAdapter;

function result(overrides: Partial<MaterializeResult> = {}): MaterializeResult {
  return { status: 'ok', hooksMaterialized: 4, pythonPath: '/usr/bin/python3', ...overrides };
}

describe('initializeTrellaceLayer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadEnv.mockReturnValue({});
  });

  it('resolves python and passes it to the materializer', async () => {
    mockResolvePython.mockReturnValue('/usr/bin/python3');
    mockMaterialize.mockResolvedValue(result());

    const status = await initializeTrellaceLayer(adapter);

    expect(mockMaterialize).toHaveBeenCalledWith(adapter, '/usr/bin/python3');
    expect(status.hooksMaterialized).toBe(4);
  });

  it('exposes org-pushed TRELLACE_PYTHON to the resolver', async () => {
    mockReadEnv.mockReturnValue({ TRELLACE_PYTHON: '/org/python3' });
    mockResolvePython.mockReturnValue('/org/python3');
    mockMaterialize.mockResolvedValue(result({ pythonPath: '/org/python3' }));

    await initializeTrellaceLayer(adapter);

    const deps = mockResolvePython.mock.calls[0][0]!;
    expect(deps.env.TRELLACE_PYTHON).toBe('/org/python3');
  });

  it('never throws: returns an error result when something blows up', async () => {
    mockResolvePython.mockImplementation(() => {
      throw new Error('boom');
    });

    const status = await initializeTrellaceLayer(adapter);

    expect(status.status).toBe('error');
    expect(status.hooksMaterialized).toBe(0);
  });
});

describe('formatTrellaceLayerStatus', () => {
  it('formats the happy path', () => {
    expect(formatTrellaceLayerStatus(2, result())).toBe(
      'Trellace layer: env injected yes | hooks materialized 4'
    );
  });

  it('reports env injected no when no TRELLACE_ vars are available', () => {
    expect(formatTrellaceLayerStatus(0, result())).toBe(
      'Trellace layer: env injected no | hooks materialized 4'
    );
  });

  it('appends a python suffix when the interpreter is unresolved', () => {
    expect(formatTrellaceLayerStatus(1, result({ status: 'no-python', hooksMaterialized: 0, pythonPath: null }))).toBe(
      'Trellace layer: env injected yes | hooks materialized 0 (python not found)'
    );
  });

  it('appends a source suffix when the yaml is missing', () => {
    expect(formatTrellaceLayerStatus(0, result({ status: 'no-source', hooksMaterialized: 0 }))).toBe(
      'Trellace layer: env injected no | hooks materialized 0 (args/claudian-hooks.yaml not found)'
    );
  });

  it('appends suffixes for the remaining failure modes', () => {
    expect(formatTrellaceLayerStatus(0, result({ status: 'malformed-source', hooksMaterialized: 0 }))).toContain(
      '(source yaml malformed)'
    );
    expect(formatTrellaceLayerStatus(0, result({ status: 'settings-unreadable', hooksMaterialized: 0 }))).toContain(
      '(settings.json unreadable)'
    );
    expect(formatTrellaceLayerStatus(0, result({ status: 'error', hooksMaterialized: 0 }))).toContain(
      '(materialization error)'
    );
  });
});
