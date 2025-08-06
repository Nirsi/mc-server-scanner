export { MinecraftScannerApp } from './src/app.ts';
export { Database } from './src/database.ts';
export { Scanner } from './src/scanner.ts';
export type { ScanResult } from './src/database.ts';
export type { MinecraftServer, ScanProgress, ScannerOptions } from './src/scanner.ts';

// Run the application if this is the main module
if (import.meta.main) {
  const { MinecraftScannerApp } = await import('./src/app.ts');
  const app = new MinecraftScannerApp();

  try {
    await app.run();
  } catch (error) {
    console.error('💥 Fatal error:', error);
    process.exit(1);
  }
}
