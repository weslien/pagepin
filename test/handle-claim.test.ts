/** OIDC 首登 handle 引导改道 — claimNext(src/auth/routes.ts)的行为面。
 *  handle=null 的联合登录,回跳目的在 console 根以外时,改到声明页并带 ?next= 原目的地;
 *  /activate(设备授权)不改道;handle 已设不改道;dual 模式暂不改道。
 *  照 oidc-groups.test.ts 的两跳假 IdP 登录(state + pp_oauth nonce → /auth/callback)看 Location。
 *  跨方言:同文件默认跑内存 sqlite,PAGEPIN_TEST_DB_URL 时跑同文件,单进程,串行。
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Hono } from 'hono';

import { loadConfig } from '../src/config.js';
import { makeAuthRoutes } from '../src/auth/routes.js';
import { makeAuthMiddleware } from '../src/api/deps.js';
import { makeMeRoutes } from '../src/api/me.js';
import { FsStorage } from '../src/storage/fs.js';
import type { AppDeps, AppEnv } from '../src/types.js';
import { makeTestDb } from './helpers/db.js';

const ISSUER = 'https://idp.test';
const IDP = {
  discovery: `${ISSUER}/.well-known/openid-configuration`,
  token: `${ISSUER}/token`,
  userinfo: `${ISSUER}/userinfo`,
};
const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Swap globalThis.fetch for a URL-keyed stub; returns a restore function. */
function stubFetch(routes: Record<string, unknown>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = routes[url];
    if (hit === undefined) throw new Error(`test: unexpected fetch ${url}`);
    return jsonResponse(hit);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const USERINFO = {
  sub: 'u1',
  name: 'Fed User',
  email: 'fed@example.com',
  email_verified: true,
};

function idpRoutes(): Record<string, unknown> {
  return {
    [IDP.discovery]: {
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: IDP.token,
      userinfo_endpoint: IDP.userinfo,
    },
    [IDP.token]: { access_token: 'at-1' },
    [IDP.userinfo]: USERINFO,
  };
}

function baseEnv(): Record<string, string> {
  return {
    PAGEPIN_SECRET: 'test',
    PAGEPIN_BASE_URL: 'http://localhost:8000',
    PAGEPIN_AUTH_MODE: 'oidc',
    PAGEPIN_OIDC_ISSUER: ISSUER,
    PAGEPIN_OIDC_CLIENT_ID: 'cid',
    PAGEPIN_OIDC_CLIENT_SECRET: 'csecret',
  };
}

async function setup(env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pagepin-handle-claim-'));
  const storage = new FsStorage(dir);
  const db = await makeTestDb();
  const cfg = loadConfig({ ...baseEnv(), ...env });
  const deps: AppDeps = { config: cfg, db, storage };
  const app = new Hono<AppEnv>();
  app.route('/', makeAuthRoutes(deps, 'session'));
  app.route('/', makeMeRoutes(deps, makeAuthMiddleware(deps)));
  return { db, cfg, app };
}

function oauthNonce(resp: Response): string {
  const nonce = resp.headers
    .getSetCookie()
    .map((sc) => /(?:^|;\s*)pp_oauth=([^;]+)/.exec(sc)?.[1])
    .find((v) => v !== undefined);
  assert.ok(nonce, 'oauth start must set the pp_oauth nonce cookie');
  return nonce!;
}

/** 两跳登录:GET /auth/login?next=… 302(state+nonce)→ GET /auth/callback。 */
async function oidcLogin(app: Hono<AppEnv>, next: string): Promise<Response> {
  const start = await app.fetch(
    new Request(`http://localhost:8000/auth/login?next=${encodeURIComponent(next)}`),
  );
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('location')!).searchParams.get('state');
  assert.ok(state, 'authorize redirect must carry state');
  const nonce = oauthNonce(start);
  return Promise.resolve(
    app.fetch(
      new Request(
        `http://localhost:8000/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
        { headers: { cookie: 'pp_oauth=' + nonce } },
      ),
    ),
  );
}

/** 登录响应 Set-Cookie 里成对收回 pp_session + pp_csrf(直接可做双提交)。 */
function cookiePair(resp: Response): string {
  const j = resp.headers.getSetCookie();
  const session = /(?:^|;\s*)pp_session=([^;]+)/.exec(
    j.find((sc) => /(?:^|;\s*)pp_session=/.test(sc)) ?? '',
  )?.[1];
  const csrf = /(?:^|;\s*)pp_csrf=([^;]+)/.exec(
    j.find((sc) => /(?:^|;\s*)pp_csrf=/.test(sc)) ?? '',
  )?.[1];
  assert.ok(session && csrf, 'login callback must set pp_session + pp_csrf');
  return `pp_session=${session}; pp_csrf=${csrf}`;
}

/** console SPA 认领动作:POST /api/me/handle(cookie+双提交 CSRF)。 */
function claimHandle(app: Hono<AppEnv>, cookie: string, handle: string): Promise<Response> {
  const csrf = /(?:^|;\s*)pp_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
  return Promise.resolve(
    app.fetch(
      new Request('http://localhost:8000/api/me/handle', {
        method: 'POST',
        headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
        body: JSON.stringify({ handle }),
      }),
    ),
  );
}

// ---- 单域:改道 ------------------------------------------------------------------

test('fresh OIDC login detours an off-console landing through the claim page', async () => {
  const { app } = await setup();
  const restore = stubFetch(idpRoutes());
  try {
    const resp = await oidcLogin(app, '/p/alice/demo/');
    assert.equal(resp.status, 302);
    assert.equal(
      resp.headers.get('location'),
      `/?next=${encodeURIComponent('/p/alice/demo/')}`,
      'handle-null user lands on the console claim page with the destination kept',
    );
  } finally {
    restore();
  }
});

test('console-root landing stays direct (the claim page already lives there)', async () => {
  const { app } = await setup();
  const restore = stubFetch(idpRoutes());
  try {
    const resp = await oidcLogin(app, '/');
    assert.equal(resp.status, 302);
    assert.equal(resp.headers.get('location'), '/');
  } finally {
    restore();
  }
});

test('device activation landing stays direct (no handle requirement by design)', async () => {
  const { app } = await setup();
  const restore = stubFetch(idpRoutes());
  try {
    const resp = await oidcLogin(app, '/activate?user_code=ABCD-EFGH');
    assert.equal(resp.status, 302);
    assert.equal(resp.headers.get('location'), '/activate?user_code=ABCD-EFGH');
  } finally {
    restore();
  }
});

test('login after the handle was claimed lands where it started', async () => {
  const { app } = await setup();
  const restore = stubFetch(idpRoutes());
  try {
    const first = await oidcLogin(app, '/p/alice/demo/');
    assert.equal(first.headers.get('location'), `/?next=${encodeURIComponent('/p/alice/demo/')}`);
    const claimed = await claimHandle(app, cookiePair(first), 'pickme');
    assert.equal(claimed.status, 200);
    assert.equal((await claimed.json()).handle, 'pickme');
    const second = await oidcLogin(app, '/p/alice/demo/');
    assert.equal(second.headers.get('location'), '/p/alice/demo/');
  } finally {
    restore();
  }
});

test('dual mode keeps the landing (no cross-plane detour yet)', async () => {
  const { app } = await setup({
    PAGEPIN_CONSOLE_HOST: 'console.test',
    PAGEPIN_CONTENT_HOST: 'content.test',
  });
  const restore = stubFetch(idpRoutes());
  try {
    const resp = await oidcLogin(app, '/p/alice/demo/');
    assert.equal(resp.status, 302);
    assert.equal(resp.headers.get('location'), '/p/alice/demo/');
  } finally {
    restore();
  }
});

// ---- 社交路径同改道 ---------------------------------------------------------------

test('social login detours too: google callback sends a handle-null user to the claim page', async () => {
  const { app } = await setup({
    PAGEPIN_OAUTH_PROVIDERS: 'google',
    PAGEPIN_OAUTH_GOOGLE_CLIENT_ID: 'gcid',
    PAGEPIN_OAUTH_GOOGLE_CLIENT_SECRET: 'gsecret',
  });
  const restore = stubFetch({
    [GOOGLE_TOKEN]: { access_token: 'gt-1' },
    [GOOGLE_USERINFO]: {
      sub: 'g-1',
      name: 'G Worth',
      email: 'soc@x.com',
      email_verified: true,
    },
  });
  try {
    const start = await app.fetch(
      new Request(
        `http://localhost:8000/auth/social/google?next=${encodeURIComponent('/p/alice/demo/')}`,
      ),
    );
    assert.equal(start.status, 302);
    assert.ok(start.headers.get('location')!.startsWith(GOOGLE_AUTHORIZE), 'google authorize URL');
    const state = new URL(start.headers.get('location')!).searchParams.get('state');
    assert.ok(state, 'social redirect carries state');
    const nonce = oauthNonce(start);
    const resp = await app.fetch(
      new Request(
        `http://localhost:8000/auth/social/google/callback?code=c&state=${encodeURIComponent(state)}`,
        { headers: { cookie: 'pp_oauth=' + nonce } },
      ),
    );
    assert.equal(resp.status, 302);
    assert.equal(resp.headers.get('location'), `/?next=${encodeURIComponent('/p/alice/demo/')}`);
  } finally {
    restore();
  }
});
