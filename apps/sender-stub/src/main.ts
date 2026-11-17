import { createStub } from './stub';

const secret = process.env.STUB_WEBHOOK_SECRET;
if (!secret) {
  console.error('Invalid environment: STUB_WEBHOOK_SECRET is required');
  process.exit(1);
}
const port = Number(process.env.STUB_PORT ?? 5000);
const host = process.env.STUB_HOST ?? '0.0.0.0';

createStub({ secret, port, host }).then((s) => {
  console.log(`sender stub listening on ${host}:${port}`);
  const stop = () => void s.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
});
