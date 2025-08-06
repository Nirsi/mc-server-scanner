import { Buffer } from "buffer";

export interface MinecraftServer {
  ip: string;
  name: string;
}

export interface ScanProgress {
  totalIps: number;
  scannedIps: number;
  serversFound: number;
  scanRate: number; // IPs per second
  estimatedTimeRemaining: number; // seconds
}

export interface ScannerOptions {
  concurrency: number;
  timeout: number; // milliseconds
  port: number;
  maxServers?: number;
  onProgress?: (progress: ScanProgress) => void;
  onServerFound?: (server: MinecraftServer) => void;
  onError?: (error: Error, ip?: string) => void;
  onIPScanned?: (ip: string) => void;
}

export class Scanner {
  private options: Required<
    Omit<ScannerOptions, "maxServers" | "onIPScanned">
  > & {
    maxServers?: number;
    onIPScanned?: (ip: string) => void;
  };
  private isScanning = false;
  private shouldStop = false;
  private startTime = 0;
  private scannedCount = 0;
  private foundServers = 0;
  private totalIpCount = 0;

  constructor(options: Partial<ScannerOptions> = {}) {
    this.options = {
      concurrency: 5000,
      timeout: 3000,
      port: 25565,
      onProgress: () => {},
      onServerFound: () => {},
      onError: () => {},
      onIPScanned: () => {},
      ...options,
    };
  }

  /**
   * Generate all valid IPv4 addresses excluding reserved ranges
   */
  private *generateValidIPs(startFromIP?: string): Generator<string> {
    const isReserved = (
      a: number,
      b: number,
      c: number,
      d: number,
    ): boolean => {
      const ip = (a << 24) | (b << 16) | (c << 8) | d;

      // 10.0.0.0/8 (10.0.0.0 - 10.255.255.255)
      if (a === 10) return true;

      // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
      if (a === 172 && b >= 16 && b <= 31) return true;

      // 192.168.0.0/16 (192.168.0.0 - 192.168.255.255)
      if (a === 192 && b === 168) return true;

      // 127.0.0.0/8 (127.0.0.0 - 127.255.255.255) - Loopback
      if (a === 127) return true;

      // 169.254.0.0/16 (169.254.0.0 - 169.254.255.255) - Link-local
      if (a === 169 && b === 254) return true;

      // 224.0.0.0/4 (224.0.0.0 - 239.255.255.255) - Multicast
      if (a >= 224 && a <= 239) return true;

      // 240.0.0.0/4 (240.0.0.0 - 255.255.255.255) - Reserved
      if (a >= 240) return true;

      // 0.0.0.0/8 - Invalid
      if (a === 0) return true;

      return false;
    };

    // Calculate starting point
    let startA = 1,
      startB = 0,
      startC = 0,
      startD = 1;
    if (startFromIP) {
      const parts = startFromIP.split(".").map(Number);
      if (parts.length !== 4) {
        throw new Error(`Invalid IP format: ${startFromIP}`);
      }
      [startA, startB, startC, startD] = parts as [
        number,
        number,
        number,
        number,
      ];

      // Start from the next IP
      startD++;
      if (startD > 254) {
        startD = 1;
        startC++;
        if (startC > 255) {
          startC = 0;
          startB++;
          if (startB > 255) {
            startB = 0;
            startA++;
          }
        }
      }
    }

    for (let a = startA; a <= 255; a++) {
      const bStart = a === startA ? startB : 0;
      for (let b = bStart; b <= 255; b++) {
        const cStart = a === startA && b === startB ? startC : 0;
        for (let c = cStart; c <= 255; c++) {
          const dStart =
            a === startA && b === startB && c === startC ? startD : 1;
          for (let d = dStart; d <= 254; d++) {
            if (!isReserved(a, b, c, d)) {
              yield `${a}.${b}.${c}.${d}`;
            }
          }
        }
      }
    }
  }

  /**
   * Calculate total number of valid IPs (for progress tracking)
   */
  private calculateTotalIPs(startFromIP?: string): number {
    // This is an approximation to avoid iterating through all IPs
    // Total IPv4 space minus reserved ranges
    const totalIPv4 = 256 * 256 * 256 * 256;

    // Approximate reserved space
    const private10 = 256 * 256 * 256; // 10.0.0.0/8
    const private172 = 16 * 256 * 256; // 172.16.0.0/12
    const private192 = 256 * 256; // 192.168.0.0/16
    const loopback = 256 * 256 * 256; // 127.0.0.0/8
    const linkLocal = 256 * 256; // 169.254.0.0/16
    const multicast = 16 * 256 * 256 * 256; // 224.0.0.0/4
    const reserved = 16 * 256 * 256 * 256; // 240.0.0.0/4
    const invalid = 256 * 256 * 256; // 0.0.0.0/8

    const reservedTotal =
      private10 +
      private172 +
      private192 +
      loopback +
      linkLocal +
      multicast +
      reserved +
      invalid;

    const totalValidIPs = Math.max(0, totalIPv4 - reservedTotal);

    // If we're resuming from a specific IP, calculate remaining IPs
    if (startFromIP) {
      const parts = startFromIP.split(".").map(Number);
      if (parts.length !== 4) {
        throw new Error(`Invalid IP format: ${startFromIP}`);
      }
      const [a, b, c, d] = parts as [number, number, number, number];

      // Convert IP to integer for calculation
      const startIPInt = (a << 24) | (b << 16) | (c << 8) | d;
      const maxIPInt = (255 << 24) | (255 << 16) | (255 << 8) | 254;

      // Rough approximation of remaining IPs
      const remainingIPSpace = Math.max(0, maxIPInt - startIPInt);
      const reservedRatio = reservedTotal / totalIPv4;
      const remainingValidIPs = Math.floor(
        remainingIPSpace * (1 - reservedRatio),
      );

      return Math.max(1, remainingValidIPs); // Ensure at least 1 to avoid division by zero
    }

    return totalValidIPs;
  }

  /**
   * Create a Minecraft handshake packet
   */
  private createHandshakePacket(hostname: string, port: number): Buffer {
    const protocolVersion = 767; // 1.20.1
    const nextState = 1; // Status

    // Convert hostname to buffer
    const hostnameBuffer = Buffer.from(hostname, "utf8");

    // Calculate packet data length (excluding the packet length field itself)
    const hostnameLength = hostnameBuffer.length;
    const packetDataLength =
      1 + // Packet ID (0x00)
      this.getVarIntBytes(protocolVersion).length +
      this.getVarIntBytes(hostnameLength).length +
      hostnameLength +
      2 + // port (2 bytes)
      this.getVarIntBytes(nextState).length; // next state as VarInt

    const packet = Buffer.alloc(1024); // Generous buffer
    let offset = 0;

    // Packet length
    const packetLengthBytes = this.getVarIntBytes(packetDataLength);
    packet.set(packetLengthBytes, offset);
    offset += packetLengthBytes.length;

    // Packet ID (0x00 for handshake)
    packet[offset++] = 0x00;

    // Protocol version
    const protocolVersionBytes = this.getVarIntBytes(protocolVersion);
    packet.set(protocolVersionBytes, offset);
    offset += protocolVersionBytes.length;

    // Server address length
    const hostnameLengthBytes = this.getVarIntBytes(hostnameLength);
    packet.set(hostnameLengthBytes, offset);
    offset += hostnameLengthBytes.length;

    // Server address
    packet.set(hostnameBuffer, offset);
    offset += hostnameBuffer.length;

    // Server port
    packet.writeUInt16BE(port, offset);
    offset += 2;

    // Next state (as VarInt)
    const nextStateBytes = this.getVarIntBytes(nextState);
    packet.set(nextStateBytes, offset);
    offset += nextStateBytes.length;

    return packet.subarray(0, offset);
  }

  /**
   * Create a status request packet
   */
  private createStatusRequestPacket(): Buffer {
    // Status request: packet length (1) + packet ID (0x00)
    const packetLength = this.getVarIntBytes(1);
    const packetId = Buffer.from([0x00]);

    return Buffer.concat([packetLength, packetId]);
  }

  /**
   * Convert integer to VarInt bytes
   */
  private getVarIntBytes(value: number): Buffer {
    const bytes: number[] = [];

    while (value >= 0x80) {
      bytes.push((value & 0x7f) | 0x80);
      value >>>= 7;
    }
    bytes.push(value & 0x7f);

    return Buffer.from(bytes);
  }

  /**
   * Read VarInt from buffer
   */
  private readVarInt(
    buffer: Buffer,
    offset: number,
  ): { value: number; bytesRead: number } {
    let value = 0;
    let position = 0;
    let bytesRead = 0;

    while (bytesRead < 5) {
      // VarInt max 5 bytes
      if (offset + bytesRead >= buffer.length) {
        throw new Error("Unexpected end of buffer while reading VarInt");
      }

      const currentByte = buffer[offset + bytesRead]!;
      value |= (currentByte & 0x7f) << position;
      bytesRead++;

      if ((currentByte & 0x80) === 0) {
        break;
      }

      position += 7;
    }

    return { value, bytesRead };
  }

  /**
   * Attempt to connect to a Minecraft server and get its info
   */
  private async checkMinecraftServer(
    ip: string,
  ): Promise<MinecraftServer | null> {
    return new Promise((resolve) => {
      let hasResolved = false;
      let socketConnection: any = null;
      let debugInfo: string[] = [];
      let connectionStartTime = Date.now();
      let foundValidServer = false;
      let dataBuffer = Buffer.alloc(0);
      let expectedPacketLength = -1;

      const safeResolve = (result: MinecraftServer | null, error?: string) => {
        if (!hasResolved) {
          hasResolved = true;
          const connectionTime = Date.now() - connectionStartTime;

          // Log detailed debug info only for single IP scans or when a server is found
          if (this.totalIpCount <= 5 || result) {
            console.log(`\n🔍 Debug info for ${ip}:${this.options.port}`);
            console.log(`⏱️  Connection time: ${connectionTime}ms`);
            debugInfo.forEach((info) => console.log(`   ${info}`));
            if (error && !foundValidServer) {
              console.log(`❌ Error: ${error}`);
            }
            if (result) {
              console.log(`✅ Server found: "${result.name}"`);
            } else if (!foundValidServer) {
              console.log(`❌ No Minecraft server detected`);
            }
            console.log("");
          }

          resolve(result);
        }
      };

      try {
        debugInfo.push(
          `📡 Attempting connection to ${ip}:${this.options.port}`,
        );

        socketConnection = Bun.connect({
          hostname: ip,
          port: this.options.port,
          socket: {
            open: (socket: any) => {
              try {
                debugInfo.push(`🔗 Socket connected successfully`);

                // Send handshake packet
                const handshake = this.createHandshakePacket(
                  ip,
                  this.options.port,
                );
                socket.write(handshake);
                debugInfo.push(
                  `📤 Sent handshake packet (${handshake.length} bytes)`,
                );

                // Send status request
                const statusRequest = this.createStatusRequestPacket();
                socket.write(statusRequest);
                debugInfo.push(
                  `📤 Sent status request packet (${statusRequest.length} bytes)`,
                );
              } catch (error) {
                debugInfo.push(`❌ Error in socket open: ${error}`);
                try {
                  socket.end();
                } catch {}
                safeResolve(null, `Socket open error: ${error}`);
              }
            },

            data: (socket: any, data: any) => {
              try {
                const buffer = Buffer.from(data);
                dataBuffer = Buffer.concat([dataBuffer, buffer]);
                debugInfo.push(
                  `📥 Received data: ${buffer.length} bytes (total: ${dataBuffer.length})`,
                );

                // If we haven't read the packet length yet
                if (expectedPacketLength === -1) {
                  if (dataBuffer.length < 3) {
                    // Wait for more data
                    return;
                  }

                  // Read packet length
                  const packetLength = this.readVarInt(dataBuffer, 0);
                  expectedPacketLength =
                    packetLength.value + packetLength.bytesRead;
                  debugInfo.push(
                    `📦 Expected total packet size: ${expectedPacketLength} bytes`,
                  );
                }

                // Check if we have received the complete packet
                if (dataBuffer.length < expectedPacketLength) {
                  debugInfo.push(
                    `⏳ Waiting for more data (${dataBuffer.length}/${expectedPacketLength})`,
                  );
                  return;
                }

                // We have the complete packet, process it
                const packetLength = this.readVarInt(dataBuffer, 0);
                let offset = packetLength.bytesRead;
                debugInfo.push(`📦 Packet length: ${packetLength.value}`);

                // Read packet ID
                const packetId = this.readVarInt(dataBuffer, offset);
                offset += packetId.bytesRead;
                debugInfo.push(
                  `🆔 Packet ID: 0x${packetId.value.toString(16).padStart(2, "0")}`,
                );

                // Should be status response packet (ID: 0x00)
                if (packetId.value !== 0x00) {
                  debugInfo.push(
                    `❌ Expected packet ID 0x00, got 0x${packetId.value.toString(16)}`,
                  );
                  try {
                    socket.end();
                  } catch {}
                  safeResolve(
                    null,
                    `Wrong packet ID: 0x${packetId.value.toString(16)}`,
                  );
                  return;
                }

                // Read JSON response length
                const jsonLength = this.readVarInt(dataBuffer, offset);
                offset += jsonLength.bytesRead;
                debugInfo.push(`📄 JSON length: ${jsonLength.value}`);

                // Extract JSON string
                const jsonStr = dataBuffer
                  .subarray(offset, offset + jsonLength.value)
                  .toString("utf8");
                debugInfo.push(
                  `📋 JSON response: ${jsonStr.substring(0, 100)}...`,
                );

                const response = JSON.parse(jsonStr);

                // Extract server name from MOTD
                let serverName = "Unknown Server";

                const extractTextFromMotd = (desc: any): string => {
                  if (!desc) return "";

                  if (typeof desc === "string") {
                    return desc;
                  }

                  let extractedText = "";

                  // Add base text if it exists
                  if (desc.text) {
                    extractedText += desc.text;
                  }

                  // Process extra array recursively
                  if (desc.extra && Array.isArray(desc.extra)) {
                    for (const extra of desc.extra) {
                      const extraText = extractTextFromMotd(extra);
                      if (extraText) {
                        extractedText += extraText;
                      }
                    }
                  }

                  return extractedText;
                };

                if (response.description) {
                  const extractedText = extractTextFromMotd(
                    response.description,
                  );
                  if (extractedText) {
                    serverName = extractedText;
                  }
                }

                // Clean up server name (remove color codes, unicode chars, and extra whitespace)
                serverName = serverName
                  .replace(/§[0-9a-fk-or]/g, "") // Remove Minecraft color codes
                  .replace(/[\u0000-\u001F\u007F-\u009F]/g, "") // Remove control characters
                  .replace(/\s+/g, " ") // Normalize whitespace
                  .trim();

                if (!serverName) serverName = "Unknown Server";

                debugInfo.push(`🏷️  Server name: "${serverName}"`);
                debugInfo.push(
                  `👥 Players: ${response.players?.online || 0}/${response.players?.max || 0}`,
                );
                debugInfo.push(
                  `🎮 Version: ${response.version?.name || "Unknown"}`,
                );

                foundValidServer = true;
                try {
                  socket.end();
                } catch {}
                safeResolve({ ip, name: serverName });
              } catch (error) {
                debugInfo.push(`❌ Error parsing response: ${error}`);
                try {
                  socket.end();
                } catch {}
                safeResolve(null, `Response parsing error: ${error}`);
              }
            },

            error: (socket: any, error: any) => {
              debugInfo.push(`❌ Socket error: ${error}`);
              safeResolve(null, `Socket error: ${error}`);
            },

            close: (socket: any) => {
              debugInfo.push(`🔌 Socket closed`);
              // Don't treat socket close as error if we already found valid server data
              if (!hasResolved && !foundValidServer) {
                safeResolve(null, "Socket closed without response");
              }
            },
          },
        }).catch((error: any) => {
          debugInfo.push(`❌ Connection failed: ${error}`);
          safeResolve(null, `Connection failed: ${error}`);
        });

        // Fallback timeout
        setTimeout(() => {
          if (!hasResolved) {
            debugInfo.push(
              `⏰ Connection timeout after ${this.options.timeout}ms`,
            );
            try {
              if (
                socketConnection &&
                typeof socketConnection.then === "function"
              ) {
                // If socket is still a promise, it hasn't connected yet
                safeResolve(
                  null,
                  `Connection timeout (${this.options.timeout}ms)`,
                );
              }
            } catch {}
            safeResolve(null, `Timeout after ${this.options.timeout}ms`);
          }
        }, this.options.timeout);
      } catch (error) {
        debugInfo.push(`❌ General error: ${error}`);
        safeResolve(null, `General error: ${error}`);
      }
    });
  }

  /**
   * Update and report progress
   */
  private updateProgress(): void {
    const now = Date.now();
    const elapsed = (now - this.startTime) / 1000; // seconds
    const scanRate = this.scannedCount / elapsed;
    const remaining = this.totalIpCount - this.scannedCount;
    const estimatedTimeRemaining = remaining / scanRate;

    const progress: ScanProgress = {
      totalIps: this.totalIpCount,
      scannedIps: this.scannedCount,
      serversFound: this.foundServers,
      scanRate,
      estimatedTimeRemaining: isFinite(estimatedTimeRemaining)
        ? estimatedTimeRemaining
        : 0,
    };

    this.options.onProgress(progress);
  }

  /**
   * Process a batch of IPs concurrently
   */
  private async processBatch(ips: string[]): Promise<void> {
    const promises = ips.map(async (ip) => {
      if (this.shouldStop) return;

      try {
        const server = await this.checkMinecraftServer(ip);

        if (server) {
          this.foundServers++;
          this.options.onServerFound(server);

          // Check if we've reached the maximum number of servers
          if (
            this.options.maxServers &&
            this.foundServers >= this.options.maxServers
          ) {
            this.shouldStop = true;
          }
        }
      } catch (error) {
        this.options.onError(error as Error, ip);
      }

      this.scannedCount++;
      this.options.onIPScanned?.(ip);
    });

    await Promise.all(promises);
  }

  /**
   * Start scanning for Minecraft servers
   */
  async startScan(resumeFromIP?: string): Promise<void> {
    if (this.isScanning) {
      throw new Error("Scanner is already running");
    }

    this.isScanning = true;
    this.shouldStop = false;
    this.startTime = Date.now();
    this.scannedCount = 0;
    this.foundServers = 0;
    this.totalIpCount = this.calculateTotalIPs(resumeFromIP);

    if (resumeFromIP) {
      console.log(
        `Resuming scan from IP ${resumeFromIP} of approximately ${this.totalIpCount.toLocaleString()} IP addresses...`,
      );
    } else {
      console.log(
        `Starting scan of approximately ${this.totalIpCount.toLocaleString()} IP addresses...`,
      );
    }
    console.log(
      `Concurrency: ${this.options.concurrency}, Timeout: ${this.options.timeout}ms`,
    );
    if (this.options.maxServers) {
      console.log(`Max servers to find: ${this.options.maxServers}`);
    }

    const ipGenerator = this.generateValidIPs(resumeFromIP);
    let batch: string[] = [];
    let progressInterval: Timer | null = null;

    try {
      // Set up progress reporting
      progressInterval = setInterval(() => {
        this.updateProgress();
      }, 5000); // Report progress every 5 seconds

      for (const ip of ipGenerator) {
        if (this.shouldStop) break;

        batch.push(ip);

        if (batch.length >= this.options.concurrency) {
          await this.processBatch(batch);
          batch = [];
        }
      }

      // Process remaining IPs in the final batch
      if (batch.length > 0 && !this.shouldStop) {
        await this.processBatch(batch);
      }

      // Final progress update
      this.updateProgress();
    } finally {
      if (progressInterval) {
        clearInterval(progressInterval);
      }
      this.isScanning = false;
    }

    const reason =
      this.options.maxServers && this.foundServers >= this.options.maxServers
        ? `(reached maximum of ${this.options.maxServers} servers)`
        : "";

    console.log(
      `\nScan completed! Found ${this.foundServers} servers out of ${this.scannedCount} IPs scanned. ${reason}`,
    );
  }

  /**
   * Start scanning with a specific list of target IP addresses
   */
  async startScanWithTargets(targetIps: string[]): Promise<void> {
    if (this.isScanning) {
      throw new Error("Scanner is already running");
    }

    if (targetIps.length === 0) {
      throw new Error("No target IPs provided");
    }

    this.isScanning = true;
    this.shouldStop = false;
    this.startTime = Date.now();
    this.scannedCount = 0;
    this.foundServers = 0;
    this.totalIpCount = targetIps.length;

    console.log(
      `Starting targeted scan of ${this.totalIpCount.toLocaleString()} IP addresses...`,
    );
    console.log(
      `Concurrency: ${this.options.concurrency}, Timeout: ${this.options.timeout}ms`,
    );
    if (this.options.maxServers) {
      console.log(`Max servers to find: ${this.options.maxServers}`);
    }

    let batch: string[] = [];
    let progressInterval: Timer | null = null;

    try {
      // Set up progress reporting
      progressInterval = setInterval(() => {
        this.updateProgress();
      }, 5000); // Report progress every 5 seconds

      for (const ip of targetIps) {
        if (this.shouldStop) break;

        batch.push(ip);

        if (batch.length >= this.options.concurrency) {
          await this.processBatch(batch);
          batch = [];
        }
      }

      // Process remaining IPs in the final batch
      if (batch.length > 0 && !this.shouldStop) {
        await this.processBatch(batch);
      }

      // Final progress update
      this.updateProgress();
    } finally {
      if (progressInterval) {
        clearInterval(progressInterval);
      }
      this.isScanning = false;
    }

    const reason =
      this.options.maxServers && this.foundServers >= this.options.maxServers
        ? `(reached maximum of ${this.options.maxServers} servers)`
        : "";

    console.log(
      `\nTargeted scan completed! Found ${this.foundServers} servers out of ${this.scannedCount} IPs scanned. ${reason}`,
    );
  }

  /**
   * Stop the scanning process
   */
  stop(): void {
    if (this.isScanning) {
      console.log("Stopping scanner...");
      this.shouldStop = true;
    }
  }

  /**
   * Check if scanner is currently running
   */
  isRunning(): boolean {
    return this.isScanning;
  }

  /**
   * Get current scan statistics
   */
  getStats(): ScanProgress {
    const elapsed = this.isScanning ? (Date.now() - this.startTime) / 1000 : 0;
    const scanRate = elapsed > 0 ? this.scannedCount / elapsed : 0;
    const remaining = this.totalIpCount - this.scannedCount;
    const estimatedTimeRemaining = scanRate > 0 ? remaining / scanRate : 0;

    return {
      totalIps: this.totalIpCount,
      scannedIps: this.scannedCount,
      serversFound: this.foundServers,
      scanRate,
      estimatedTimeRemaining: isFinite(estimatedTimeRemaining)
        ? estimatedTimeRemaining
        : 0,
    };
  }
}
