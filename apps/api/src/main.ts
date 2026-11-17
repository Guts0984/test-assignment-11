import { Logger } from '@nestjs/common';
import { createApp } from './app';

async function main(): Promise<void> {
  const running = await createApp();
  new Logger('Bootstrap').log(`API listening on ${running.url}  (docs: ${running.url}/docs)`);
  const stop = () => void running.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
