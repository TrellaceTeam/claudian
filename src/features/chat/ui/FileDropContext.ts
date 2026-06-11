import type { App } from 'obsidian';
import { Notice } from 'obsidian';
import * as path from 'path';

/** Vault folder where dropped files are staged for routing. */
export const DROP_ZONE_DIR = 'context/drop-zone';

/** Notice shown when a folder is dropped (folders are not supported). */
export const FOLDER_DROP_NOTICE = 'Folders are not supported. Drop individual files.';

/**
 * Routing message sent when the user presses Enter with staged files and an
 * empty input. `{path}` is replaced with the vault-relative path.
 */
export const FILE_DROP_MESSAGE_SINGLE =
  'I just dropped "{path}" into the vault. Use the file-router skill flow: ' +
  'read it, classify it (client + content type), propose the destination, ' +
  'and file it after I confirm. If it is binary, route it per the Drive policy.';

/**
 * Multi-file variant of the empty-send routing message.
 * `{paths}` is replaced with a bulleted list of vault-relative paths.
 */
export const FILE_DROP_MESSAGE_MULTI =
  'I just dropped these files into the vault:\n{paths}\n' +
  'Use the file-router skill flow: read each one, classify it (client + content type), ' +
  'propose the destination, and file it after I confirm. ' +
  'If any of them is binary, route it per the Drive policy.';

/** Builds the routing message for an empty send with staged files. */
export function buildFileDropMessage(savedPaths: string[]): string {
  if (savedPaths.length === 1) {
    return FILE_DROP_MESSAGE_SINGLE.replace('{path}', savedPaths[0]);
  }
  const list = savedPaths.map((p) => `- ${p}`).join('\n');
  return FILE_DROP_MESSAGE_MULTI.replace('{paths}', list);
}

/**
 * Builds the note appended to a typed message so Claude knows which files
 * the user just dropped (already saved in the drop zone).
 */
export function buildStagedFilesNote(stagedPaths: string[]): string {
  const list = stagedPaths.map((p) => `- ${p}`).join('\n');
  return `Files I just dropped into the vault drop zone (read them if relevant):\n${list}`;
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

/** A non-image file saved to the drop zone, waiting to ride the next message. */
export interface StagedDroppedFile {
  id: string;
  /** Vault-relative path where the file was saved. */
  path: string;
  name: string;
  size: number;
}

export interface FileDropCallbacks {
  /** Notifies the tab that the staged file set changed. */
  onFilesChanged?: () => void;
}

interface DirectoryEntryLike {
  isDirectory?: boolean;
}

/**
 * Handles non-image files dropped on the chat input.
 *
 * Images are intentionally ignored here: ImageContextManager attaches its own
 * drop handler on the same element (registered first) and keeps handling them
 * exactly as before. Every other file is saved to the vault drop zone
 * (context/drop-zone/) with collision-safe naming and STAGED: a chip shows in
 * the input area and nothing is sent. The staged paths ride along with the
 * user's next message (InputController), or an empty send triggers the
 * file-router flow. Folders are rejected with a notice.
 */
export class FileDropContextManager {
  private app: App;
  private callbacks: FileDropCallbacks;
  private stagedFiles: Map<string, StagedDroppedFile> = new Map();
  private previewEl: HTMLElement | null = null;
  private idCounter = 0;

  constructor(app: App, callbacks: FileDropCallbacks = {}, previewContainerEl?: HTMLElement) {
    this.app = app;
    this.callbacks = callbacks;
    if (previewContainerEl) {
      this.previewEl = previewContainerEl.createDiv({ cls: 'claudian-file-drop-preview' });
      this.previewEl.style.display = 'none';
    }
  }

  /** Attaches the drop handler. Call after ImageContextManager is wired. */
  attach(dropZoneEl: HTMLElement): void {
    dropZoneEl.addEventListener('drop', (e) => {
      void this.handleDrop(e as DragEvent);
    });
  }

  getStagedFiles(): StagedDroppedFile[] {
    return Array.from(this.stagedFiles.values());
  }

  getStagedPaths(): string[] {
    return this.getStagedFiles().map((f) => f.path);
  }

  hasStagedFiles(): boolean {
    return this.stagedFiles.size > 0;
  }

  /** Unstages everything. Saved files stay put: the drop zone IS the staging area. */
  clearStagedFiles(): void {
    if (this.stagedFiles.size === 0) return;
    this.stagedFiles.clear();
    this.updatePreview();
    this.callbacks.onFilesChanged?.();
  }

  private async handleDrop(e: DragEvent): Promise<void> {
    const { files, folderCount } = this.collectDroppedFiles(e);

    const nonImageFiles = files.filter((f) => !isImageContextFile(f));
    if (folderCount === 0 && nonImageFiles.length === 0) return;

    // ImageContextManager's handler already calls preventDefault for file
    // drops; repeat it here defensively so non-image drops never fall through
    // to Obsidian's default link-insertion behavior.
    e.preventDefault();
    e.stopPropagation();

    if (folderCount > 0) {
      new Notice(FOLDER_DROP_NOTICE);
    }

    let stagedAny = false;
    for (const file of nonImageFiles) {
      try {
        const savedPath = await this.saveToDropZone(file);
        const id = this.generateId();
        this.stagedFiles.set(id, {
          id,
          path: savedPath,
          name: savedPath.slice(DROP_ZONE_DIR.length + 1),
          size: file.size,
        });
        stagedAny = true;
        new Notice(`Saved to drop-zone: ${savedPath.slice(DROP_ZONE_DIR.length + 1)}`);
      } catch (error) {
        const detail = error instanceof Error ? ` (${error.message})` : '';
        new Notice(`Failed to save "${file.name}" to drop-zone${detail}`);
      }
    }

    if (stagedAny) {
      this.updatePreview();
      this.callbacks.onFilesChanged?.();
    }
  }

  /**
   * Collects dropped files, preferring DataTransfer.items (which can detect
   * folders via webkitGetAsEntry) and falling back to DataTransfer.files.
   */
  private collectDroppedFiles(e: DragEvent): { files: File[]; folderCount: number } {
    const items = e.dataTransfer?.items;
    if (items && items.length > 0) {
      const files: File[] = [];
      let folderCount = 0;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind !== 'file') continue;
        const entry = (
          item as { webkitGetAsEntry?: () => DirectoryEntryLike | null }
        ).webkitGetAsEntry?.();
        if (entry?.isDirectory) {
          folderCount += 1;
          continue;
        }
        const file = item.getAsFile();
        if (file) files.push(file);
      }
      return { files, folderCount };
    }

    const list = e.dataTransfer?.files;
    const files: File[] = [];
    if (list) {
      for (let i = 0; i < list.length; i++) files.push(list[i]);
    }
    return { files, folderCount: 0 };
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

  // ============================================
  // Private: staged-file chips (mirrors image chips)
  // ============================================

  private updatePreview(): void {
    if (!this.previewEl) return;
    this.previewEl.empty();

    if (this.stagedFiles.size === 0) {
      this.previewEl.style.display = 'none';
      return;
    }

    this.previewEl.style.display = 'flex';
    for (const [id, file] of this.stagedFiles) {
      this.renderChip(id, file);
    }
  }

  private renderChip(id: string, file: StagedDroppedFile): void {
    if (!this.previewEl) return;
    const chipEl = this.previewEl.createDiv({ cls: 'claudian-image-chip claudian-file-drop-chip' });

    const infoEl = chipEl.createDiv({ cls: 'claudian-image-info' });
    const nameEl = infoEl.createSpan({ cls: 'claudian-image-name' });
    nameEl.setText(this.truncateName(file.name, 24));
    nameEl.setAttribute('title', file.path);

    const sizeEl = infoEl.createSpan({ cls: 'claudian-image-size' });
    sizeEl.setText(this.formatSize(file.size));

    const removeEl = chipEl.createSpan({ cls: 'claudian-image-remove' });
    removeEl.setText('×');
    removeEl.setAttribute('aria-label', 'Remove file');

    removeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.stagedFiles.delete(id);
      this.updatePreview();
      this.callbacks.onFilesChanged?.();
    });
  }

  private generateId(): string {
    this.idCounter += 1;
    return `drop-${Date.now()}-${this.idCounter}`;
  }

  private truncateName(name: string, maxLen: number): string {
    if (name.length <= maxLen) return name;
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    const truncatedBase = base.slice(0, maxLen - ext.length - 3);
    return `${truncatedBase}...${ext}`;
  }

  private formatSize(bytes: number): string {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
