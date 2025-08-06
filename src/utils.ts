/**
 * Utility functions for the Minecraft Scanner
 */

/**
 * Format time duration in seconds to human readable format
 */
export function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) {
    return "0s";
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (secs > 0 || parts.length === 0) {
    parts.push(`${secs}s`);
  }

  return parts.join(" ");
}

/**
 * Format bytes to human readable format
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Format numbers with commas for better readability
 */
export function formatNumber(num: number): string {
  return num.toLocaleString();
}

/**
 * Validate if a string is a valid IPv4 address
 */
export function isValidIPv4(ip: string): boolean {
  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const match = ip.match(ipv4Regex);

  if (!match) return false;

  const octets = match.slice(1, 5).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255);
}

/**
 * Check if an IP address is in a reserved range
 */
export function isReservedIP(ip: string): boolean {
  if (!isValidIPv4(ip)) return true;

  const parts = ip.split(".").map(Number);
  const [a, b, c, d] = parts;

  // 10.0.0.0/8 (10.0.0.0 - 10.255.255.255)
  if (a === 10) return true;

  // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
  if (a === 172 && b! >= 16 && b! <= 31) return true;

  // 192.168.0.0/16 (192.168.0.0 - 192.168.255.255)
  if (a === 192 && b === 168) return true;

  // 127.0.0.0/8 (127.0.0.0 - 127.255.255.255) - Loopback
  if (a === 127) return true;

  // 169.254.0.0/16 (169.254.0.0 - 169.254.255.255) - Link-local
  if (a === 169 && b === 254) return true;

  // 224.0.0.0/4 (224.0.0.0 - 239.255.255.255) - Multicast
  if (a! >= 224 && a! <= 239) return true;

  // 240.0.0.0/4 (240.0.0.0 - 255.255.255.255) - Reserved
  if (a! >= 240) return true;

  // 0.0.0.0/8 - Invalid
  if (a === 0) return true;

  return false;
}

/**
 * Convert IP address string to 32-bit integer
 */
export function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return (parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!;
}

/**
 * Convert 32-bit integer to IP address string
 */
export function intToIp(int: number): string {
  return [
    (int >>> 24) & 255,
    (int >>> 16) & 255,
    (int >>> 8) & 255,
    int & 255,
  ].join(".");
}

/**
 * Clean Minecraft server name by removing color codes and formatting
 */
export function cleanServerName(name: string): string {
  if (!name || typeof name !== "string") {
    return "Unknown Server";
  }

  // Remove Minecraft color codes (§ followed by any character)
  let cleaned = name.replace(/§[0-9a-fk-or]/gi, "");

  // Remove JSON chat formatting
  cleaned = cleaned.replace(/\{"text":"([^"]*)"[^}]*\}/g, "$1");

  // Remove other common formatting
  cleaned = cleaned.replace(/[\u00A0-\u9999<>&]/g, "");

  // Clean up whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  // Return default if empty
  return cleaned || "Unknown Server";
}

/**
 * Calculate percentage with specified decimal places
 */
export function calculatePercentage(
  value: number,
  total: number,
  decimals: number = 2,
): string {
  if (total === 0) return "0.00";
  return ((value / total) * 100).toFixed(decimals);
}

/**
 * Create a progress bar string
 */
export function createProgressBar(
  current: number,
  total: number,
  width: number = 40,
): string {
  const percentage = total > 0 ? current / total : 0;
  const filled = Math.floor(percentage * width);
  const empty = width - filled;

  const bar = "█".repeat(filled) + "░".repeat(empty);
  const percent = (percentage * 100).toFixed(1).padStart(5);

  return `[${bar}] ${percent}%`;
}

/**
 * Debounce function to limit function calls
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timeout: Timer | null = null;

  return (...args: Parameters<T>) => {
    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      func(...args);
    }, wait);
  };
}

/**
 * Throttle function to limit function calls
 */
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  limit: number,
): (...args: Parameters<T>) => void {
  let inThrottle = false;

  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelay: number = 1000,
): Promise<T> {
  let lastError: Error;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxAttempts) {
        throw lastError;
      }

      const delay = baseDelay * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }

  throw lastError!;
}

/**
 * Get current timestamp in ISO format
 */
export function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Parse ISO timestamp to readable format
 */
export function formatTimestamp(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleString();
  } catch {
    return "Invalid date";
  }
}

/**
 * Calculate estimated time remaining
 */
export function calculateETA(
  processed: number,
  total: number,
  startTime: number,
): number {
  if (processed === 0) return 0;

  const elapsed = (Date.now() - startTime) / 1000;
  const rate = processed / elapsed;
  const remaining = total - processed;

  return remaining / rate;
}

/**
 * Generate a random delay for rate limiting
 */
export function randomDelay(min: number, max: number): Promise<void> {
  const delay = Math.random() * (max - min) + min;
  return sleep(delay);
}
