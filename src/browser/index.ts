import { serve } from '@hono/node-server';
import { createBrowserApp } from './service.js';

const app = createBrowserApp({
  secret: process.env.BROWSER_SECRET ?? '',
  obscuraUrl: process.env.OBSCURA_CDP_URL ?? 'ws://127.0.0.1:9222',
  obscuraToken: process.env.OBSCURA_CDP_TOKEN ?? '',
});

serve({
  fetch: app.fetch,
  hostname: process.env.BROWSER_HOST ?? '127.0.0.1',
  port: Number(process.env.BROWSER_PORT ?? 4311),
});
