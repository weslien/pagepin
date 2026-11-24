/** 站点成员与组授予 CRUD(设计§6,W3) —— 内存 libSQL + 内存 Storage + 真实 auth 中间件。
 *
 * 覆盖:owner 按 handle 加/列/删成员(改角色 = 原地 UPDATE,不重复行);
 *      角色校验 422(含拒绝 owner —— 站长恒为 sites.ownerId);handle 缺失/类型错/查无 → 404;
 *      成员(非站长)全 403;路人 404(不泄露存在性);组授予 CRUD 同栈;
 *      删站清剪 site_members / group_grants;PAT Bearer 与 Cookie 同口径。
 *
 * 运行:node --import tsx --test test/site-members.test.ts(无外部 DB 时以内存 SQLite 直跑)。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { makeAuthMiddleware } from '../src/api/deps.js';
import { makeSiteRoutes } from '../src/api/sites.js';
import { mint } from '../src/auth/sessions.js';
import { loadConfig } from '../src/config.js';
import { apiTokens, groupGrants, siteMembers, sites, users, type Db } from '../src/db/index.js';
import { NotFoundError } from '../src/storage/index.js';
import type { ObjectMeta, Storage } from '../src/storage/index.js';
import type { AppDeps, AppEnv } from '../src/types.js';
import { nowIso, uuid } from '../src/util.js';
import { makeTestDb } from './helpers/db.js';

const cfg = loadConfig({
  PAGEPIN_SECRET: 'test-secret',
  PAGEPIN_BASE_URL: 'http://localhost:8000',
});
const CSRF = 'test-csrf';
const PAGE_HTML = '<html><head><title>demo</title></head><body><h1>Hello Secret</h1></body></html>';

/** 内存 Storage(同 share-links.test.ts):put 够部署管线用;copy 兜 index 别名。 */
class MemStorage implements Storage {
  private readonly objects = new Map<string, { data: Uint8Array; contentType: string }>();

  async put(
    key: string,
    data: ReadableStream<Uint8Array> | Uint8Array,
    contentType: string,
  ): Promise<void> {
    const bytes =
      data instanceof Uint8Array
        ? data
        : new Uint8Array(await new Response(data as unknown as BodyInit).arrayBuffer());
    this.objects.set(key, { data: bytes, contentType });
  }

  async copy(src: string, dst: string): Promise<void> {
    const o = this.objects.get(src);
    if (!o) throw new NotFoundError(src);
    this.objects.set(dst, o);
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async open(key: string): Promise<{ meta: ObjectMeta; body: ReadableStream<Uint8Array> }> {
    const o = this.objects.get(key);
    if (!o) throw new NotFoundError(key);
    const meta: ObjectMeta = { contentType: o.contentType, contentLength: o.data.byteLength };
    return { meta, body: new Response(o.data as unknown as BodyInit).body! };
  }
}

/** 私有站点一枚:current 版本 + index.html 进内存存储(站长 u-owner / alice)。 */
async function seedSite(db: Db, storage: Storage, slug: string): Promise<void> {
  const vid = uuid();
  await db.insert(sites).values({
    id: `s-${slug}`,
    ownerId: 'u-owner',
    ownerHandle: 'alice',
    slug,
    title: slug,
    visibility: 'private' as const,
    publicExpiresAt: null,
    shareKeyVersion: 1,
    guestComments: true,
    expiresAt: null,
    spaFallback: false,
    commentsEnabled: true,
    currentVersionId: vid,
    versions: [
      {
        id: vid,
        storage_prefix: `sites/u-owner/${slug}/${vid}/`,
        file_count: 1,
        total_bytes: PAGE_HTML.length,
        uploaded_by: 'u-owner',
        created_at: nowIso(),
      },
    ],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    deletedAt: null,
    suspendedAt: null,
    suspendedReason: null,
  });
  await storage.put(
    `sites/u-owner/${slug}/${vid}/index.html`,
    new TextEncoder().encode(PAGE_HTML),
    'text/html; charset=utf-8',
  );
}

async function setup() {
  const db = await makeTestDb();
  const storage = new MemStorage();
  await db.insert(users).values([
    {
      id: 'u-owner',
      email: 'alice@example.com',
      handle: 'alice',
      displayName: 'Alice',
      createdAt: nowIso(),
    },
    {
      id: 'u-bob',
      email: 'bob@example.com',
      handle: 'bob',
      displayName: 'Bob',
      createdAt: nowIso(),
    },
    {
      id: 'u-carol',
      email: 'carol@example.com',
      handle: 'carol',
      displayName: 'Carol',
      createdAt: nowIso(),
    },
    {
      id: 'u-dave',
      email: 'DAVE@Example.com', // 大写 email:搜索须 lower() 后仍命中
      handle: 'dave',
      displayName: 'Dave Long',
      createdAt: nowIso(),
    },
    {
      id: 'u-eve',
      email: 'eve@example.com',
      handle: 'eve',
      displayName: 'Eve',
      disabled: true, // 禁用账号:不出结果
      createdAt: nowIso(),
    },
    {
      id: 'u-frank',
      email: 'frank@example.com',
      handle: null, // handle 未设(OIDC 首登):invite 侧不可用,不出结果
      displayName: 'Frank',
      createdAt: nowIso(),
    },
  ]);
  await seedSite(db, storage, 'demo');
  const deps: AppDeps = { config: cfg, db, storage };
  const app = new Hono<AppEnv>();
  app.route('/', makeSiteRoutes(deps, makeAuthMiddleware(deps)));
  const mk = async (id: string, handle: string) =>
    `pp_session=${await mint(cfg, 'session', id, handle, 0, CSRF)}`;
  return {
    db,
    app,
    ownerCookie: await mk('u-owner', 'alice'),
    bobCookie: await mk('u-bob', 'bob'),
    carolCookie: await mk('u-carol', 'carol'),
  };
}

function api(
  app: Hono<AppEnv>,
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.cookie) {
    headers.cookie = opts.cookie;
    headers['x-csrf-token'] = CSRF;
  }
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return Promise.resolve(
    app.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }),
    ),
  );
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function row(code: string, status: number) {
  return { code, status };
}

interface MemberOut {
  id: string;
  user_id: string;
  handle: string;
  role: string;
  created_at: string;
}

interface GrantOut {
  id: string;
  group_name: string;
  role: string;
  created_at: string;
}

// ───────────────────────── A. 成员 CRUD(站长路径) ─────────────────────────

test('owner member CRUD: add by handle, list, update role in place, remove', async () => {
  const { app, ownerCookie } = await setup();

  const res = await api(app, 'PUT', '/api/sites/demo/members', {
    body: { handle: 'bob', role: 'editor' },
    cookie: ownerCookie,
  });
  assert.equal(res.status, 200);
  const m = (await res.json()) as MemberOut;
  assert.equal(m.user_id, 'u-bob');
  assert.equal(m.handle, 'bob');
  assert.equal(m.role, 'editor');
  assert.ok(m.id);
  assert.ok(m.created_at);

  const list = await api(app, 'GET', '/api/sites/demo/members', { cookie: ownerCookie });
  assert.equal(list.status, 200);
  const { members } = (await list.json()) as { members: MemberOut[] };
  assert.equal(members.length, 1);
  assert.equal(members[0]!.handle, 'bob');
  assert.equal(members[0]!.role, 'editor');

  // 改角色 = 原地 UPDATE:仍一行,角色更新(PUT 幂等 upsert)
  const upd = await api(app, 'PUT', '/api/sites/demo/members', {
    body: { handle: 'bob', role: 'viewer' },
    cookie: ownerCookie,
  });
  assert.equal(upd.status, 200);
  assert.equal(((await upd.json()) as MemberOut).role, 'viewer');
  const after = (await (
    await api(app, 'GET', '/api/sites/demo/members', { cookie: ownerCookie })
  ).json()) as { members: MemberOut[] };
  assert.equal(after.members.length, 1, 'same member row, not a duplicate');
  assert.equal(after.members[0]!.role, 'viewer');

  const del = await api(app, 'DELETE', `/api/sites/demo/members/${m.id}`, {
    cookie: ownerCookie,
  });
  assert.equal(del.status, 200);
  const gone = (await (
    await api(app, 'GET', '/api/sites/demo/members', { cookie: ownerCookie })
  ).json()) as { members: MemberOut[] };
  assert.deepEqual(gone.members, []);

  // 重复删 → 404;跨站删成员 id → 404(成员行绑定站点)
  const again = await api(app, 'DELETE', `/api/sites/demo/members/${m.id}`, {
    cookie: ownerCookie,
  });
  assert.equal(again.status, 404);
  assert.equal(((await again.json()) as { code: string }).code, 'site.members.notFound');
});

test('member add validation: invalid role 422 (incl. owner), unknown/absent handle 404, bad body 422', async () => {
  const { app, ownerCookie } = await setup();

  for (const role of ['chief', 'owner', '', null, 42, undefined]) {
    const r = await api(app, 'PUT', '/api/sites/demo/members', {
      body: { handle: 'bob', role },
      cookie: ownerCookie,
    });
    assert.equal(r.status, 422, `role=${JSON.stringify(role)} rejected`);
    assert.equal(((await r.json()) as { code: string }).code, 'site.members.roleInvalid');
  }

  // handle 缺失 / 类型错 / 查无 → 同一 404 口径
  for (const handle of ['ghost', undefined, null, 42, { x: 1 }]) {
    const r = await api(app, 'PUT', '/api/sites/demo/members', {
      body: { handle, role: 'viewer' },
      cookie: ownerCookie,
    });
    assert.equal(r.status, 404, `handle=${JSON.stringify(handle)} not found`);
    assert.equal(((await r.json()) as { code: string }).code, 'site.members.handleNotFound');
  }

  // 非 JSON body → 422;不存在的站点 → 404 site.notFound
  const bad = await app.fetch(
    new Request('http://localhost/api/sites/demo/members', {
      method: 'PUT',
      headers: { cookie: ownerCookie, 'x-csrf-token': CSRF, 'content-type': 'application/json' },
      body: '{nope',
    }),
  );
  assert.equal(bad.status, 422);
  assert.equal(((await bad.json()) as { code: string }).code, 'request.body.malformed');
  const noSite = await api(app, 'PUT', '/api/sites/ghost-site/members', {
    body: { handle: 'bob', role: 'viewer' },
    cookie: ownerCookie,
  });
  assert.deepEqual(
    row(((await noSite.json()) as { code: string }).code, noSite.status),
    row('site.notFound', 404),
  );
});

test('members routes are owner-only: member 403, stranger 404 on all four', async () => {
  const { db, app, ownerCookie, bobCookie, carolCookie } = await setup();
  // bob 作为 editor 成员(行直接落库,走解析而非 PUT —— PUT 本身就是被测对象)
  await db.insert(siteMembers).values({
    id: uuid(),
    siteId: 's-demo',
    userId: 'u-bob',
    role: 'editor',
    createdAt: nowIso(),
  });

  for (const [method, path] of [
    ['GET', '/api/sites/demo/members'],
    ['GET', '/api/sites/demo/members/search?q=bo'],
    ['PUT', '/api/sites/demo/members'],
    ['DELETE', '/api/sites/demo/members/x'],
  ] as const) {
    const asMember = await api(app, method, path, {
      body: method === 'PUT' ? { handle: 'carol', role: 'viewer' } : undefined,
      cookie: bobCookie,
    });
    assert.equal(asMember.status, 403, `member ${method} ${path} forbidden`);
    assert.equal(((await asMember.json()) as { code: string }).code, 'site.access.forbidden');

    const asStranger = await api(app, method, path, {
      body: method === 'PUT' ? { handle: 'carol', role: 'viewer' } : undefined,
      cookie: carolCookie,
    });
    assert.equal(asStranger.status, 404, `stranger ${method} ${path} invisible`);
    assert.equal(((await asStranger.json()) as { code: string }).code, 'site.notFound');
  }

  // 站长不受成员行影响
  const mine = await api(app, 'GET', '/api/sites/demo/members', { cookie: ownerCookie });
  assert.equal(mine.status, 200);
  assert.equal(((await mine.json()) as { members: MemberOut[] }).members.length, 1);
});

// ───────────────────────── B. 组授予 CRUD(同一模式) ─────────────────────────

test('group-grant CRUD: add, list, update in place, remove; owner role refused', async () => {
  const { app, ownerCookie } = await setup();

  const put = await api(app, 'PUT', '/api/sites/demo/group-grants', {
    body: { group_name: 'eng', role: 'editor' },
    cookie: ownerCookie,
  });
  assert.equal(put.status, 200);
  const g = (await put.json()) as GrantOut;
  assert.equal(g.group_name, 'eng');
  assert.equal(g.role, 'editor');
  assert.ok(g.id);

  const list = await api(app, 'GET', '/api/sites/demo/group-grants', { cookie: ownerCookie });
  assert.equal(list.status, 200);
  const { grants } = (await list.json()) as { grants: GrantOut[] };
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.group_name, 'eng');

  // 同组改角色 = 原地 UPDATE:仍一行
  const upd = await api(app, 'PUT', '/api/sites/demo/group-grants', {
    body: { group_name: 'eng', role: 'commenter' },
    cookie: ownerCookie,
  });
  assert.equal(upd.status, 200);
  assert.equal(((await upd.json()) as GrantOut).role, 'commenter');
  const after = (await (
    await api(app, 'GET', '/api/sites/demo/group-grants', { cookie: ownerCookie })
  ).json()) as { grants: GrantOut[] };
  assert.equal(after.grants.length, 1);

  // 校验:owner 拒(封顶 editor)、组名空 422
  const badRole = await api(app, 'PUT', '/api/sites/demo/group-grants', {
    body: { group_name: 'boss', role: 'owner' },
    cookie: ownerCookie,
  });
  assert.deepEqual(
    row(((await badRole.json()) as { code: string }).code, badRole.status),
    row('site.grants.roleInvalid', 422),
  );
  for (const group_name of ['', '   ', null, 42, undefined]) {
    const r = await api(app, 'PUT', '/api/sites/demo/group-grants', {
      body: { group_name, role: 'viewer' },
      cookie: ownerCookie,
    });
    assert.equal(r.status, 422, `group_name=${JSON.stringify(group_name)} rejected`);
    assert.equal(((await r.json()) as { code: string }).code, 'site.grants.groupNameEmpty');
  }

  // 删 → 空;再删 → 404
  const del = await api(app, 'DELETE', `/api/sites/demo/group-grants/${g.id}`, {
    cookie: ownerCookie,
  });
  assert.equal(del.status, 200);
  const again = await api(app, 'DELETE', `/api/sites/demo/group-grants/${g.id}`, {
    cookie: ownerCookie,
  });
  assert.deepEqual(
    row(((await again.json()) as { code: string }).code, again.status),
    row('site.grants.notFound', 404),
  );
});

test('group-grant routes are owner-only: member 403, stranger 404', async () => {
  const { db, app, bobCookie, carolCookie } = await setup();
  await db.insert(siteMembers).values({
    id: uuid(),
    siteId: 's-demo',
    userId: 'u-bob',
    role: 'editor',
    createdAt: nowIso(),
  });
  for (const [method, path, body] of [
    ['GET', '/api/sites/demo/group-grants', undefined],
    ['PUT', '/api/sites/demo/group-grants', { group_name: 'x', role: 'viewer' }],
    ['DELETE', '/api/sites/demo/group-grants/x', undefined],
  ] as const) {
    const asMember = await api(app, method, path, { body, cookie: bobCookie });
    assert.equal(asMember.status, 403);
    const asStranger = await api(app, method, path, { body, cookie: carolCookie });
    assert.equal(asStranger.status, 404);
  }
});

// ───────────────────────── C. 删站清剪 + PAT 通道 ─────────────────────────

test('site delete prunes site_members and group_grants rows', async () => {
  const { db, app, ownerCookie } = await setup();
  await db.insert(siteMembers).values({
    id: uuid(),
    siteId: 's-demo',
    userId: 'u-bob',
    role: 'editor',
    createdAt: nowIso(),
  });
  await db.insert(groupGrants).values({
    id: uuid(),
    siteId: 's-demo',
    groupName: 'eng',
    role: 'viewer',
    createdBy: 'u-owner',
    createdAt: nowIso(),
  });

  const del = await api(app, 'DELETE', '/api/sites/demo', { cookie: ownerCookie });
  assert.equal(del.status, 200);

  assert.deepEqual(await db.select().from(siteMembers), [], 'site_members pruned');
  assert.deepEqual(await db.select().from(groupGrants), [], 'group_grants pruned');
});

test('PAT bearer manages members and grants the same as cookies', async () => {
  const { db, app } = await setup();
  const pat = 'pp_' + 'm'.repeat(40);
  await db.insert(apiTokens).values({
    id: uuid(),
    userId: 'u-owner',
    name: 'test-token',
    tokenHash: await sha256Hex(pat),
    prefix: pat.slice(0, 15),
    createdAt: nowIso(),
  });

  const put = await api(app, 'PUT', '/api/sites/demo/members', {
    body: { handle: 'bob', role: 'editor' },
    bearer: pat,
  });
  assert.equal(put.status, 200);
  assert.equal(((await put.json()) as MemberOut).role, 'editor');

  const list = await api(app, 'GET', '/api/sites/demo/members', { bearer: pat });
  assert.equal(list.status, 200);
  assert.equal(((await list.json()) as { members: MemberOut[] }).members.length, 1);

  const grant = await api(app, 'PUT', '/api/sites/demo/group-grants', {
    body: { group_name: 'eng', role: 'viewer' },
    bearer: pat,
  });
  assert.equal(grant.status, 200);
  assert.equal(((await grant.json()) as GrantOut).group_name, 'eng');
});

// ───────────────────────── C. 成员搜索(owner-only 下拉数据源) ─────────────────────────

interface SearchOut {
  handle: string;
  display_name: string | null;
}

async function search(
  app: Hono<AppEnv>,
  q: string,
  cookie: string,
): Promise<{ status: number; results: SearchOut[] }> {
  const res = await api(app, 'GET', `/api/sites/demo/members/search?q=${encodeURIComponent(q)}`, {
    cookie,
  });
  return {
    status: res.status,
    results: res.ok ? ((await res.json()) as { results: SearchOut[] }).results : [],
  };
}

test('member search: handle/display_name/email substrings, privacy filters, field shape', async () => {
  const { app, ownerCookie } = await setup();

  // handle 子串
  const byHandle = await search(app, 'ob', ownerCookie);
  assert.equal(byHandle.status, 200);
  assert.deepEqual(
    byHandle.results.map((r) => r.handle),
    ['bob'],
  );

  // display_name 子串(大小写不敏感:q 大写仍命中)
  const byName = await search(app, 'LONG', ownerCookie);
  assert.deepEqual(
    byName.results.map((r) => r.handle),
    ['dave'],
  );

  // email 子串(存储侧大写 email;lower() 后命中;返回体里绝不出现 email 字段)
  const byEmail = await search(app, 'dave@example', ownerCookie);
  assert.deepEqual(
    byEmail.results.map((r) => r.handle),
    ['dave'],
  );
  assert.deepEqual(Object.keys(byEmail.results[0]!).sort(), ['display_name', 'handle']);
  assert.equal(byEmail.results[0]!.display_name, 'Dave Long');

  // 隐私:禁用账号(eve)、handle 未设(frank,email 命中也不出)、本人(alice)都不出
  for (const q of ['ev', 'fran', 'ali']) {
    const r = await search(app, q, ownerCookie);
    assert.equal(r.results.length, 0, `q=${q} must return nothing`);
  }

  // 至少 2 个字符;无 q 参数同口径
  for (const q of ['', 'a', '  b ']) {
    const r = await search(app, q, ownerCookie);
    assert.equal(r.status, 200);
    assert.equal(r.results.length, 0, `q=${JSON.stringify(q)} stays under the 2-char floor`);
  }
  const noParam = await api(app, 'GET', '/api/sites/demo/members/search', {
    cookie: ownerCookie,
  });
  assert.equal(noParam.status, 200);
  assert.deepEqual(((await noParam.json()) as { results: unknown[] }).results, []);

  // 未知站点 → 404 site.notFound
  const missing = await api(app, 'GET', '/api/sites/nope/members/search?q=bo', {
    cookie: ownerCookie,
  });
  assert.equal(missing.status, 404);

  // LIKE 通配符是通配符,不是错误
  const wild = await api(app, 'GET', '/api/sites/demo/members/search?q=%25_%25', {
    cookie: ownerCookie,
  });
  assert.equal(wild.status, 200);
  assert.deepEqual(
    ((await wild.json()) as { results: SearchOut[] }).results.map((x) => x.handle),
    ['bob', 'carol', 'dave'],
    'wildcards act as wildcards, not errors',
  );
});

test('member search: max 8 results, ordered by handle', async () => {
  const { db, app, ownerCookie } = await setup();
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: `u-zz${i}`,
    email: `zz${i}@example.com`,
    handle: `zzuser${String(i).padStart(2, '0')}`,
    displayName: `Bulk User ${i}`,
    createdAt: nowIso(),
  }));
  await db.insert(users).values(rows);
  const r = await search(app, 'zzuser', ownerCookie);
  assert.equal(r.results.length, 8, 'LIMIT 8 caps the result set');
  assert.deepEqual(
    r.results.map((x) => x.handle),
    Array.from({ length: 8 }, (_, i) => `zzuser${String(i).padStart(2, '0')}`),
    'first 8 handles, ordered by handle asc',
  );
});
