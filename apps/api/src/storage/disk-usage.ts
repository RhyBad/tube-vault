import { LocalFileStore } from '@tubevault/storage';

/** The capacity triple from a single statfs of the vault root (CR-01). */
export interface DiskUsage {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
}

/**
 * A port over the filesystem stat, so `StorageService` is unit-testable without
 * a real disk. The prod impl wraps `@tubevault/storage`; tests inject a fake.
 */
export interface DiskUsageReader {
  read(root: string): DiskUsage;
}

export const DISK_USAGE_READER = Symbol('DISK_USAGE_READER');

/**
 * Prod impl: one `statfs` via `@tubevault/storage`. The `LocalFileStore`
 * constructor mkdirs the root (idempotent), so we build it per call rather than
 * at DI time — the same lazy posture MediaController uses, and cheap for a
 * read-only, human-paced endpoint.
 */
export class LocalDiskUsageReader implements DiskUsageReader {
  read(root: string): DiskUsage {
    return new LocalFileStore(root).diskUsage();
  }
}
