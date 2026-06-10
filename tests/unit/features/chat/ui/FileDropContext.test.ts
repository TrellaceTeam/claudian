import { createMockEl } from '@test/helpers/mockElement';
import { Notice } from 'obsidian';

import {
  buildFileDropMessage,
  DROP_ZONE_DIR,
  FILE_DROP_MESSAGE_SINGLE,
  FileDropContextManager,
  isImageContextFile,
  resolveCollisionFreePath,
} from '@/features/chat/ui/FileDropContext';

jest.mock('obsidian', () => ({
  Notice: jest.fn(),
}));

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

function createMockFile(name: string, type: string): any {
  return {
    name,
    type,
    arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(4)),
  };
}

function createDropEvent(files: any[]): any {
  const fileList: any = { length: files.length };
  files.forEach((f, i) => {
    fileList[i] = f;
  });
  return {
    dataTransfer: { files: fileList },
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
  };
}

function createMockApp(existingPaths: Set<string> = new Set()): any {
  return {
    vault: {
      adapter: {
        exists: jest.fn(async (p: string) => existingPaths.has(p)),
        mkdir: jest.fn(async (p: string) => {
          existingPaths.add(p);
        }),
        writeBinary: jest.fn(async (p: string) => {
          existingPaths.add(p);
        }),
      },
    },
  };
}

describe('isImageContextFile (image/non-image split)', () => {
  it('treats supported image types as ImageContext files', () => {
    expect(isImageContextFile({ name: 'photo.png', type: 'image/png' })).toBe(true);
    expect(isImageContextFile({ name: 'photo.JPG', type: 'image/jpeg' })).toBe(true);
    expect(isImageContextFile({ name: 'anim.gif', type: 'image/gif' })).toBe(true);
    expect(isImageContextFile({ name: 'pic.webp', type: 'image/webp' })).toBe(true);
  });

  it('routes non-image files to the drop zone', () => {
    expect(isImageContextFile({ name: 'report.pdf', type: 'application/pdf' })).toBe(false);
    expect(isImageContextFile({ name: 'notes.md', type: 'text/markdown' })).toBe(false);
    expect(isImageContextFile({ name: 'deck.pptx', type: '' })).toBe(false);
  });

  it('routes image formats ImageContext does not support to the drop zone', () => {
    // ImageContext requires both an image/ MIME type and a supported extension
    expect(isImageContextFile({ name: 'logo.svg', type: 'image/svg+xml' })).toBe(false);
    expect(isImageContextFile({ name: 'scan.tiff', type: 'image/tiff' })).toBe(false);
  });

  it('requires the MIME type to be image/, not just the extension', () => {
    expect(isImageContextFile({ name: 'fake.png', type: 'application/octet-stream' })).toBe(false);
  });
});

describe('buildFileDropMessage (message template)', () => {
  it('builds the single-file message with the vault path inlined', () => {
    const msg = buildFileDropMessage(['context/drop-zone/report.pdf']);
    expect(msg).toBe(
      'I just dropped "context/drop-zone/report.pdf" into the vault. ' +
        'Use the file-router skill flow: read it, classify it (client + content type), ' +
        'propose the destination, and file it after I confirm. ' +
        'If it is binary, route it per the Drive policy.'
    );
    expect(FILE_DROP_MESSAGE_SINGLE).toContain('{path}');
  });

  it('builds one message listing all paths for multiple files', () => {
    const msg = buildFileDropMessage([
      'context/drop-zone/a.pdf',
      'context/drop-zone/b.docx',
    ]);
    expect(msg).toContain('- context/drop-zone/a.pdf');
    expect(msg).toContain('- context/drop-zone/b.docx');
    expect(msg).toContain('read each one');
    expect(msg).toContain('file-router');
  });
});

describe('resolveCollisionFreePath (collision-safe naming)', () => {
  const now = () => 1718000000000;

  it('returns the direct path when there is no collision', async () => {
    const exists = jest.fn(async () => false);
    const result = await resolveCollisionFreePath(DROP_ZONE_DIR, 'report.pdf', exists, now);
    expect(result).toBe('context/drop-zone/report.pdf');
  });

  it('appends a timestamp suffix before the extension on collision', async () => {
    const taken = new Set(['context/drop-zone/report.pdf']);
    const exists = async (p: string) => taken.has(p);
    const result = await resolveCollisionFreePath(DROP_ZONE_DIR, 'report.pdf', exists, now);
    expect(result).toBe('context/drop-zone/report-1718000000000.pdf');
  });

  it('adds a counter when the timestamped name also collides', async () => {
    const taken = new Set([
      'context/drop-zone/report.pdf',
      'context/drop-zone/report-1718000000000.pdf',
      'context/drop-zone/report-1718000000000-2.pdf',
    ]);
    const exists = async (p: string) => taken.has(p);
    const result = await resolveCollisionFreePath(DROP_ZONE_DIR, 'report.pdf', exists, now);
    expect(result).toBe('context/drop-zone/report-1718000000000-3.pdf');
  });

  it('handles extensionless filenames', async () => {
    const taken = new Set(['context/drop-zone/Makefile']);
    const exists = async (p: string) => taken.has(p);
    const result = await resolveCollisionFreePath(DROP_ZONE_DIR, 'Makefile', exists, now);
    expect(result).toBe('context/drop-zone/Makefile-1718000000000');
  });

  it('strips path separators and falls back to a generated name when empty', async () => {
    const exists = async () => false;
    expect(await resolveCollisionFreePath(DROP_ZONE_DIR, '../../evil.pdf', exists, now)).toBe(
      'context/drop-zone/evil.pdf'
    );
    expect(await resolveCollisionFreePath(DROP_ZONE_DIR, '', exists, now)).toBe(
      'context/drop-zone/dropped-file-1718000000000'
    );
  });
});

describe('FileDropContextManager', () => {
  let app: any;
  let sendMessage: jest.Mock;
  let manager: FileDropContextManager;
  let dropZoneEl: any;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createMockApp();
    sendMessage = jest.fn().mockResolvedValue(undefined);
    manager = new FileDropContextManager(app, { sendMessage });
    dropZoneEl = createMockEl();
    manager.attach(dropZoneEl);
  });

  it('saves a non-image file to the drop zone and auto-sends the routing message', async () => {
    const event = createDropEvent([createMockFile('report.pdf', 'application/pdf')]);
    dropZoneEl.dispatchEvent('drop', event);
    await flushPromises();

    expect(app.vault.adapter.writeBinary).toHaveBeenCalledTimes(1);
    expect(app.vault.adapter.writeBinary).toHaveBeenCalledWith(
      'context/drop-zone/report.pdf',
      expect.any(ArrayBuffer)
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      buildFileDropMessage(['context/drop-zone/report.pdf'])
    );
    expect(Notice).toHaveBeenCalledWith('Saved to drop-zone: report.pdf');
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('skips image files entirely (they belong to ImageContextManager)', async () => {
    const event = createDropEvent([createMockFile('photo.png', 'image/png')]);
    dropZoneEl.dispatchEvent('drop', event);
    await flushPromises();

    expect(app.vault.adapter.writeBinary).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(Notice).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('handles mixed drops: images skipped, non-images saved, ONE message sent', async () => {
    const event = createDropEvent([
      createMockFile('photo.png', 'image/png'),
      createMockFile('report.pdf', 'application/pdf'),
      createMockFile('notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ]);
    dropZoneEl.dispatchEvent('drop', event);
    await flushPromises();

    expect(app.vault.adapter.writeBinary).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const message = sendMessage.mock.calls[0][0];
    expect(message).toContain('- context/drop-zone/report.pdf');
    expect(message).toContain('- context/drop-zone/notes.docx');
    expect(message).not.toContain('photo.png');
    expect(Notice).toHaveBeenCalledTimes(2);
  });

  it('uses collision-safe naming when the file already exists in the drop zone', async () => {
    app = createMockApp(new Set(['context', 'context/drop-zone', 'context/drop-zone/report.pdf']));
    manager = new FileDropContextManager(app, { sendMessage });
    dropZoneEl = createMockEl();
    manager.attach(dropZoneEl);

    const event = createDropEvent([createMockFile('report.pdf', 'application/pdf')]);
    dropZoneEl.dispatchEvent('drop', event);
    await flushPromises();

    const writtenPath = app.vault.adapter.writeBinary.mock.calls[0][0];
    expect(writtenPath).toMatch(/^context\/drop-zone\/report-\d+\.pdf$/);
    expect(sendMessage).toHaveBeenCalledWith(buildFileDropMessage([writtenPath]));
  });

  it('creates the drop zone folder when it does not exist', async () => {
    const event = createDropEvent([createMockFile('report.pdf', 'application/pdf')]);
    dropZoneEl.dispatchEvent('drop', event);
    await flushPromises();

    expect(app.vault.adapter.mkdir).toHaveBeenCalledWith('context');
    expect(app.vault.adapter.mkdir).toHaveBeenCalledWith('context/drop-zone');
  });

  it('still sends the message for files that saved when one file fails', async () => {
    app.vault.adapter.writeBinary
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined);

    const event = createDropEvent([
      createMockFile('bad.pdf', 'application/pdf'),
      createMockFile('good.pdf', 'application/pdf'),
    ]);
    dropZoneEl.dispatchEvent('drop', event);
    await flushPromises();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      buildFileDropMessage(['context/drop-zone/good.pdf'])
    );
    expect(Notice).toHaveBeenCalledWith('Failed to save "bad.pdf" to drop-zone (disk full)');
  });

  it('does nothing when no files are present on the event', async () => {
    dropZoneEl.dispatchEvent('drop', { dataTransfer: null, preventDefault: jest.fn(), stopPropagation: jest.fn() });
    await flushPromises();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
