import { Database } from "./database.ts";
import { Scanner, type MinecraftServer, type ScanProgress } from "./scanner.ts";
import { isValidIPv4, isReservedIP } from "./utils.ts";
import { join } from "path";

interface AppConfig {
  dataDir: string;
  concurrency: number;
  timeout: number;
  port: number;
  progressInterval: number;
  backupInterval: number;
  maxServers?: number;
  scanMode: "global" | "rescan" | "single";
  targetIp?: string;
  resetResume?: boolean;
}

class MinecraftScannerApp {
  private config: AppConfig;
  private database: Database | null = null;
  private scanner: Scanner | null = null;
  private isRunning = false;
  private lastProgressTime = 0;
  private pendingServers: MinecraftServer[] = [];
  private backupInterval: Timer | null = null;
  private ipTrackingInterval: Timer | null = null;
  private lastScannedIP: string | null = null;

  constructor(config: Partial<AppConfig> = {}) {
    this.config = {
      dataDir: join(process.cwd(), "data"),
      concurrency: 5000,
      timeout: 3000,
      port: 25565,
      progressInterval: 5000,
      backupInterval: 300000, // 5 minutes
      scanMode: "rescan",
      ...config,
    };
  }

  /**
   * Parse command line arguments
   */
  private parseArgs(): Partial<AppConfig> {
    const args = process.argv.slice(2);
    const config: Partial<AppConfig> = {};

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const nextArg = args[i + 1];

      switch (arg) {
        case "--concurrency":
        case "-c":
          if (nextArg && !isNaN(Number(nextArg))) {
            config.concurrency = parseInt(nextArg, 10);
            i++;
          }
          break;

        case "--timeout":
        case "-t":
          if (nextArg && !isNaN(Number(nextArg))) {
            config.timeout = parseInt(nextArg, 10);
            i++;
          }
          break;

        case "--port":
        case "-p":
          if (nextArg && !isNaN(Number(nextArg))) {
            config.port = parseInt(nextArg, 10);
            i++;
          }
          break;

        case "--data-dir":
        case "-d":
          if (nextArg) {
            config.dataDir = nextArg;
            i++;
          }
          break;

        case "--max-servers":
        case "-m":
          if (nextArg && !isNaN(Number(nextArg))) {
            config.maxServers = parseInt(nextArg, 10);
            i++;
          }
          break;

        case "--global":
        case "-g":
          config.scanMode = "global";
          break;

        case "--ip":
          if (nextArg) {
            config.scanMode = "single";
            config.targetIp = nextArg;
            i++;
          }
          break;

        case "--reset":
          config.resetResume = true;
          break;

        case "--help":
        case "-h":
          this.printHelp();
          process.exit(0);
          break;

        default:
          if (arg && arg.startsWith("-")) {
            console.warn(`Unknown argument: ${arg}`);
          }
          break;
      }
    }

    return config;
  }

  /**
   * Print help information
   */
  private printHelp(): void {
    console.log(`
Minecraft Server Scanner

Usage: bun run src/app.ts [options]

Options:
  -c, --concurrency <num>   Number of concurrent connections (default: 5000)
  -t, --timeout <ms>        Connection timeout in milliseconds (default: 3000)
  -p, --port <port>         Minecraft server port to scan (default: 25565)
  -d, --data-dir <path>     Directory to store scan results (default: ./data)
  -m, --max-servers <num>   Maximum number of servers to find before stopping
  -g, --global             Scan all IP addresses (full internet scan)
      --ip <address>       Scan only the specified IP address
      --reset              Reset resume position and start global scan from beginning
  -h, --help               Show this help message

Scan Modes:
  Default: Rescan previously found servers from database
  --global: Scan all valid IP addresses on the internet (auto-resumes from last position)
  --ip <address>: Scan only the specified IP address

Resume Functionality:
  Global scans automatically save progress and can be resumed if interrupted.
  The last scanned IP is saved every 30 seconds and on graceful shutdown.

Examples:
  bun run src/app.ts                              # Rescan existing servers
  bun run src/app.ts --global                     # Full internet scan (or resume)
  bun run src/app.ts --global --reset             # Start global scan from beginning
  bun run src/app.ts --ip 192.168.1.1             # Scan specific IP
  bun run src/app.ts --global --concurrency 10000 # Global scan with custom settings
  bun run src/app.ts --data-dir /path/to/data      # Custom data directory
    `);
  }

  /**
   * Initialize the database with current configuration
   */
  private initializeDatabase(): void {
    const dbPath = join(this.config.dataDir, "scan-results.json");
    this.database = new Database(dbPath);
  }

  /**
   * Initialize the scanner with current configuration
   */
  private initializeScanner(): void {
    this.scanner = new Scanner({
      concurrency: this.config.concurrency,
      timeout: this.config.timeout,
      port: this.config.port,
      maxServers: this.config.maxServers,
      onProgress: this.handleProgress.bind(this),
      onServerFound: this.handleServerFound.bind(this),
      onError: this.handleError.bind(this),
      onIPScanned: this.handleIPScanned.bind(this),
    });
  }

  /**
   * Handle progress updates from scanner
   */
  private handleProgress(progress: ScanProgress): void {
    const now = Date.now();

    // Throttle progress updates to avoid spam
    if (now - this.lastProgressTime < this.config.progressInterval) {
      return;
    }

    this.lastProgressTime = now;

    const percentage = (
      (progress.scannedIps / progress.totalIps) *
      100
    ).toFixed(2);
    const scanRate = progress.scanRate.toFixed(0);
    const etaMinutes = Math.floor(progress.estimatedTimeRemaining / 60);
    const etaSeconds = Math.floor(progress.estimatedTimeRemaining % 60);

    console.log(
      `Progress: ${percentage}% | ` +
        `Scanned: ${progress.scannedIps.toLocaleString()} | ` +
        `Found: ${progress.serversFound} servers | ` +
        `Rate: ${scanRate} IPs/s | ` +
        `ETA: ${etaMinutes}:${etaSeconds.toString().padStart(2, "0")}`,
    );
  }

  /**
   * Handle server discovery
   */
  private handleServerFound(server: MinecraftServer): void {
    console.log(`🎯 Found server: ${server.ip} - "${server.name}"`);
    this.pendingServers.push(server);

    // Batch save servers every 10 discoveries or immediately if under 100 total
    if (this.pendingServers.length >= 10) {
      this.savePendingServers();
    }
  }

  /**
   * Handle IP scanned event (for tracking progress)
   */
  private handleIPScanned(ip: string): void {
    this.lastScannedIP = ip;
  }

  /**
   * Handle errors during scanning
   */
  private handleError(error: Error, ip?: string): void {
    // Only log significant errors to avoid spam
    if (
      error.message.includes("timeout") ||
      error.message.includes("refused")
    ) {
      return; // These are expected
    }

    const ipInfo = ip ? ` (IP: ${ip})` : "";
    console.warn(`⚠️  Scan error${ipInfo}: ${error.message}`);
  }

  /**
   * Save pending servers to database
   */
  private async savePendingServers(): Promise<void> {
    if (this.pendingServers.length === 0 || !this.database) return;

    try {
      await this.database.append(this.pendingServers);
      this.pendingServers = [];
    } catch (error) {
      console.error("Failed to save servers:", error);
    }
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      console.log(`\n📋 Received ${signal}. Shutting down gracefully...`);

      if (this.isRunning && this.scanner) {
        this.scanner.stop();

        // Save any pending servers
        if (this.pendingServers.length > 0 && this.database) {
          console.log("💾 Saving pending servers...");
          await this.savePendingServers();
        }

        // Clean up intervals
        if (this.backupInterval) {
          clearInterval(this.backupInterval);
        }
        if (this.ipTrackingInterval) {
          clearInterval(this.ipTrackingInterval);
        }

        // Save last scanned IP for resume functionality
        if (
          this.lastScannedIP &&
          this.database &&
          this.config.scanMode === "global"
        ) {
          console.log(`💾 Saving last scanned IP: ${this.lastScannedIP}`);
          await this.database.updateLastScannedIP(this.lastScannedIP);
        }

        // Wait a moment for scanner to finish current operations
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      console.log("✅ Shutdown complete.");
      process.exit(0);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    // Handle uncaught exceptions
    process.on("uncaughtException", (error) => {
      console.error("💥 Uncaught exception:", error);
      shutdown("uncaughtException");
    });

    process.on("unhandledRejection", (reason) => {
      console.error("💥 Unhandled rejection:", reason);
      shutdown("unhandledRejection");
    });
  }

  /**
   * Initialize the application
   */
  private async initialize(): Promise<void> {
    console.log("🚀 Minecraft Server Scanner v1.0.0");
    console.log("=====================================");

    // Initialize database with final configuration
    this.initializeDatabase();
    await this.database!.init();

    // Load existing data and show stats
    const stats = await this.database!.getStats();
    if (stats.totalServers > 0) {
      console.log(`📊 Existing database: ${stats.totalServers} servers`);
      console.log(`📅 Last updated: ${stats.lastUpdated}`);
    } else {
      console.log("📂 Starting with empty database");
    }

    console.log(`💾 Data directory: ${this.config.dataDir}`);
    console.log(`🔧 Concurrency: ${this.config.concurrency}`);
    console.log(`⏱️  Timeout: ${this.config.timeout}ms`);
    console.log(`🌐 Port: ${this.config.port}`);

    // Display scan mode and check for resume
    let resumeFromIP: string | null = null;
    switch (this.config.scanMode) {
      case "global":
        if (this.config.resetResume) {
          // Clear the resume position
          await this.database!.updateLastScannedIP("");
          console.log(`🌍 Scan Mode: Global (starting fresh - resume reset)`);
          resumeFromIP = null;
        } else {
          resumeFromIP = await this.database!.getLastScannedIP();
          if (resumeFromIP) {
            console.log(`🌍 Scan Mode: Global (resuming from ${resumeFromIP})`);
          } else {
            console.log(`🌍 Scan Mode: Global (all IP addresses)`);
          }
        }
        break;
      case "single":
        console.log(`🎯 Scan Mode: Single IP (${this.config.targetIp})`);
        break;
      case "rescan":
        console.log(`🔄 Scan Mode: Rescan existing servers`);
        break;
    }

    if (this.config.maxServers) {
      console.log(`🎯 Max servers: ${this.config.maxServers}`);
    }
    console.log("=====================================\n");

    // Setup periodic backups
    this.backupInterval = setInterval(async () => {
      try {
        if (this.pendingServers.length > 0) {
          await this.savePendingServers();
        }
        if (this.database) {
          await this.database.cleanupBackups(5); // Keep 5 backups
        }
      } catch (error) {
        console.warn("⚠️  Backup error:", error);
      }
    }, this.config.backupInterval);

    // Store the resume IP for later use
    (this as any).resumeFromIP = resumeFromIP;
  }

  /**
   * Run the application
   */
  async run(): Promise<void> {
    // Parse command line arguments
    const cliConfig = this.parseArgs();
    Object.assign(this.config, cliConfig);

    // Setup shutdown handlers
    this.setupShutdownHandlers();

    try {
      // Initialize
      await this.initialize();

      // Initialize scanner with final configuration
      this.initializeScanner();

      // Prepare scan based on mode
      let scanTargets: string[] = [];

      switch (this.config.scanMode) {
        case "global":
          // Global scan - let scanner use its IP generator
          break;

        case "single":
          if (!this.config.targetIp) {
            throw new Error("Target IP not specified for single IP scan");
          }
          // Validate IP format
          if (!isValidIPv4(this.config.targetIp)) {
            throw new Error(
              `Invalid IP address format: ${this.config.targetIp}`,
            );
          }
          // Check if IP is in reserved range
          if (isReservedIP(this.config.targetIp)) {
            console.warn(
              `⚠️  Warning: ${this.config.targetIp} is in a reserved IP range and may not be reachable`,
            );
          }
          scanTargets = [this.config.targetIp];
          break;

        case "rescan":
          // Load existing servers from database
          const existingData = await this.database!.load();
          scanTargets = existingData.servers.map((server) => server.ip);

          if (scanTargets.length === 0) {
            console.log(
              "No existing servers found in database. Use --global to scan all IPs.",
            );
            return;
          }

          console.log(`Found ${scanTargets.length} existing servers to rescan`);
          break;
      }

      // Setup IP tracking for global scans (save progress every 30 seconds)
      if (this.config.scanMode === "global") {
        this.ipTrackingInterval = setInterval(async () => {
          if (this.lastScannedIP && this.database) {
            try {
              await this.database.updateLastScannedIP(this.lastScannedIP);
            } catch (error) {
              console.warn("⚠️  Failed to save IP progress:", error);
            }
          }
        }, 30000); // Save every 30 seconds
      }

      // Start scanning
      this.isRunning = true;
      const startTime = Date.now();

      if (this.config.scanMode === "global") {
        const resumeFromIP = (this as any).resumeFromIP;
        await this.scanner!.startScan(resumeFromIP);
      } else {
        await this.scanner!.startScanWithTargets(scanTargets);
      }

      // Save any remaining pending servers
      if (this.pendingServers.length > 0) {
        await this.savePendingServers();
      }

      // Show final statistics
      const endTime = Date.now();
      const totalTime = (endTime - startTime) / 1000;
      const stats = this.scanner!.getStats();

      console.log("\n🎉 Scan Complete!");
      console.log("==================");
      console.log(
        `⏱️  Total time: ${Math.floor(totalTime / 60)}:${Math.floor(
          totalTime % 60,
        )
          .toString()
          .padStart(2, "0")}`,
      );
      console.log(`🔍 IPs scanned: ${stats.scannedIps.toLocaleString()}`);
      console.log(`🎯 Servers found: ${stats.serversFound}`);
      console.log(
        `📊 Success rate: ${((stats.serversFound / stats.scannedIps) * 100).toFixed(4)}%`,
      );
      console.log(
        `⚡ Average rate: ${(stats.scannedIps / totalTime).toFixed(0)} IPs/s`,
      );

      const finalDbStats = await this.database!.getStats();
      console.log(`💾 Total in database: ${finalDbStats.totalServers} servers`);

      // Save final IP position for global scans
      if (
        this.lastScannedIP &&
        this.database &&
        this.config.scanMode === "global"
      ) {
        console.log(`💾 Saving final scanned IP: ${this.lastScannedIP}`);
        await this.database.updateLastScannedIP(this.lastScannedIP);
      }
    } catch (error) {
      console.error("💥 Application error:", error);

      // Still save progress even on error
      if (
        this.lastScannedIP &&
        this.database &&
        this.config.scanMode === "global"
      ) {
        try {
          await this.database.updateLastScannedIP(this.lastScannedIP);
          console.log(`💾 Saved progress on error: ${this.lastScannedIP}`);
        } catch (saveError) {
          console.warn("⚠️  Failed to save progress on error:", saveError);
        }
      }

      process.exit(1);
    } finally {
      this.isRunning = false;

      if (this.backupInterval) {
        clearInterval(this.backupInterval);
      }
      if (this.ipTrackingInterval) {
        clearInterval(this.ipTrackingInterval);
      }
    }
  }
}

// Run the application if this file is executed directly
if (import.meta.main) {
  const app = new MinecraftScannerApp();
  app.run().catch((error) => {
    console.error("💥 Fatal error:", error);
    process.exit(1);
  });
}

export { MinecraftScannerApp };
