/** W5 OIDC groups-claim ingestion — storage, absent-claim clear-and-warn, admin sync, readback,
 *  and the social-path isolation.
 *
 *  Drives the real two-hop OIDC login (state + pp_oauth nonce from GET /auth/login, then the
 *  /auth/callback hop) against a stubbed IdP fetch — discovery is module-cached, so the stub
 *  answers the discovery URL too — then inspects user_groups rows in the DB and the
 *  GET /api/me/groups readback. Cross-dialect: the same file runs on in-memory sqlite by default
 *  and on Postgres/MySQL via PAGEPIN_TEST_DB_URL (+ PAGEPIN_DB_URL), single process, concurrency 1.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { loadConfig } from '../src/config.js';
import { makeAuthRoutes } from '../src/auth/routes.js';
import { makeAuthMiddleware } from '../src/api/deps.js';
import { makeMeRoutes } from '../src/api/me.js';
import { userGroups, users } from '../src/db/index.js';
import { FsStorage } from '../src/storage/fs.js';
import { nowIso } from '../src/util.js';
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
function stubFetch(routes: Record<string, unknown | (() => unknown)>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = routes[url];
    if (hit === undefined) throw new Error(`test: unexpected fetch ${url}`);
    return jsonResponse(typeof hit === 'function' ? (hit as () => unknown)() : hit);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** IdP stub routes; userinfo is resolved per call so a test can mutate it between logins. */
function idpRoutes(getUserinfo: () => Record<string, unknown>): Record<string, unknown> {
  return {
    [IDP.discovery]: {
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: IDP.token,
      userinfo_endpoint: IDP.userinfo,
    },
    [IDP.token]: { access_token: 'at-1' },
    [IDP.userinfo]: () => getUserinfo(),
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

async function setupBase(env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pagepin-oidc-groups-'));
  const storage = new FsStorage(dir);
  const db = await makeTestDb();
  const cfg = loadConfig({ ...baseEnv(), ...env });
  return { storage, db, cfg };
}

function buildApp(storage: FsStorage, db: AppDeps['db'], cfg: ReturnType<typeof loadConfig>) {
  const deps: AppDeps = { config: cfg, db, storage };
  const app = new Hono<AppEnv>();
  app.route('/', makeAuthRoutes(deps, 'session'));
  app.route('/', makeMeRoutes(deps, makeAuthMiddleware(deps)));
  return { deps, app };
}

async function setup(env: Record<string, string> = {}) {
  const { storage, db, cfg } = await setupBase(env);
  const { deps, app } = buildApp(storage, db, cfg);
  return { db, cfg, deps, app };
}

function oauthNonce(resp: Response): string {
  const nonce = resp.headers
    .getSetCookie()
    .map((sc) => /(?:^|;\s*)pp_oauth=([^;]+)/.exec(sc)?.[1])
    .find((v) => v !== undefined);
  assert.ok(nonce, 'oauth start must set the pp_oauth nonce cookie');
  return nonce!;
}

/** Real two-hop login: /auth/login 302 (state in Location, nonce in cookie) → /auth/callback. */
async function oidcLogin(app: Hono<AppEnv>): Promise<Response> {
  const start = await app.fetch(new Request('http://localhost:8000/auth/login'));
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('location')!).searchParams.get('state');
  assert.ok(state, 'authorize redirect must carry state');
  return Promise.resolve(
    app.fetch(
      new Request(
        `http://localhost:8000/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `pp_oauth=${oauthNonce(start)}` } },
      ),
    ),
  );
}

/** Cookie header carrying the session a login response just set. */
function sessionCookie(resp: Response): string {
  const session = resp.headers
    .getSetCookie()
    .map((sc) => /(?:^|;\s*)pp_session=([^;]+)/.exec(sc)?.[1])
    .find((v) => v !== undefined);
  assert.ok(session, 'login callback must set pp_session');
  return `pp_session=${session}`;
}

function captureWarn(): { warns: string[]; restore: () => void } {
  const original = console.warn;
  const warns: string[] = [];
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(' '));
  };
  return { warns, restore: () => (console.warn = original) };
}

function getJson(app: Hono<AppEnv>, path: string, cookie: string): Promise<Response> {
  return Promise.resolve(
    app.fetch(new Request(`http://localhost:8000${path}`, { headers: { cookie } })),
  );
}

// ---- config validators ----------------------------------------------------------------------

test('config: whitespace-only PAGEPIN_OIDC_GROUPS_CLAIM throws', () => {
  assert.throws(
    () => loadConfig({ ...baseEnv(), PAGEPIN_OIDC_GROUPS_CLAIM: '   ' }),
    /PAGEPIN_OIDC_GROUPS_CLAIM/,
  );
});

test('config: knobs unset keep ingestion disabled', () => {
  const cfg = loadConfig(baseEnv());
  assert.equal(cfg.oidc?.groupsClaim, undefined);
  assert.equal(cfg.oidc?.adminGroups, undefined);
});

test('config: PAGEPIN_ADMIN_GROUPS with only separators throws', () => {
  assert.throws(() => loadConfig({ ...baseEnv(), PAGEPIN_ADMIN_GROUPS: ', ,' }), /PAGEPIN_ADMIN/);
});

test('config: admin list splits on comma, trims, drops empty entries', () => {
  const cfg = loadConfig({
    ...baseEnv(),
    PAGEPIN_OIDC_GROUPS_CLAIM: 'groups',
    PAGEPIN_ADMIN_GROUPS: 'alpha, beta,,gamma',
  });
  assert.equal(cfg.oidc?.groupsClaim, 'groups');
  assert.deepEqual(cfg.oidc?.adminGroups, ['alpha', 'beta', 'gamma']);
});

// ---- ingestion ------------------------------------------------------------------------------

test('ingest: knob unset ignores a present claim (zero rows, zero warns)', async () => {
  const { db, app } = await setup();
  const restore = stubFetch(idpRoutes(() => ({ sub: 'u1', groups: ['alpha'] })));
  const w = captureWarn();
  try {
    const resp = await oidcLogin(app);
    assert.equal(resp.status, 302);
    assert.equal((await db.select().from(userGroups)).length, 0);
    assert.equal(w.warns.length, 0);
  } finally {
    restore();
    w.restore();
  }
});

test('ingest: claim list stores rows and GET /api/me/groups reads them back', async () => {
  const { db, app } = await setup({ PAGEPIN_OIDC_GROUPS_CLAIM: 'groups' });
  const restore = stubFetch(idpRoutes(() => ({ sub: 'u1', groups: ['beta', 'alpha'] })));
  const w = captureWarn();
  try {
    const resp = await oidcLogin(app);
    assert.equal(resp.status, 302);
    assert.equal((await db.select().from(userGroups)).length, 2);
    const readback = await getJson(app, '/api/me/groups', sessionCookie(resp));
    assert.equal(readback.status, 200);
    assert.deepEqual((await readback.json()).groups, ['alpha', 'beta']);
    assert.equal(w.warns.length, 0);
  } finally {
    restore();
    w.restore();
  }
});

test("ingest: re-login replaces this user's rows only (other users untouched)", async () => {
  const { db, app } = await setup({ PAGEPIN_OIDC_GROUPS_CLAIM: 'groups' });
  const userinfo: Record<string, unknown> = { sub: 'u1', groups: ['alpha'] };
  const restore = stubFetch(idpRoutes(() => userinfo));
  try {
    // A second user with a group row: proves the replacement delete is scoped by user.
    await db.insert(users).values({ id: 'u-other', createdAt: nowIso() });
    await db
      .insert(userGroups)
      .values({ userId: 'u-other', groupName: 'keep-me', syncedAt: nowIso() });
    await oidcLogin(app);
    userinfo.groups = ['beta', 'gamma'];
    const resp = await oidcLogin(app);
    assert.equal(resp.status, 302);
    const rows = await db.select().from(userGroups);
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => r.groupName).sort(),
      ['beta', 'gamma', 'keep-me'],
      'replace, not append, and never cross-user',
    );
    const others = await db.select().from(userGroups).where(eq(userGroups.userId, 'u-other'));
    assert.equal(others.length, 1, "the other user's row survives this user's re-login");
    assert.equal(others[0]!.groupName, 'keep-me');
    const readback = await getJson(app, '/api/me/groups', sessionCookie(resp));
    assert.deepEqual(
      (await readback.json()).groups,
      ['beta', 'gamma'],
      'readback stays own-scoped',
    );
  } finally {
    restore();
  }
});

test('ingest: a composite-PK collision on the insert retries instead of failing login', async () => {
  const { storage, db, cfg } = await setupBase({ PAGEPIN_OIDC_GROUPS_CLAIM: 'groups' });
  // Simulate losing the race window against a concurrent same-user callback: the first
  // userGroups insert throws the duplicate-key error; the sync must redo the replacement.
  let collided = false;
  const realInsert = db.insert.bind(db);
  const flakyDb = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'insert') {
        return (table: unknown) => {
          const built = realInsert(table as Parameters<typeof realInsert>[0]);
          if (table === userGroups && !collided) {
            collided = true;
            return {
              values: () => Promise.reject(new Error('test: composite PK collision')),
            } as unknown as typeof built;
          }
          return built;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as typeof db;
  const { app } = buildApp(storage, flakyDb, cfg);
  const restore = stubFetch(idpRoutes(() => ({ sub: 'u1', groups: ['alpha', 'beta'] })));
  const w = captureWarn();
  try {
    const resp = await oidcLogin(app);
    assert.equal(resp.status, 302, 'login survives the collision via the replacement retry');
    assert.ok(collided, 'the first insert really threw');
    const rows = await db.select().from(userGroups);
    assert.deepEqual(rows.map((r) => r.groupName).sort(), ['alpha', 'beta']);
    assert.equal(w.warns.length, 0, 'the retry path is not a warn case');
  } finally {
    restore();
    w.restore();
  }
});

test('ingest: absent claim clears rows and warns exactly once', async () => {
  const { db, app } = await setup({ PAGEPIN_OIDC_GROUPS_CLAIM: 'groups' });
  const userinfo: Record<string, unknown> = { sub: 'u1', groups: ['alpha', 'beta'] };
  const restore = stubFetch(idpRoutes(() => userinfo));
  const w = captureWarn();
  try {
    await oidcLogin(app);
    assert.equal((await db.select().from(userGroups)).length, 2);
    delete userinfo.groups;
    const resp = await oidcLogin(app);
    assert.equal(resp.status, 302);
    assert.equal((await db.select().from(userGroups)).length, 0, 'rows cleared');
    assert.equal(w.warns.length, 1, 'exactly one warn');
    assert.ok(w.warns[0]!.includes('groups'), 'warn names the claim');
  } finally {
    restore();
    w.restore();
  }
});

test('ingest: claim present but not a list clears rows, warns once, logs no group values', async () => {
  const { db, app } = await setup({ PAGEPIN_OIDC_GROUPS_CLAIM: 'groups' });
  const userinfo: Record<string, unknown> = { sub: 'u1', groups: ['alpha'] };
  const restore = stubFetch(idpRoutes(() => userinfo));
  const w = captureWarn();
  try {
    await oidcLogin(app);
    assert.equal(w.warns.length, 0);
    userinfo.groups = 'alpha-as-string';
    const resp = await oidcLogin(app);
    assert.equal(resp.status, 302);
    assert.equal((await db.select().from(userGroups)).length, 0, 'rows cleared');
    assert.equal(w.warns.length, 1, 'exactly one warn');
    assert.ok(!w.warns[0]!.includes('alpha-as-string'), 'warn carries no claim values');
  } finally {
    restore();
    w.restore();
  }
});

test('ingest: empty claim list clears rows silently (no warn)', async () => {
  const { db, app } = await setup({ PAGEPIN_OIDC_GROUPS_CLAIM: 'groups' });
  const userinfo: Record<string, unknown> = { sub: 'u1', groups: ['alpha'] };
  const restore = stubFetch(idpRoutes(() => userinfo));
  const w = captureWarn();
  try {
    await oidcLogin(app);
    userinfo.groups = [];
    const resp = await oidcLogin(app);
    assert.equal(resp.status, 302);
    assert.equal((await db.select().from(userGroups)).length, 0);
    assert.equal(w.warns.length, 0, 'present-but-empty clears without warning');
  } finally {
    restore();
    w.restore();
  }
});

test('ingest: non-string entries dropped, entries trimmed, duplicates deduped', async () => {
  const { db, app } = await setup({ PAGEPIN_OIDC_GROUPS_CLAIM: 'groups' });
  const userinfo = {
    sub: 'u1',
    groups: ['alpha', '  ', 5, 'beta ', 'alpha', true, 'gamma'],
  };
  const restore = stubFetch(idpRoutes(() => userinfo));
  try {
    const resp = await oidcLogin(app);
    assert.equal(resp.status, 302);
    const rows = await db.select().from(userGroups);
    assert.equal(rows.length, 3, 'composite PK safe after dedupe');
    assert.deepEqual(
      rows.map((r) => r.groupName).sort(),
      ['alpha', 'beta', 'gamma'],
      'junk dropped, entries trimmed, duplicates removed',
    );
  } finally {
    restore();
  }
});

// ---- admin-group sync -----------------------------------------------------------------------

test('admin sync: a claim group in PAGEPIN_ADMIN_GROUPS grants admin at login', async () => {
  const { db, app } = await setup({
    PAGEPIN_OIDC_GROUPS_CLAIM: 'groups',
    PAGEPIN_ADMIN_GROUPS: 'ops',
  });
  // Seed one user so the OIDC account is not the auto-admin first account (n === 0 rule).
  await db.insert(users).values({ id: 'u-seed', createdAt: nowIso() });
  const restore = stubFetch(
    idpRoutes(() => ({
      sub: 'opsuser',
      email: 'ops@x.com',
      email_verified: true,
      groups: ['dev', 'ops'],
    })),
  );
  try {
    const resp = await oidcLogin(app);
    assert.equal(resp.status, 302);
    const row = (await db.select().from(users).where(eq(users.canonicalEmail, 'ops@x.com')))[0]!;
    assert.equal(row.isAdmin, true, 'claim group grants admin');
    const me = await getJson(app, '/api/me', sessionCookie(resp));
    assert.equal((await me.json()).is_admin, true);
  } finally {
    restore();
  }
});

test('admin sync: re-login without the admin group never clears admin', async () => {
  const { db, app } = await setup({
    PAGEPIN_OIDC_GROUPS_CLAIM: 'groups',
    PAGEPIN_ADMIN_GROUPS: 'ops',
  });
  await db.insert(users).values({ id: 'u-seed', createdAt: nowIso() });
  const userinfo: Record<string, unknown> = {
    sub: 'opsuser',
    email: 'ops@x.com',
    email_verified: true,
    groups: ['dev', 'ops'],
  };
  const restore = stubFetch(idpRoutes(() => userinfo));
  try {
    await oidcLogin(app);
    userinfo.groups = ['dev'];
    const resp = await oidcLogin(app);
    assert.equal(resp.status, 302);
    const row = (await db.select().from(users).where(eq(users.canonicalEmail, 'ops@x.com')))[0]!;
    assert.equal(row.isAdmin, true, 'admin sticks — clearance is a manual action only');
    const rows = await db.select().from(userGroups);
    assert.deepEqual(
      rows.map((r) => r.groupName),
      ['dev'],
      'group rows still replace',
    );
  } finally {
    restore();
  }
});

// ---- social-path isolation ------------------------------------------------------------------

test('social login stays untouched: google callback writes no group rows and warns nothing', async () => {
  const { db, app } = await setup({
    PAGEPIN_OIDC_GROUPS_CLAIM: 'groups',
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
  const w = captureWarn();
  try {
    const start = await app.fetch(new Request('http://localhost:8000/auth/social/google'));
    assert.equal(start.status, 302);
    assert.ok(start.headers.get('location')!.startsWith(GOOGLE_AUTHORIZE), 'google authorize URL');
    const state = new URL(start.headers.get('location')!).searchParams.get('state');
    assert.ok(state, 'social redirect carries state');
    const resp = await app.fetch(
      new Request(
        `http://localhost:8000/auth/social/google/callback?code=c&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `pp_oauth=${oauthNonce(start)}` } },
      ),
    );
    assert.equal(resp.status, 302);
    const created = await db.select().from(users).where(eq(users.canonicalEmail, 'soc@x.com'));
    assert.equal(created.length, 1, 'social account created');
    assert.equal((await db.select().from(userGroups)).length, 0, 'no group rows from social paths');
    assert.equal(w.warns.length, 0);
  } finally {
    restore();
    w.restore();
  }
});
