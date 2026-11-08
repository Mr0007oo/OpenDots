import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { timingSafeEqual } from 'node:crypto';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { z } from 'zod';
import { validateUrl } from './security.js';
import { readResource } from './transport.js';

const resourceTypes = new Set([
  'document',
  'stylesheet',
  'image',
  'font',
  'script',
  'xhr',
  'fetch',
]);

export interface BrowserServiceConfig {
  secret: string;
  obscuraUrl: string;
  obscuraToken: string;
}

export function createBrowserApp(config: BrowserServiceConfig) {
  if (config.secret.length < 24)
    throw new Error('BROWSER_SECRET must be at least 24 characters.');
  if (config.obscuraToken.length < 32)
    throw new Error('OBSCURA_CDP_TOKEN must be at least 32 characters.');
  const cdpUrl = new URL(config.obscuraUrl);
  if (
    !['ws:', 'wss:'].includes(cdpUrl.protocol) ||
    cdpUrl.username ||
    cdpUrl.password
  )
    throw new Error(
      'OBSCURA_CDP_URL must be a WebSocket URL without credentials.',
    );

  const app = new Hono<{ Bindings: HttpBindings }>();
  app.use('*', bodyLimit({ maxSize: 16_384 }));
  app.use('*', async (c, next) => {
    const supplied = Buffer.from(
      c.req.header('authorization')?.replace(/^Bearer /, '') ?? '',
    );
    const expected = Buffer.from(config.secret);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return c.json({ error: 'Unauthorized' }, 401);
    await next();
  });

  const connect = () =>
    chromium.connectOverCDP(config.obscuraUrl, {
      timeout: 10_000,
      headers: { Authorization: `Bearer ${config.obscuraToken}` },
    });

  let busy = false;
  app.get('/health', async (c) => {
    try {
      const browser = await connect();
      await browser.close();
      return c.json({ ok: true, engine: 'obscura' });
    } catch (error) {
      console.error(
        'Obscura browser health check failed.',
        error instanceof Error ? error.message : 'Unknown failure.',
      );
      return c.json({ error: 'Obscura browser backend is unavailable.' }, 503);
    }
  });
  app.post('/browse', async (c) => {
    const parsed = z
      .object({ url: z.string().url().max(2048) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'A valid URL is required.' }, 400);
    if (busy) return c.json({ error: 'Browser is busy. Retry shortly.' }, 429);
    busy = true;
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let browserClosing: Promise<void> | undefined;
    const controller = new AbortController();
    const disconnectBrowser = () => {
      if (!browserClosing && browser) browserClosing = browser.close();
      return browserClosing ?? Promise.resolve();
    };
    const abort = (reason: Error) => {
      if (!controller.signal.aborted) controller.abort(reason);
      void disconnectBrowser().catch((error: unknown) =>
        console.error(
          'Obscura browser disconnect failed.',
          error instanceof Error ? error.message : 'Unknown failure.',
        ),
      );
    };
    const cancelled = () => abort(new Error('Browser request cancelled.'));
    const disconnected = () => {
      if (!outgoing?.writableFinished) cancelled();
    };
    const outgoing = c.env?.outgoing;
    c.req.raw.signal.addEventListener('abort', cancelled, { once: true });
    outgoing?.on('close', disconnected);
    const deadline = setTimeout(
      () => abort(new Error('Browser request timed out.')),
      40_000,
    );
    let mainError: string | undefined;
    try {
      await validateUrl(parsed.data.url);
      browser = await connect();
      controller.signal.throwIfAborted();
      context = await browser.newContext({
        javaScriptEnabled: true,
        serviceWorkers: 'block',
        acceptDownloads: false,
        viewport: { width: 1200, height: 800 },
      });
      let count = 0;
      await context.route('**/*', async (route) => {
        const request = route.request();
        if (
          ++count > 50 ||
          request.method() !== 'GET' ||
          !resourceTypes.has(request.resourceType())
        ) {
          await route.abort();
          return;
        }
        try {
          await route.fulfill(
            await readResource(request.url(), controller.signal),
          );
        } catch (error) {
          if (request.isNavigationRequest())
            mainError =
              error instanceof Error ? error.message : 'Navigation failed.';
          await route.abort();
        }
      });
      const page = await context.newPage();
      const response = await page.goto(parsed.data.url, {
        waitUntil: 'domcontentloaded',
        timeout: 25_000,
      });
      if (mainError) throw new Error(mainError);
      if (!response || response.status() >= 400)
        throw new Error(
          `Source returned HTTP ${response?.status() ?? 'unknown'}.`,
        );
      await validateUrl(page.url());
      const text = (
        await page.locator('body').innerText({ timeout: 5000 })
      ).slice(0, 30_000);
      const title = await page.title();
      const screenshot = (
        await page.screenshot({ type: 'jpeg', quality: 60, timeout: 5000 })
      ).toString('base64');
      return c.json({
        url: page.url(),
        title,
        text,
        screenshot: `data:image/jpeg;base64,${screenshot}`,
      });
    } catch (error) {
      return c.json(
        {
          error:
            controller.signal.reason instanceof Error
              ? controller.signal.reason.message
              : (mainError ??
                (error instanceof Error ? error.message : 'Browser failed.')),
        },
        502,
      );
    } finally {
      clearTimeout(deadline);
      c.req.raw.signal.removeEventListener('abort', cancelled);
      outgoing?.off('close', disconnected);
      try {
        await context?.close();
      } catch (error) {
        console.error(
          'Obscura browser context cleanup failed.',
          error instanceof Error ? error.message : 'Unknown failure.',
        );
      }
      try {
        await disconnectBrowser();
      } catch (error) {
        console.error(
          'Obscura browser disconnect failed.',
          error instanceof Error ? error.message : 'Unknown failure.',
        );
      } finally {
        busy = false;
      }
    }
  });
  return app;
}
