import type { App } from 'obsidian';
import { Notice } from 'obsidian';
import * as path from 'path';

/** Vault folder where dropped files are staged for routing. */
export const DROP_ZONE_DIR = 'context/drop-zone';

/**
 * Message sent to Claude after a single file is dropped.
 * `{path}` is replaced with the vault-relative path of the saved file.
 */
export const FILE_DROP_MESSAGE_SINGLE =
  'I just dropped "{path}" into the vault. Use the file-router skill flow: ' +
  'read it, classify it (client + content type), propose the destination, ' +
  'and file it after I confirm. If it is binary, route it per the Drive policy.';

/**
 * Message sent to Claude after multiple files are dropped in one gesture.
 * `{paths}` is replaced with a bulleted list of vault-relative paths.
 */
export const FILE_DROP_MESSAGE_MULTI =
  'I just dropped these files into the vault:\n{paths}\n' +
  'Use the file-router skill flow: read each one, classify it (client + content type), ' +
  'propose the destination, and file it after I confirm. ' +
  'If any of them is binary, route it per the Drive policy.';

/** Builds the auto-sent routing message for one or more saved vault paths. */
export function buildFileDropMessage(savedPaths: string[]): string {
  if (savedPaths.length === 1) {
    return FILE_DROP_MESSAGE_SINGLE.replace('{path}', savedPaths[0]);
  }
  const list = savedPaths.map((p) => `- ${p}`).join('\n');
  return FILE_DROP_MESSAGE_MULTI.replace('{paths}', list);
}

/**
 * Image extensions handled by ImageContextManager.
 * Kept in sync with IMAGE_EXTENSIONS in ImageContext.ts: a file counts as an
 * image (and is left to ImageContextManager) only when its MIME type starts
 * with image/ AND its extension is in this set. Anything else (including
 * unsupported image formats like .svg) is routed to the drop zone.
 */
const IMAGE_CONTEXT_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/** Minimal shape of a dropped file used for the image/non-image decision. */
export interface DroppedFileLike {
  name: string;
  type: string;
}

/** True when the file is one ImageContextManager will attach (so we skip it). */
export function isImageContextFile(file: DroppedFileLike): boolean {
  if (!file.type.startsWith('image/')) return false;
  const ext = path.extname(file.name || '').toLowerCase();
  return IMAGE_CONTEXT_EXTENSIONS.has(ext);
}

/**
 * Resolves a collision-free vault path for a filename inside a directory.
 * When the target already exists, a timestamp suffix is appended before the
 * extension; if that also exists, a counter is added.
 */
export async function resolveCollisionFreePath(
  dir: string,
  filename: string,
  exists: (p: string) => Promise<boolean>,
  now: () => number = Date.now
): Promise<string> {
  const safeName = sanitizeFilename(filename, now);
  const direct = `${dir}/${safeName}`;
  if (!(await exists(direct))) return direct;

  const ext = path.extname(safeName);
  const base = safeName.slice(0, safeName.length - ext.length);
  const stamped = `${dir}/${base}-${now()}${ext}`;
  if (!(await exists(stamped))) return stamped;

  let counter = 2;
  let candidate = `${dir}/${base}-${now()}-${counter}${ext}`;
  while (await exists(candidate)) {
    counter += 1;
    candidate = `${dir}/${base}-${now()}-${counter}${ext}`;
  }
  return candidate;
}

/** Strips path separators and falls back to a generated name when empty. */
function sanitizeFilename(filename: string, now: () => number): string {
  const trimmed = (filename || '').split(/[\\/]/).pop()?.trim() ?? '';
  return trimmed || `dropped-file-${now()}`;
}

export interface FileDropCallbacks {
  /** Sends a user message through the normal chat send path. */
  sendMessage: (content: string) => void | Promise<void>;
}

/**
 * Handles non-image files dropped on the chat input.
 *
 * Images are intentionally ignored here: ImageContextManager attaches its own
 * drop handler on the same element (registered first) and keeps handling them
 * exactly as before. Every other file is saved to the vault drop zone
 * (context/drop-zone/) with collision-safe naming, then a single routing
 * message is auto-sent so Claude runs the file-router flow.
 */
export class FileDropContextManager {
  private app: App;
  private callbacks: FileDropCallbacks;

  constructor(app: App, callbacks: FileDropCallbacks) {
    this.app = app;
    this.callbacks = callbacks;
  }

  /** Attaches the drop handler. Call after ImageContextManager is wired. */
  attach(dropZoneEl: HTMLElement): void {
    dropZoneEl.addEventListener('drop', (e) => {
      void this.handleDrop(e as DragEvent);
    });
  }

  private async handleDrop(e: DragEvent): Promise<void> {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const nonImageFiles: File[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!isImageContextFile(file)) {
        nonImageFiles.push(file);
      }
    }
    if (nonImageFiles.length === 0) return;

    // ImageContextManager's handler already calls preventDefault for file
    // drops; repeat it here defensively so non-image drops never fall through
    // to Obsidian's default link-insertion behavior.
    e.preventDefault();
    e.stopPropagation();

    const savedPaths: string[] = [];
    for (const file of nonImageFiles) {
      try {
        const savedPath = await this.saveToDropZone(file);
        savedPaths.push(savedPath);
        new Notice(`Saved to drop-zone: ${savedPath.slice(DROP_ZONE_DIR.length + 1)}`);
      } catch (error) {
        const detail = error instanceof Error ? ` (${error.message})` : '';
        new Notice(`Failed to save "${file.name}" to drop-zone${detail}`);
      }
    }

    if (savedPaths.length > 0) {
      await this.callbacks.sendMessage(buildFileDropMessage(savedPaths));
    }
  }

  private async saveToDropZone(file: File): Promise<string> {
    const adapter = this.app.vault.adapter;
    await this.ensureFolder(DROP_ZONE_DIR);
    const targetPath = await resolveCollisionFreePath(
      DROP_ZONE_DIR,
      file.name,
      (p) => adapter.exists(p)
    );
    const data = await file.arrayBuffer();
    await adapter.writeBinary(targetPath, data);
    return targetPath;
  }

  /** Creates the folder (and parents) if missing. Mirrors VaultFileAdapter.ensureFolder. */
  private async ensureFolder(folderPath: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(folderPath)) return;
    const parts = folderPath.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await adapter.exists(current))) {
        await adapter.mkdir(current);
      }
    }
  }
}
