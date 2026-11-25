/** OIDC group claims ingestion + admin-group sync 单测。
 *
 * 覆盖:
 *   - 新用户含 admin group → isAdmin=true, groups 落库;
 *   - 已有用户被移出 admin group → isAdmin=false, groups 更新;
 *   - userinfo 无 groups claim → 不覆写既有 groups / admin;
 *   - 空 groups claim → 存 [] 并撤销 admin;
 *   - exchangeCode 从 userinfo 解析 groups。
 *
 * 运行:node --import tsx --test test/oidc-groups.test.ts。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { upsertFederatedUser } from '../src/auth/routes.js';
import { exchangeCode } from '../src/auth/oidc.js';
import { users } from '../src/db/index.js';
import { FsStorage } from '../src/storage/fs.js';
import { makeTestDb } from './helpers/db.js';
import type { AppDeps } from '../src/types.js';

async function setup(): Promise<{ deps: AppDeps; db: ReturnType<typeof makeTestDb> extends Promise<infer T> ? T : never }> {
  const dir = await mkdtemp(join(tmpdir(), 'pagepin-oidc-'));
  const db = await makeTestDb();
  const cfg = loadConfig({
    PAGEPIN_SECRET: 'test',
    PAGEPIN_BASE_URL: 'http://localhost:8000',
    PAGEPIN_AUTH_MODE: 'oidc',
    PAGEPIN_OIDC_ISSUER: 'https://idp.example.com',
    PAGEPIN_OIDC_CLIENT_ID: 'c',
    PAGEPIN_OIDC_CLIENT_SECRET: 's',
    PAGEPIN_OIDC_ADMIN_GROUP: 'admins',
    PAGEPIN_STORAGE: 'fs',
  });
  const deps: AppDeps = { config: cfg, db, storage: new FsStorage(dir) };
  return { deps, db };
}

test('new user in admin group gets admin role and persisted groups', async () => {
  const { deps, db } = await setup();
  const u = await upsertFederatedUser(deps, {
    provider: 'oidc',
    sub: 'oidc:a',
    email: 'a@x.com',
    emailVerified: true,
    groups: ['admins', 'users'],
  });
  assert.equal(u.isAdmin, true);
  const row = (await db.select().from(users).where(eq(users.id, u.id)))[0]!;
  assert.deepEqual(row.oidcGroups, ['admins', 'users']);
});

test('user removed from admin group has admin revoked and groups updated', async () => {
  const { deps, db } = await setup();
  const u = await upsertFederatedUser(deps, {
    provider: 'oidc',
    sub: 'oidc:b',
    email: 'b@x.com',
    emailVerified: true,
    groups: ['admins'],
  });
  assert.equal(u.isAdmin, true);
  const u2 = await upsertFederatedUser(deps, {
    provider: 'oidc',
    sub: 'oidc:b',
    email: 'b@x.com',
    emailVerified: true,
    groups: ['users'],
  });
  assert.equal(u2.isAdmin, false);
  const row = (await db.select().from(users).where(eq(users.id, u2.id)))[0]!;
  assert.deepEqual(row.oidcGroups, ['users']);
});

test('user with no groups claim does not clobber existing groups or admin', async () => {
  const { deps, db } = await setup();
  const u = await upsertFederatedUser(deps, {
    provider: 'oidc',
    sub: 'oidc:c',
    email: 'c@x.com',
    emailVerified: true,
    groups: ['admins'],
  });
  assert.equal(u.isAdmin, true);
  const u2 = await upsertFederatedUser(deps, {
    provider: 'oidc',
    sub: 'oidc:c',
    email: 'c@x.com',
    emailVerified: true,
    // groups 字段未提供
  });
  assert.equal(u2.isAdmin, true);
  const row = (await db.select().from(users).where(eq(users.id, u2.id)))[0]!;
  assert.deepEqual(row.oidcGroups, ['admins']);
});

test('new user with empty groups claim gets empty groups and no admin', async () => {
  const { deps, db } = await setup();
  const u = await upsertFederatedUser(deps, {
    provider: 'oidc',
    sub: 'oidc:d',
    email: 'd@x.com',
    emailVerified: true,
    groups: [],
  });
  assert.equal(u.isAdmin, false);
  const row = (await db.select().from(users).where(eq(users.id, u.id)))[0]!;
  assert.deepEqual(row.oidcGroups, []);
});

test('exchangeCode parses groups from userinfo payload', async () => {
  const { deps } = await setup();
  const cfg = deps.config.oidc!;
  const orig = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes('.well-known')) {
      return Response.json({
        authorization_endpoint: 'https://idp.example.com/auth',
        token_endpoint: 'https://idp.example.com/token',
        userinfo_endpoint: 'https://idp.example.com/userinfo',
      });
    }
    if (url.includes('/token')) {
      return Response.json({ access_token: 'tok' });
    }
    if (url.includes('/userinfo')) {
      return Response.json({
        sub: 'sub1',
        name: 'N',
        email: 'n@x.com',
        email_verified: true,
        groups: ['admins'],
      });
    }
    throw new Error('unexpected fetch: ' + url);
  };
  try {
    const id = await exchangeCode(cfg, 'code', 'http://localhost/cb');
    assert.equal(id.sub, 'sub1');
    assert.deepEqual(id.groups, ['admins']);
  } finally {
    globalThis.fetch = orig;
  }
});
