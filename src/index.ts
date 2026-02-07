import { parseCliArgs, runBenchmark } from '@/runner/orchestrator';

async function main(): Promise<void> {
  const config = parseCliArgs(process.argv);
  await runBenchmark(config);
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
