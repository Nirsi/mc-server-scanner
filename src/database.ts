import { readFile, writeFile, exists, mkdir } from "fs/promises";
import { join, dirname } from "path";

export interface ScanResult {
  timestamp: string; // ISO 8601 format
  servers: Array<{
    ip: string;
    name: string;
  }>;
  last_ip?: string; // Last scanned IP for resume functionality
}

export class Database {
  private filePath: string;
  private lockFile: string;
  private backupDir: string;

  constructor(filePath?: string) {
    this.filePath = filePath || Database.getDefaultPath();
    this.lockFile = `${this.filePath}.lock`;
    this.backupDir = join(dirname(this.filePath), "backups");
  }

  /**
   * Get the default database path in the data directory
   */
  static getDefaultPath(): string {
    return join(process.cwd(), "data", "scan-results.json");
  }

  /**
   * Create a Database instance with default path in data directory
   */
  static createDefault(): Database {
    return new Database();
  }

  /**
   * Initialize the database directory structure
   */
  async init(): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    await mkdir(this.backupDir, { recursive: true });
  }

  /**
   * Check if database file exists
   */
  async fileExists(): Promise<boolean> {
    try {
      return await exists(this.filePath);
    } catch {
      return false;
    }
  }

  /**
   * Acquire file lock to prevent concurrent access
   */
  private async acquireLock(): Promise<void> {
    let attempts = 0;
    const maxAttempts = 50;

    while (attempts < maxAttempts) {
      try {
        const lockExists = await exists(this.lockFile);
        if (!lockExists) {
          await writeFile(this.lockFile, process.pid.toString());
          return;
        }

        // Wait 100ms before retrying
        await new Promise((resolve) => setTimeout(resolve, 100));
        attempts++;
      } catch (error) {
        if (attempts === maxAttempts - 1) {
          throw new Error(
            `Failed to acquire file lock after ${maxAttempts} attempts`,
          );
        }
        attempts++;
      }
    }

    throw new Error("Failed to acquire file lock: timeout");
  }

  /**
   * Release file lock
   */
  private async releaseLock(): Promise<void> {
    try {
      const { unlink } = await import("fs/promises");
      await unlink(this.lockFile);
    } catch (error) {
      // Lock file might not exist, which is fine
      console.warn("Warning: Could not release lock file:", error);
    }
  }

  /**
   * Create a backup of the current database file
   */
  async backup(): Promise<string> {
    if (!(await this.fileExists())) {
      throw new Error("Cannot backup: database file does not exist");
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(this.backupDir, `scan-results-${timestamp}.json`);

    const data = await readFile(this.filePath, "utf-8");
    await writeFile(backupPath, data, "utf-8");

    return backupPath;
  }

  /**
   * Load scan results from the database file
   */
  async load(): Promise<ScanResult> {
    await this.acquireLock();

    try {
      if (!(await this.fileExists())) {
        // Return empty result if file doesn't exist
        return {
          timestamp: new Date().toISOString(),
          servers: [],
        };
      }

      const data = await readFile(this.filePath, "utf-8");
      const result = JSON.parse(data) as ScanResult;

      // Validate the structure
      if (!result.timestamp || !Array.isArray(result.servers)) {
        throw new Error("Invalid database file structure");
      }

      return result;
    } catch (error) {
      throw new Error(`Failed to load database: ${error}`);
    } finally {
      await this.releaseLock();
    }
  }

  /**
   * Save scan results to the database file with atomic write
   */
  async save(scanResult: ScanResult): Promise<void> {
    await this.acquireLock();

    try {
      // Create backup if file exists
      if (await this.fileExists()) {
        await this.backup();
      }

      // Write to temporary file first (atomic operation)
      const tempPath = `${this.filePath}.tmp`;
      const data = JSON.stringify(scanResult, null, 2);

      await writeFile(tempPath, data, "utf-8");

      // Atomic move from temp to final location
      const { rename } = await import("fs/promises");
      await rename(tempPath, this.filePath);
    } catch (error) {
      throw new Error(`Failed to save database: ${error}`);
    } finally {
      await this.releaseLock();
    }
  }

  /**
   * Append new server discoveries to existing results
   */
  async append(newServers: Array<{ ip: string; name: string }>): Promise<void> {
    if (newServers.length === 0) return;

    const currentResult = await this.load();

    // Filter out duplicates based on IP address
    const existingIps = new Set(currentResult.servers.map((s) => s.ip));
    const uniqueNewServers = newServers.filter(
      (server) => !existingIps.has(server.ip),
    );

    if (uniqueNewServers.length === 0) return;

    const updatedResult: ScanResult = {
      timestamp: new Date().toISOString(),
      servers: [...currentResult.servers, ...uniqueNewServers],
      last_ip: currentResult.last_ip,
    };

    await this.save(updatedResult);
  }

  /**
   * Update an existing server entry
   */
  async update(ip: string, newName: string): Promise<boolean> {
    const currentResult = await this.load();

    const serverIndex = currentResult.servers.findIndex((s) => s.ip === ip);
    if (serverIndex === -1) {
      return false; // Server not found
    }

    currentResult.servers[serverIndex]!.name = newName;
    currentResult.timestamp = new Date().toISOString();

    await this.save(currentResult);
    return true;
  }

  /**
   * Get statistics about the database
   */
  async getStats(): Promise<{
    totalServers: number;
    lastUpdated: string | null;
  }> {
    try {
      const result = await this.load();
      return {
        totalServers: result.servers.length,
        lastUpdated: result.timestamp,
      };
    } catch {
      return {
        totalServers: 0,
        lastUpdated: null,
      };
    }
  }

  /**
   * Clean up old backup files (keep only the most recent N backups)
   */
  async cleanupBackups(keepCount: number = 10): Promise<void> {
    try {
      const { readdir, stat, unlink } = await import("fs/promises");
      const files = await readdir(this.backupDir);

      const backupFiles = files
        .filter(
          (file) => file.startsWith("scan-results-") && file.endsWith(".json"),
        )
        .map((file) => join(this.backupDir, file));

      if (backupFiles.length <= keepCount) return;

      // Get file stats and sort by modification time (newest first)
      const fileStats = await Promise.all(
        backupFiles.map(async (file) => ({
          path: file,
          mtime: (await stat(file)).mtime,
        })),
      );

      fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      // Remove old backups
      const filesToDelete = fileStats.slice(keepCount);
      await Promise.all(filesToDelete.map((file) => unlink(file.path)));
    } catch (error) {
      console.warn("Warning: Could not cleanup old backups:", error);
    }
  }

  /**
   * Get the last scanned IP address for resume functionality
   */
  async getLastScannedIP(): Promise<string | null> {
    try {
      const result = await this.load();
      return result.last_ip && result.last_ip.trim() !== ""
        ? result.last_ip
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Update the last scanned IP address
   */
  async updateLastScannedIP(ip: string): Promise<void> {
    const currentResult = await this.load();
    currentResult.last_ip = ip.trim() === "" ? undefined : ip;
    currentResult.timestamp = new Date().toISOString();
    await this.save(currentResult);
  }
}
