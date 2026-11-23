/** 能力解析矩阵 + 配额归属 + 同名 slug 歧义 + open 模式快照(设计§6-§7,W3)。
 *
 * 内存量 libSQL + 内存 Storage + 真实 auth;单域组装(控制台 + 评论平面 + serving)。
 * 覆盖(对 W3 重排后的十七个 owner 路由,按 seam 表「members 模式最小值」):
 *   owner 全通(your_role=owner);editor 可部署/回滚/resolve,管理类 403;
 *   commenter 可 reply、resolve 403(editor + 起)、部署 403;
 *   viewer 只读写类(reply/resolve/部署/管理全 403,读类 200);
 *   组授予经 user_groups 贯通解析(owner 级授予在解析侧封顶 editor);
 *   同名 slug 双站长且用户两站皆成员 → 403 ambiguous;own site 恒先于可访问站点;
 *   editor 部署配额记「目标站点站长」账(三步证明:本人满员、editor 超限、路人独立);
 *   open 模式快照:登录非成员内容面可看可评、控制台保持 404、新 slug / 已被他人占用 slug
 *   的部署仍是自建站 —— W3 改解析不改行为,W4 翻模式前无回归。
 *
 * 运行:node --import tsx --test test/site-members-access.test.ts(无外部 DB 时以内存 SQLite 直跑)。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';

import { Hono } from 'hono';

import { makeAdminRoutes } from '../src/api/admin.js';
import { makeAuthMiddleware } from '../src/api/deps.js';
import { makeSiteRoutes } from '../src/api/sites.js';
import { mint } from '../src/auth/sessions.js';
import { makeCommentRoutes } from '../src/comments.js';
import { loadConfig } from '../src/config.js';
import { groupGrants, siteMembers, sites, userGroups, users, type Db } from '../src/db/index.js';
import { makeServingRoutes } from '../src/serving.js';
import { NotFoundError } from '../src/storage/index.js';
import type { ObjectMeta, Storage } from '../src/storage/index.js';
import type { AppDeps, AppEnv } from '../src/types.js';
import { nowIso, uuid } from '../src/util.js';
import { makeTestDb } from './helpers/db.js';

const CSRF = 'test-csrf';
const PAGE_HTML = '<html><head><title>demo</title></head><body><h1>Hello Secret</h1></body></html>';

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

/** 私有站点一枚:current 版本 + index.html;owner 可指定(测同名 slug / own-first 用)。 */
async function seedSite(
  db: Db,
  storage: Storage,
  slug: string,
  ownerId = 'u-owner',
  ownerHandle = 'alice',
): Promise<string> {
  const id = `s-${ownerHandle}-${slug}`;
  const vid = uuid();
  await db.insert(sites).values({
    id,
    ownerId,
    ownerHandle,
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
        storage_prefix: `sites/${ownerId}/${slug}/${vid}/`,
        file_count: 1,
        total_bytes: PAGE_HTML.length,
        uploaded_by: ownerId,
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
    `sites/${ownerId}/${slug}/${vid}/index.html`,
    new TextEncoder().encode(PAGE_HTML),
    'text/html; charset=utf-8',
  );
  return id;
}

/** 单域组装(顺序对齐 app.ts):控制台 API → 评论 API → serving。 */
async function setup(env: Record<string, string> = {}) {
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
      id: 'u-dan',
      email: 'dan@example.com',
      handle: 'dan',
      displayName: 'Dan',
      createdAt: nowIso(),
    },
    {
      id: 'u-eve',
      email: 'eve@example.com',
      handle: 'eve',
      displayName: 'Eve',
      createdAt: nowIso(),
    },
    {
      id: 'u-frank',
      email: 'frank@example.com',
      handle: 'frank',
      displayName: 'Frank',
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
      id: 'u-zoe',
      email: 'zoe@example.com',
      handle: 'zoe',
      displayName: 'Zoe',
      createdAt: nowIso(),
    },
    {
      id: 'u-admin',
      email: 'admin@example.com',
      handle: 'admin',
      displayName: 'Admin',
      isAdmin: true,
      createdAt: nowIso(),
    },
  ]);
  const demoId = await seedSite(db, storage, 'demo');
  const otherId = await seedSite(db, storage, 'other');
  const cfg = loadConfig({
    PAGEPIN_SECRET: 'test-secret',
    PAGEPIN_BASE_URL: 'http://localhost:8000',
    ...env,
  });
  const deps: AppDeps = { config: cfg, db, storage };
  const app = new Hono<AppEnv>();
  app.route('/', makeSiteRoutes(deps, makeAuthMiddleware(deps)));
  app.route('/', makeAdminRoutes(deps, makeAuthMiddleware(deps)));
  app.route('/', makeCommentRoutes(deps));
  app.route('/', makeServingRoutes(deps));
  const cookie = async (id: string, handle: string) =>
    `pp_session=${await mint(cfg, 'session', id, handle, 0, CSRF)}`;
  return {
    db,
    storage,
    cfg,
    app,
    demoId,
    otherId,
    alice: await cookie('u-owner', 'alice'),
    bob: await cookie('u-bob', 'bob'),
    dan: await cookie('u-dan', 'dan'),
    eve: await cookie('u-eve', 'eve'),
    frank: await cookie('u-frank', 'frank'),
    carol: await cookie('u-carol', 'carol'),
    zoe: await cookie('u-zoe', 'zoe'),
    admin: await cookie('u-admin', 'admin'),
  };
}

function api(
  app: Hono<AppEnv>,
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.cookie) {
    headers.cookie = opts.cookie;
    headers['x-csrf-token'] = CSRF;
  }
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

/** multipart 单文件部署;bytes 为数字时填等长 'x'。 */
function deployForm(
  app: Hono<AppEnv>,
  cookie: string,
  slug: string,
  bytes: number,
): Promise<Response> {
  const fd = new FormData();
  fd.append('files', new File(['x'.repeat(bytes)], 'index.html'));
  fd.append('paths', 'index.html');
  return Promise.resolve(
    app.fetch(
      new Request(`http://localhost/api/sites/${slug}/deploy`, {
        method: 'POST',
        headers: { cookie, 'x-csrf-token': CSRF },
        body: fd,
      }),
    ),
  );
}

async function addMember(
  db: Db,
  siteId: string,
  userId: string,
  role: 'editor' | 'commenter' | 'viewer',
) {
  await db.insert(siteMembers).values({
    id: uuid(),
    siteId,
    userId,
    role,
    createdAt: nowIso(),
  });
}

async function addGrant(
  db: Db,
  siteId: string,
  userId: string,
  groupName: string,
  role: 'editor' | 'commenter' | 'viewer' | 'owner',
) {
  await db.insert(userGroups).values({ userId, groupName, syncedAt: nowIso() });
  await db.insert(groupGrants).values({
    id: uuid(),
    siteId,
    groupName,
    role,
    createdBy: 'u-owner',
    createdAt: nowIso(),
  });
}

function threadBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: 'index.html',
    selector: '#h1',
    rx: 0.5,
    ry: 0.5,
    rw: null,
    rh: null,
    kind: null,
    anchor_text: null,
    text: 'first comment',
    ...over,
  };
}

/** 在内容平面(登录人人均可)开一条线程,返回 id。 */
async function createThread(app: Hono<AppEnv>, cookie: string): Promise<string> {
  const res = await api(app, 'POST', '/api/comments/alice/demo', {
    body: threadBody(),
    cookie,
  });
  assert.equal(res.status, 200, 'thread created on the content plane');
  return ((await res.json()) as { id: string }).id;
}

async function roleOf(app: Hono<AppEnv>, cookie: string, slug: string): Promise<string> {
  const res = await api(app, 'GET', `/api/sites/${slug}`, { cookie });
  assert.equal(res.status, 200);
  return ((await res.json()) as { your_role: string }).your_role;
}

// ───────────────────────── 1. owner:十七路由照旧,响应带 your_role ─────────────────────────

test('owner resolution: every route keeps working, your_role=owner on siteOut payloads', async () => {
  const s = await setup();
  const tid = await createThread(s.app, s.alice);

  // 读类
  for (const path of ['/api/sites/demo', '/api/sites/demo/versions', '/api/sites/demo/comments']) {
    const r = await api(s.app, 'GET', path, { cookie: s.alice });
    assert.equal(r.status, 200, `GET ${path}`);
  }
  assert.equal(await roleOf(s.app, s.alice, 'demo'), 'owner');

  // 管理类
  const patch = await api(s.app, 'PATCH', '/api/sites/demo', {
    body: { title: 'Renamed' },
    cookie: s.alice,
  });
  assert.equal(patch.status, 200);
  const patched = (await patch.json()) as { title: string; your_role: string };
  assert.equal(patched.title, 'Renamed');
  assert.equal(patched.your_role, 'owner');

  const share = await api(s.app, 'POST', '/api/sites/demo/share-link', {
    body: {},
    cookie: s.alice,
  });
  assert.equal(share.status, 200);
  assert.equal(
    (await api(s.app, 'GET', '/api/sites/demo/share-links', { cookie: s.alice })).status,
    200,
  );
  assert.equal(
    (await api(s.app, 'DELETE', '/api/sites/demo/share-link', { cookie: s.alice })).status,
    200,
  );

  // 部署族
  const dep = await deployForm(s.app, s.alice, 'demo', 100);
  assert.equal(dep.status, 200);
  assert.equal(((await dep.json()) as { your_role: string }).your_role, 'owner');

  const resolve = await api(s.app, 'PATCH', `/api/sites/demo/comments/${tid}`, {
    body: { resolved: true },
    cookie: s.alice,
  });
  assert.equal(resolve.status, 200);
  assert.equal(((await resolve.json()) as { resolved: boolean }).resolved, true);

  const reply = await api(s.app, 'POST', `/api/sites/demo/comments/${tid}/replies`, {
    body: { text: 'done' },
    cookie: s.alice,
  });
  assert.equal(reply.status, 200);

  const versions = (await (
    await api(s.app, 'GET', '/api/sites/demo/versions', { cookie: s.alice })
  ).json()) as { current: string | null; versions: { id: string }[] };
  const rollback = await api(s.app, 'POST', '/api/sites/demo/rollback', {
    body: { version_id: versions.versions[0]!.id },
    cookie: s.alice,
  });
  assert.equal(rollback.status, 200);

  // 删站(b 站不污染本测试)
  assert.equal((await api(s.app, 'DELETE', '/api/sites/other', { cookie: s.alice })).status, 200);
});

// ───────────────────────── 2. editor 部署/回滚;管理 403;不成影建 ─────────────────────────

test('editor resolution: deploy/read/edit-thread ok; manage 403; no shadow site created', async () => {
  const s = await setup();
  await addMember(s.db, s.demoId, 'u-bob', 'editor');
  const tid = await createThread(s.app, s.alice);

  const dep = await deployForm(s.app, s.bob, 'demo', 100);
  assert.equal(dep.status, 200, 'editor deploys onto the owner site');
  const depBody = (await dep.json()) as { your_role: string; url: string };
  assert.equal(depBody.your_role, 'editor');
  assert.ok(depBody.url.includes('/alice/demo'), 'published into the owner site, not a shadow');
  assert.deepEqual(
    await s.db
      .select()
      .from(sites)
      .then((rows) => rows.filter((x) => x.ownerId === 'u-bob')),
    [],
    'no shadow site row for the editor',
  );

  assert.equal(await roleOf(s.app, s.bob, 'demo'), 'editor');
  for (const path of ['/api/sites/demo/versions', '/api/sites/demo/comments']) {
    assert.equal((await api(s.app, 'GET', path, { cookie: s.bob })).status, 200, `GET ${path}`);
  }

  // 线程:editor 可 resolve( seam 表 editor+起的两处)
  assert.equal(
    (
      await api(s.app, 'PATCH', `/api/sites/demo/comments/${tid}`, {
        body: { resolved: true },
        cookie: s.bob,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await api(s.app, 'POST', `/api/sites/demo/comments/${tid}/replies`, {
        body: { text: 'editor note' },
        cookie: s.bob,
      })
    ).status,
    200,
  );

  // 回滚 = 部署族(editor+)
  const versions = (await (
    await api(s.app, 'GET', '/api/sites/demo/versions', { cookie: s.bob })
  ).json()) as { versions: { id: string }[] };
  assert.equal(
    (
      await api(s.app, 'POST', '/api/sites/demo/rollback', {
        body: { version_id: versions.versions[0]!.id },
        cookie: s.bob,
      })
    ).status,
    200,
  );

  // 管理类全 403(角色不足,站点已解析 → forbidden 而非 404)
  const forbidden = [
    ['PATCH', '/api/sites/demo', { title: 'Nope' }],
    ['POST', '/api/sites/demo/share-link', {}],
    ['GET', '/api/sites/demo/share-links', undefined],
    ['DELETE', '/api/sites/demo/share-link', undefined],
    ['DELETE', '/api/sites/demo', undefined],
    ['GET', '/api/sites/demo/members', undefined],
    ['PUT', '/api/sites/demo/members', { handle: 'dan', role: 'viewer' }],
    ['GET', '/api/sites/demo/group-grants', undefined],
    ['PUT', '/api/sites/demo/group-grants', { group_name: 'x', role: 'viewer' }],
  ] as const;
  for (const [method, path, body] of forbidden) {
    const r = await api(s.app, method, path, { body, cookie: s.bob });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(((await r.json()) as { code: string }).code, 'site.access.forbidden');
  }
});

// ───────────── 3. commenter:reply 开;resolve/部署 403(BVP 修正行:resolve 是 editor+ ─────────────

test('commenter resolution: reply ok; thread resolve 403 (editor and up); deploy 403; reads ok', async () => {
  const s = await setup();
  await addMember(s.db, s.demoId, 'u-dan', 'commenter');
  const tid = await createThread(s.app, s.alice);

  assert.equal(
    (
      await api(s.app, 'POST', `/api/sites/demo/comments/${tid}/replies`, {
        body: { text: 'noted' },
        cookie: s.dan,
      })
    ).status,
    200,
    'commenter replies',
  );

  for (const [method, path, body] of [
    ['PATCH', `/api/sites/demo/comments/${tid}`, { resolved: true }],
    ['POST', '/api/sites/demo/deploy', undefined],
    ['PATCH', '/api/sites/demo', { title: 'Nope' }],
  ] as const) {
    const r =
      method === 'POST' && path.endsWith('deploy')
        ? await deployForm(s.app, s.dan, 'demo', 100)
        : await api(s.app, method, path, { body, cookie: s.dan });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(((await r.json()) as { code: string }).code, 'site.access.forbidden');
  }

  assert.equal(await roleOf(s.app, s.dan, 'demo'), 'commenter');
  for (const path of ['/api/sites/demo/versions', '/api/sites/demo/comments']) {
    assert.equal((await api(s.app, 'GET', path, { cookie: s.dan })).status, 200, `GET ${path}`);
  }
});

// ───────────────────────── 4. viewer:本波只读(读类 200,写类全 403) ─────────────────────────

test('viewer resolution: read-only in this wave', async () => {
  const s = await setup();
  await addMember(s.db, s.demoId, 'u-eve', 'viewer');
  const tid = await createThread(s.app, s.alice);

  assert.equal(await roleOf(s.app, s.eve, 'demo'), 'viewer');
  for (const path of ['/api/sites/demo/versions', '/api/sites/demo/comments']) {
    assert.equal((await api(s.app, 'GET', path, { cookie: s.eve })).status, 200, `GET ${path}`);
  }
  for (const [method, path, body] of [
    ['POST', `/api/sites/demo/comments/${tid}/replies`, { text: 'no' }],
    ['PATCH', `/api/sites/demo/comments/${tid}`, { resolved: true }],
    ['PATCH', '/api/sites/demo', { title: 'Nope' }],
  ] as const) {
    const r = await api(s.app, method, path, { body, cookie: s.eve });
    assert.equal(r.status, 403, `viewer ${method} ${path}`);
    assert.equal(((await r.json()) as { code: string }).code, 'site.access.forbidden');
  }
  assert.equal((await deployForm(s.app, s.eve, 'demo', 100)).status, 403);
});

// ───────────────────────── 5. 组授予贯通;owner 级授予解析侧封顶 editor ─────────────────────────

test('group grant resolves through user_groups; an owner-role grant caps to editor', async () => {
  const s = await setup();
  await addGrant(s.db, s.demoId, 'u-frank', 'eng', 'editor');

  const dep = await deployForm(s.app, s.frank, 'demo', 100);
  assert.equal(dep.status, 200, 'grant-holder deploys through the grant');
  assert.equal(((await dep.json()) as { your_role: string }).your_role, 'editor');

  // 直插 owner 级授予(越权写侧本应拒绝,直插验证解析侧封顶不停摆)
  await addGrant(s.db, s.otherId, 'u-frank', 'boss', 'owner');
  assert.equal(await roleOf(s.app, s.frank, 'other'), 'editor', 'owner grant resolves as editor');
  const patch = await api(s.app, 'PATCH', '/api/sites/other', {
    body: { title: 'Leaked?' },
    cookie: s.frank,
  });
  assert.equal(patch.status, 403, 'capped editor cannot manage');
  assert.equal(((await patch.json()) as { code: string }).code, 'site.access.forbidden');
});

// ───────────────────────── 6. 歧义与 own-first ─────────────────────────

test('ambiguity: member of two same-slug sites gets 403 everywhere; owners unaffected', async () => {
  const s = await setup();
  const zoeDemo = await seedSite(s.db, s.storage, 'demo', 'u-zoe', 'zoe');
  await addMember(s.db, s.demoId, 'u-bob', 'editor');
  await addMember(s.db, zoeDemo, 'u-bob', 'viewer');

  for (const [method, path, body] of [
    ['GET', '/api/sites/demo', undefined],
    ['GET', '/api/sites/demo/versions', undefined],
    ['GET', '/api/sites/demo/comments', undefined],
    ['PATCH', '/api/sites/demo', { title: 'x' }],
    ['GET', '/api/sites/demo/members', undefined],
  ] as const) {
    const r = await api(s.app, method, path, { body, cookie: s.bob });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(((await r.json()) as { code: string }).code, 'site.access.ambiguous');
  }
  // 部署同样歧义 403,不落入建站路径(不产生任何站点)
  assert.equal((await deployForm(s.app, s.bob, 'demo', 100)).status, 403);

  // 站长本人不受影响(own site 优先,不进候选歧义)
  assert.equal(await roleOf(s.app, s.alice, 'demo'), 'owner');
  assert.equal(await roleOf(s.app, s.zoe, 'demo'), 'owner');
});

test('own site wins over the accessible same-slug site', async () => {
  const s = await setup();
  const bobDemo = await seedSite(s.db, s.storage, 'demo', 'u-bob', 'bob');
  await addMember(s.db, s.demoId, 'u-bob', 'editor');

  const dep = await deployForm(s.app, s.bob, 'demo', 100);
  assert.equal(dep.status, 200);
  const depBody = (await dep.json()) as { your_role: string; url: string };
  assert.equal(depBody.your_role, 'owner', 'resolver picks the own site first');
  assert.ok(depBody.url.includes('/bob/demo'));

  // own-first 意味着控制台操作落在自己站上(成员列表是自己的,不含 alice 站的成员行)
  const members = (await (
    await api(s.app, 'GET', '/api/sites/demo/members', { cookie: s.bob })
  ).json()) as { members: { user_id: string }[] };
  assert.deepEqual(members.members, [], 'own members list, not the other same-slug site');
  assert.equal(
    (await api(s.app, 'PATCH', '/api/sites/demo', { body: { title: 'Mine' }, cookie: s.bob }))
      .status,
    200,
  );
  assert.ok(bobDemo.length > 0);
});

// ───────────── 7. 配额:editor 部署记目标站点站长的账(设计§6 三步证明) ─────────────

test('editor deploys charge the site owner quota, not the editor (proof at FREE_USER_MB=1)', async () => {
  const s = await setup({ PAGEPIN_FREE_USER_MB: '1' });
  await addMember(s.db, s.demoId, 'u-bob', 'editor');

  // (a) 站长把 demo 接近满额(种子版 ~PAGE_HTML.length B)
  assert.equal((await deployForm(s.app, s.alice, 'demo', 900_000)).status, 200);

  // (b) editor 追加 600KB → 记站长账 → 超额 413。若记 editor 自己的账(空账)则必过。
  const big = await deployForm(s.app, s.bob, 'demo', 600_000);
  assert.equal(big.status, 413);
  assert.equal(((await big.json()) as { code: string }).code, 'site.quota.exceeded');

  // (c) 路人无行,部署自家新 slug 600KB → 200(证明 (b) 不是全局抑制)
  const carolDeploy = await deployForm(s.app, s.carol, 'carol-fresh', 600_000);
  assert.equal(carolDeploy.status, 200);
  assert.ok(
    ((await carolDeploy.json()) as { url: string }).url.includes('/carol/carol-fresh'),
    'non-member deploy still creates their own site (v0.3.0)',
  );

  // (d) editor 小剂量补进站长账;随后站长在 b 站再部署即超额 —— 证明 editor 的字节计入站长账
  assert.equal((await deployForm(s.app, s.bob, 'demo', 100_000)).status, 200);
  const aliceOther = await deployForm(s.app, s.alice, 'other', 300_000);
  assert.equal(aliceOther.status, 413);
  assert.equal(((await aliceOther.json()) as { code: string }).code, 'site.quota.exceeded');
});

// ───────────────────────── 8. open 模式快照:登录非成员 = v0.3.0 行为 ─────────────────────────

test('open-mode snapshot: logged-in non-member still views, comments, and console-404s as v0.3.0', async () => {
  const s = await setup();
  const tid = await createThread(
    s.app,
    s.carol,
    'carol creates the thread as any logged-in viewer',
  );

  // 内容面:serving 放行 + 注入评论层;评论平面建线程/读列表
  const page = await s.app.fetch(
    new Request('http://localhost/p/alice/demo/', {
      headers: { accept: 'text/html', cookie: s.carol },
    }),
  );
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('Hello Secret'), 'content plane still serves the non-member');
  assert.ok(html.includes('/_pagepin/comments.js'), 'overlay still injects');
  const planeList = await api(s.app, 'GET', '/api/comments/alice/demo?path=index.html', {
    cookie: s.carol,
  });
  assert.equal(planeList.status, 200);
  assert.equal(((await planeList.json()) as { threads: unknown[] }).threads.length, 1);

  // 控制台:不解析 → 404(与 v0.3.0 的 ownedSite 口径一致,含 key)
  for (const [method, path, body] of [
    ['GET', '/api/sites/demo', undefined],
    ['GET', '/api/sites/demo/versions', undefined],
    ['GET', '/api/sites/demo/comments', undefined],
    ['GET', '/api/sites/demo/share-links', undefined],
    ['GET', '/api/sites/demo/members', undefined],
    ['PUT', '/api/sites/demo/members', { handle: 'bob', role: 'viewer' }],
    ['PUT', '/api/sites/demo/group-grants', { group_name: 'x', role: 'viewer' }],
    ['PATCH', '/api/sites/demo', { title: 'Nope' }],
    ['POST', '/api/sites/demo/share-link', {}],
    ['DELETE', '/api/sites/demo', undefined],
    ['PATCH', `/api/sites/demo/comments/${tid}`, { resolved: true }],
    ['POST', `/api/sites/demo/comments/${tid}/replies`, { text: 'no' }],
  ] as const) {
    const r = await api(s.app, method, path, { body, cookie: s.carol });
    assert.equal(r.status, 404, `console ${method} ${path} keeps v0.3.0 invisibility`);
    assert.equal(((await r.json()) as { code: string }).code, 'site.notFound');
  }

  // 建站路径不收窄:非成员部署已占用的 slug 仍自建同名站(v0.3.0 同款)
  const dep = await deployForm(s.app, s.carol, 'demo', 100);
  assert.equal(dep.status, 200);
  const depBody = (await dep.json()) as { your_role: string; url: string };
  assert.equal(depBody.your_role, 'owner');
  assert.ok(depBody.url.includes('/carol/demo'));
  const live = await s.db
    .select()
    .from(sites)
    .then((rows) => rows.filter((x) => x.slug === 'demo'));
  assert.equal(live.length, 2, 'alice demo + carol demo coexist as in v0.3.0');
});

// ───────────────────────── 9. W4: members-mode serving gate (design §4/§6, D2 ruling) ─────────────────────────

/** Flip the instance site access mode through the real admin write path (the flip itself stays under test). */
async function setMode(s: { app: Hono<AppEnv>; admin: string }, mode: 'open' | 'members') {
  const res = await api(s.app, 'PATCH', '/api/admin/settings', {
    body: { site_access_mode: mode },
    cookie: s.admin,
  });
  assert.equal(res.status, 200, `admin PATCH site_access_mode=${mode}`);
  assert.equal(((await res.json()) as { site_access_mode: string }).site_access_mode, mode);
}

/** Content-plane page GET (single-domain /p/<owner>/<slug>/), optional cookie. */
async function contentFetch(
  app: Hono<AppEnv>,
  owner: string,
  slug: string,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = { accept: 'text/html' };
  if (cookie) headers.cookie = cookie;
  return app.fetch(new Request(`http://localhost/p/${owner}/${slug}/`, { headers }));
}

/** Mint + redeem a share link like a browser guest; returns the Set-Cookie pairs to replay. */
async function redeemShareGuest(app: Hono<AppEnv>, ownerCookie: string): Promise<string> {
  const share = await api(app, 'POST', '/api/sites/demo/share-link', {
    body: {},
    cookie: ownerCookie,
  });
  assert.equal(share.status, 200);
  const code = ((await share.json()) as { code: string }).code;
  const redeem = await app.fetch(
    new Request(`http://localhost/p/s/${code}`, { headers: { accept: 'text/html' } }),
  );
  assert.equal(redeem.status, 303);
  const pairs = redeem.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .filter(Boolean);
  assert.ok(pairs.length > 0, 'share session cookie set on redeem');
  return pairs.join('; ');
}

test('members mode serving: anonymous private-site hit still gets the login wall, not the D2 page', async () => {
  const s = await setup();
  await setMode(s, 'members');
  const wall = await contentFetch(s.app, 'alice', 'demo');
  assert.equal(wall.status, 200);
  const html = await wall.text();
  assert.ok(html.includes('This page is private'), 'the wall variant renders');
  assert.ok(
    !html.includes('You do not have access'),
    'the D2 403 variant stays away for anonymous',
  );
  assert.ok(!html.includes('Hello Secret'), 'no content ship to anonymous');
});

test('members mode D2: signed-in non-member gets the 403 access-denied page (slug named, wall absent)', async () => {
  const s = await setup();
  await setMode(s, 'members');
  const page = await contentFetch(s.app, 'alice', 'demo', s.carol);
  assert.equal(page.status, 403);
  const html = await page.text();
  assert.ok(html.includes('You do not have access to this site'), 'D2 heading renders');
  assert.ok(
    html.includes('<span class="mono teal">demo</span>'),
    'slug named — no existence-hiding',
  );
  assert.ok(!html.includes('This page is private'), 'not the login wall');
  assert.ok(!html.includes('Hello Secret'), 'no content bytes ship');
  assert.ok((page.headers.get('cache-control') ?? '').includes('no-store'));
  assert.equal(page.headers.get('x-pagepin-site'), 'alice/demo');
});

test('members mode serving: owner/editor/commenter see content with overlay; viewer member sees content without overlay', async () => {
  const s = await setup();
  await addMember(s.db, s.demoId, 'u-bob', 'editor');
  await addMember(s.db, s.demoId, 'u-dan', 'commenter');
  await addMember(s.db, s.demoId, 'u-eve', 'viewer');
  await setMode(s, 'members');

  for (const [name, cookie] of [
    ['owner', s.alice],
    ['editor', s.bob],
    ['commenter', s.dan],
  ] as const) {
    const page = await contentFetch(s.app, 'alice', 'demo', cookie);
    assert.equal(page.status, 200, `${name} serves`);
    const html = await page.text();
    assert.ok(html.includes('Hello Secret'), `${name} sees content`);
    assert.ok(
      html.includes('/_pagepin/comments.js'),
      `${name} gets the overlay (commenter and up)`,
    );
  }
  const viewerPage = await contentFetch(s.app, 'alice', 'demo', s.eve);
  assert.equal(viewerPage.status, 200);
  const viewerHtml = await viewerPage.text();
  assert.ok(viewerHtml.includes('Hello Secret'), 'viewer member sees content');
  assert.ok(!viewerHtml.includes('/_pagepin/comments.js'), 'viewer member gets no overlay');
});

test('members mode serving: group grants resolve on the content plane like member rows', async () => {
  const s = await setup();
  await addGrant(s.db, s.demoId, 'u-frank', 'eng', 'viewer');
  await addGrant(s.db, s.demoId, 'u-zoe', 'ops', 'commenter');
  await setMode(s, 'members');

  const frankPage = await contentFetch(s.app, 'alice', 'demo', s.frank);
  assert.equal(frankPage.status, 200, 'granted viewer serves');
  assert.ok(
    !(await frankPage.text()).includes('/_pagepin/comments.js'),
    'granted viewer: no overlay',
  );

  const zoePage = await contentFetch(s.app, 'alice', 'demo', s.zoe);
  assert.equal(zoePage.status, 200, 'granted commenter serves');
  assert.ok((await zoePage.text()).includes('/_pagepin/comments.js'), 'granted commenter: overlay');
});

test('members mode serving: share-guest redeem still serves and injects (guestComments rules unchanged)', async () => {
  const s = await setup();
  await setMode(s, 'members');
  const guestCookie = await redeemShareGuest(s.app, s.alice);
  const page = await contentFetch(s.app, 'alice', 'demo', guestCookie);
  assert.equal(page.status, 200, 'share-guest serves (revocable share scope, not membership)');
  const html = await page.text();
  assert.ok(html.includes('Hello Secret'), 'guest sees content');
  assert.ok(html.includes('/_pagepin/comments.js'), 'guest keeps the overlay under guestComments');
});

test('members mode serving: public window serves everyone; logged-in non-member sees content but no overlay', async () => {
  const s = await setup();
  await addMember(s.db, s.demoId, 'u-dan', 'commenter');
  await s.db
    .update(sites)
    .set({
      visibility: 'public',
      publicExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })
    .where(eq(sites.id, s.demoId));
  await setMode(s, 'members');

  const anon = await contentFetch(s.app, 'alice', 'demo');
  assert.equal(anon.status, 200, 'public window: anonymous serves');
  const anonHtml = await anon.text();
  assert.ok(anonHtml.includes('Hello Secret'));
  assert.ok(!anonHtml.includes('/_pagepin/comments.js'), 'anonymous public stays clean');

  const carolPage = await contentFetch(s.app, 'alice', 'demo', s.carol);
  assert.equal(carolPage.status, 200, 'public window: non-member serves');
  const carolHtml = await carolPage.text();
  assert.ok(carolHtml.includes('Hello Secret'));
  assert.ok(
    !carolHtml.includes('/_pagepin/comments.js'),
    'non-member gets no overlay in members mode',
  );

  const danPage = await contentFetch(s.app, 'alice', 'demo', s.dan);
  assert.ok(
    (await danPage.text()).includes('/_pagepin/comments.js'),
    'member commenter keeps overlay',
  );
});

test('admin flip is live at the serving seam: same path 200 → 403 → 200', async () => {
  const s = await setup();
  assert.equal((await contentFetch(s.app, 'alice', 'demo', s.carol)).status, 200);
  await setMode(s, 'members');
  assert.equal((await contentFetch(s.app, 'alice', 'demo', s.carol)).status, 403);
  await setMode(s, 'open');
  assert.equal((await contentFetch(s.app, 'alice', 'demo', s.carol)).status, 200);
});

// ───────────────────────── 10. W4: thread-route content minimums (members mode) ─────────────────────────

test('members mode thread routes: GET threads (viewer+): member 200, anonymous 401, non-member 403', async () => {
  const s = await setup();
  await addMember(s.db, s.demoId, 'u-eve', 'viewer');
  const tid = await createThread(s.app, s.alice);
  await setMode(s, 'members');

  const list = await api(s.app, 'GET', '/api/comments/alice/demo?path=index.html', {
    cookie: s.eve,
  });
  assert.equal(list.status, 200, 'viewer member reads threads');
  assert.equal(((await list.json()) as { threads: { id: string }[] }).threads[0]!.id, tid);

  assert.equal(
    (await api(s.app, 'GET', '/api/comments/alice/demo?path=index.html')).status,
    401,
    'anonymous stays 401',
  );
  const carol = await api(s.app, 'GET', '/api/comments/alice/demo?path=index.html', {
    cookie: s.carol,
  });
  assert.equal(carol.status, 403);
  assert.equal(((await carol.json()) as { code: string }).code, 'site.access.forbidden');
});

test('members mode thread routes: create (commenter+): commenter 200, viewer 403, non-member 403, share-guest 200', async () => {
  const s = await setup();
  await addMember(s.db, s.demoId, 'u-dan', 'commenter');
  await addMember(s.db, s.demoId, 'u-eve', 'viewer');
  await setMode(s, 'members');

  assert.equal(
    (await api(s.app, 'POST', '/api/comments/alice/demo', { body: threadBody(), cookie: s.dan }))
      .status,
    200,
    'commenter creates',
  );
  for (const [label, cookie] of [
    ['viewer member', s.eve],
    ['non-member', s.carol],
  ] as const) {
    const r = await api(s.app, 'POST', '/api/comments/alice/demo', { body: threadBody(), cookie });
    assert.equal(r.status, 403, `${label} cannot create`);
    assert.equal(((await r.json()) as { code: string }).code, 'site.access.forbidden');
  }
  const guestCookie = await redeemShareGuest(s.app, s.alice);
  assert.equal(
    (
      await api(s.app, 'POST', '/api/comments/alice/demo', {
        body: threadBody(),
        cookie: guestCookie,
      })
    ).status,
    200,
    'share-guest keeps the guestComments write rules in members mode',
  );
});

test('members mode thread routes: replies (commenter+): commenter 200, viewer 403, non-member 403', async () => {
  const s = await setup();
  await addMember(s.db, s.demoId, 'u-dan', 'commenter');
  await addMember(s.db, s.demoId, 'u-eve', 'viewer');
  const tid = await createThread(s.app, s.alice);
  await setMode(s, 'members');

  assert.equal(
    (
      await api(s.app, 'POST', `/api/comments/threads/${tid}/replies`, {
        body: { text: 'noted' },
        cookie: s.dan,
      })
    ).status,
    200,
    'commenter replies',
  );
  for (const [label, cookie] of [
    ['viewer member', s.eve],
    ['non-member', s.carol],
  ] as const) {
    const r = await api(s.app, 'POST', `/api/comments/threads/${tid}/replies`, {
      body: { text: 'no' },
      cookie,
    });
    assert.equal(r.status, 403, `${label} cannot reply`);
    assert.equal(((await r.json()) as { code: string }).code, 'site.access.forbidden');
  }
});

test('members mode thread routes: PATCH resolve and kind (editor+ only)', async () => {
  const s = await setup();
  await addMember(s.db, s.demoId, 'u-bob', 'editor');
  await addMember(s.db, s.demoId, 'u-dan', 'commenter');
  await addMember(s.db, s.demoId, 'u-eve', 'viewer');
  const tid = await createThread(s.app, s.alice);
  await setMode(s, 'members');

  for (const [label, cookie] of [
    ['owner', s.alice],
    ['editor', s.bob],
  ] as const) {
    assert.equal(
      (
        await api(s.app, 'PATCH', `/api/comments/threads/${tid}`, {
          body: { resolved: true },
          cookie,
        })
      ).status,
      200,
      `${label} resolves`,
    );
  }
  for (const [label, cookie] of [
    ['commenter', s.dan],
    ['viewer', s.eve],
    ['non-member', s.carol],
  ] as const) {
    for (const body of [{ resolved: true }, { kind: 'question' }]) {
      const r = await api(s.app, 'PATCH', `/api/comments/threads/${tid}`, { body, cookie });
      assert.equal(r.status, 403, `${label} blocked on ${Object.keys(body)[0]}`);
      assert.equal(((await r.json()) as { code: string }).code, 'site.access.forbidden');
    }
  }
  assert.equal(
    (
      await api(s.app, 'PATCH', `/api/comments/threads/${tid}`, {
        body: { kind: 'bug' },
        cookie: s.bob,
      })
    ).status,
    200,
    'editor re-kinds',
  );
});

test('members mode thread routes: DELETE unchanged — viewer-role author still deletes own thread', async () => {
  const s = await setup();
  const tid = await createThread(s.app, s.eve, 'eve authors before the flip (open mode)');
  await addMember(s.db, s.demoId, 'u-eve', 'viewer');
  await setMode(s, 'members');
  assert.equal(
    (await api(s.app, 'DELETE', `/api/comments/threads/${tid}`, { cookie: s.eve })).status,
    200,
    'author rights are outside the W4 minimums and survive the viewer floor',
  );
});

// ───────────────────────── 11. W4: site_access_mode admin endpoints ─────────────────────────

test('admin settings GET carries site_access_mode and the locked flag', async () => {
  const s = await setup();
  const res = await api(s.app, 'GET', '/api/admin/settings', { cookie: s.admin });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    registration_mode: string;
    registration_locked: boolean;
    site_access_mode: string;
    site_access_mode_locked: boolean;
  };
  assert.equal(body.registration_mode, 'open');
  assert.equal(body.registration_locked, false);
  assert.equal(body.site_access_mode, 'open');
  assert.equal(body.site_access_mode_locked, false);
});

test('admin settings PATCH validation: empty 422, invalid 422, malformed 422, non-admin 403', async () => {
  const s = await setup();
  const nonAdmin = await api(s.app, 'PATCH', '/api/admin/settings', {
    body: { site_access_mode: 'members' },
    cookie: s.carol,
  });
  assert.equal(nonAdmin.status, 403);
  for (const [body, code] of [
    [{}, 'admin.settings.empty'],
    [{ site_access_mode: 'invite' }, 'admin.settings.siteAccessMode.invalid'],
    [{ registration_mode: 'maybe' }, 'admin.settings.registrationMode.invalid'],
  ] as const) {
    const r = await api(s.app, 'PATCH', '/api/admin/settings', { body, cookie: s.admin });
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.equal(((await r.json()) as { code: string }).code, code);
  }
  assert.equal(
    (
      await s.app.fetch(
        new Request('http://localhost/api/admin/settings', {
          method: 'PATCH',
          headers: { cookie: s.admin, 'x-csrf-token': CSRF, 'content-type': 'application/json' },
          body: JSON.stringify(['nope']),
        }),
      )
    ).status,
    422,
    'array body counts as malformed',
  );
});

test('admin settings PATCH: registration_mode-only body still works, response is a superset', async () => {
  const s = await setup();
  const res = await api(s.app, 'PATCH', '/api/admin/settings', {
    body: { registration_mode: 'invite' },
    cookie: s.admin,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { registration_mode: string; site_access_mode: string };
  assert.equal(body.registration_mode, 'invite');
  assert.equal(body.site_access_mode, 'open');
});

test('env lock: PAGEPIN_SITE_ACCESS_MODE=members reports locked; mode PATCH is 400; registration PATCH still works', async () => {
  const s = await setup({ PAGEPIN_SITE_ACCESS_MODE: 'members' });
  const get = (await (
    await api(s.app, 'GET', '/api/admin/settings', { cookie: s.admin })
  ).json()) as { site_access_mode: string; site_access_mode_locked: boolean };
  assert.equal(get.site_access_mode, 'members');
  assert.equal(get.site_access_mode_locked, true);

  assert.equal(
    (await contentFetch(s.app, 'alice', 'demo', s.carol)).status,
    403,
    'seam honors the env lock',
  );
  assert.equal(
    (await contentFetch(s.app, 'alice', 'demo', s.alice)).status,
    200,
    'owner unaffected',
  );

  const locked = await api(s.app, 'PATCH', '/api/admin/settings', {
    body: { site_access_mode: 'open' },
    cookie: s.admin,
  });
  assert.equal(locked.status, 400);
  assert.equal(
    ((await locked.json()) as { code: string }).code,
    'admin.settings.siteAccessModeLocked',
  );

  assert.equal(
    (
      await api(s.app, 'PATCH', '/api/admin/settings', {
        body: { registration_mode: 'invite' },
        cookie: s.admin,
      })
    ).status,
    200,
    'an unlocked field still writes while the other is env-locked',
  );
});

// ───────────────────────── 12. W4: open-mode no-regression ─────────────────────────

test('explicit PAGEPIN_SITE_ACCESS_MODE=open equals the open default (serving + one create)', async () => {
  const s = await setup({ PAGEPIN_SITE_ACCESS_MODE: 'open' });
  const get = (await (
    await api(s.app, 'GET', '/api/admin/settings', { cookie: s.admin })
  ).json()) as { site_access_mode: string; site_access_mode_locked: boolean };
  assert.equal(get.site_access_mode, 'open');
  assert.equal(get.site_access_mode_locked, true);

  const page = await contentFetch(s.app, 'alice', 'demo', s.carol);
  assert.equal(page.status, 200, 'explicit open serves non-members');
  const html = await page.text();
  assert.ok(html.includes('Hello Secret'));
  assert.ok(html.includes('/_pagepin/comments.js'), 'explicit open keeps the overlay');
  assert.equal(
    (await createThread(s.app, s.carol, 'carol still creates threads')).length > 0,
    true,
  );
});
