import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  validateUrl: vi.fn(),
  readResource: vi.fn(),
}));

vi.mock('playwright-core', () => ({
  chromium: { connectOverCDP: mocks.connect },
}));
vi.mock('../src/browser/security.js', () => ({
  validateUrl: mocks.validateUrl,
}));
vi.mock('../src/browser/transport.js', () => ({
  readResource: mocks.readResource,
}));

import { createBrowserApp } from '../src/browser/service.js';

const config = {
  secret: 'browser-secret-for-tests-123456',
  obscuraUrl: 'ws://obscura:9222',
  obscuraToken: 'obscura-cdp-secret-for-tests-1234567890',
};

interface MockRequest {
  method(): string;
  resourceType(): string;
  url(): string;
  isNavigationRequest(): boolean;
}

interface MockRoute {
  request(): MockRequest;
  abort(): Promise<void>;
  fulfill(response: unknown): Promise<void>;
}

type MockRouteHandler = (route: MockRoute) => Promise<void>;

function routeFor(
  method = 'GET',
  resourceType = 'document',
  url = 'https://example.com/',
) {
  const request: MockRequest = {
    method: () => method,
    resourceType: () => resourceType,
    url: () => url,
    isNavigationRequest: () => resourceType === 'document',
  };
  return {
    request: () => request,
    abort: vi.fn(async () => {}),
    fulfill: vi.fn(async (_response: unknown) => {}),
  };
}

function fixture() {
  let handler: MockRouteHandler | undefined;
  const route = routeFor();
  const page = {
    goto: vi.fn(async () => {
      await handler?.(route);
      return { status: () => 200 };
    }),
    url: () => 'https://example.com/',
    locator: vi.fn(() => ({
      innerText: vi.fn(async () => 'Rendered page content'),
    })),
    title: vi.fn(async () => 'Example'),
    screenshot: vi.fn(async () => Buffer.from('fake-jpeg')),
  };
  const context = {
    route: vi.fn(async (_pattern: string, callback: MockRouteHandler) => {
      handler = callback;
    }),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {}),
  };
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => {}),
  };
  mocks.connect.mockResolvedValue(browser);
  return {
    app: createBrowserApp(config),
    browser,
    context,
    page,
    route,
    routeHandler: () => handler,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validateUrl.mockImplementation(async (input: string) => ({
    url: new URL(input),
    address: '93.184.216.34',
    family: 4,
  }));
  mocks.readResource.mockResolvedValue({
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: Buffer.from('<title>Example</title>'),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

it('validates required secrets and the Obscura WebSocket endpoint', () => {
  expect(() => createBrowserApp({ ...config, secret: 'short' })).toThrow(
    'BROWSER_SECRET',
  );
  expect(() => createBrowserApp({ ...config, obscuraToken: 'short' })).toThrow(
    'OBSCURA_CDP_TOKEN',
  );
  expect(() =>
    createBrowserApp({ ...config, obscuraUrl: 'http://obscura:9222' }),
  ).toThrow('WebSocket URL');
});

it('requires gateway authorization before connecting to Obscura', async () => {
  const { app } = fixture();
  const response = await app.request('/health');
  expect(response.status).toBe(401);
  expect(mocks.connect).not.toHaveBeenCalled();
});

it('checks Obscura availability in its health response', async () => {
  const { app, browser } = fixture();
  const response = await app.request('/health', {
    headers: { authorization: `Bearer ${config.secret}` },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, engine: 'obscura' });
  expect(mocks.connect).toHaveBeenCalledWith(config.obscuraUrl, {
    timeout: 10_000,
    headers: { Authorization: `Bearer ${config.obscuraToken}` },
  });
  expect(browser.close).toHaveBeenCalledOnce();
});

it('navigates through Obscura, extracts page content, and returns a capture', async () => {
  const { app, browser, context, route } = fixture();
  const response = await app.request('/browse', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ url: 'https://example.com/' }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    url: 'https://example.com/',
    title: 'Example',
    text: 'Rendered page content',
    screenshot: `data:image/jpeg;base64,${Buffer.from('fake-jpeg').toString('base64')}`,
  });
  expect(browser.newContext).toHaveBeenCalledWith({
    javaScriptEnabled: true,
    serviceWorkers: 'block',
    acceptDownloads: false,
    viewport: { width: 1200, height: 800 },
  });
  expect(context.route).toHaveBeenCalledWith('**/*', expect.any(Function));
  expect(route.fulfill).toHaveBeenCalledWith({
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: Buffer.from('<title>Example</title>'),
  });
  expect(mocks.validateUrl).toHaveBeenCalledWith('https://example.com/');
  expect(mocks.readResource).toHaveBeenCalledWith(
    'https://example.com/',
    expect.any(AbortSignal),
  );
  expect(browser.close).toHaveBeenCalledOnce();
  expect(context.close).toHaveBeenCalledOnce();
});

it('blocks non-GET and unsupported resources before fetching them', async () => {
  const { app, routeHandler } = fixture();
  const response = await app.request('/browse', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ url: 'https://example.com/' }),
  });
  expect(response.status).toBe(200);

  const handler = routeHandler();
  expect(handler).toBeDefined();
  const post = routeFor('POST');
  const websocket = routeFor('GET', 'websocket');
  await handler!(post);
  await handler!(websocket);
  expect(post.abort).toHaveBeenCalledOnce();
  expect(websocket.abort).toHaveBeenCalledOnce();
  expect(mocks.readResource).toHaveBeenCalledOnce();
});

it('returns browser errors instead of a success-shaped response', async () => {
  const { app, browser, context } = fixture();
  mocks.readResource.mockRejectedValueOnce(
    new Error('Redirects are blocked for safety.'),
  );
  const response = await app.request('/browse', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ url: 'https://example.com/' }),
  });
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: 'Redirects are blocked for safety.',
  });
  expect(browser.close).toHaveBeenCalledOnce();
  expect(context.close).toHaveBeenCalledOnce();
});

it('reports an unavailable Obscura endpoint from health and navigation', async () => {
  const { app } = fixture();
  mocks.connect.mockRejectedValue(new Error('CDP connection refused.'));
  const headers = { authorization: `Bearer ${config.secret}` };
  const health = await app.request('/health', { headers });
  expect(health.status).toBe(503);
  const response = await app.request('/browse', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/' }),
  });
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: 'CDP connection refused.' });
});
