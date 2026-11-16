/** 站点角色解析 —— 纯函数,W1 只落数据层(表 + 解析器),路由接入在后续 wave。
 *
 * 解析序(设计 §2):站长(sites.ownerId)恒为 owner;否则取成员行与组授予行中的最高者;
 * 组授予封顶 editor —— IdP 组不得携带删站等站长权力(D1:enum 四值都存,grant 的 owner 按 editor 解析)。
 * open 模式(默认,= v0.3.0 行为)并上「已登录基线」(view + comment),成员行永不收窄权利;
 * members 模式下无行者一无所有。本文件无 import、无 DB、无调用方。
 */

export type SiteRole = 'owner' | 'editor' | 'commenter' | 'viewer';

export type SiteAccessMode = 'open' | 'members';

export interface SiteAccess {
  role: SiteRole | null; // null = 无成员行也无组授予(仅展示用;能力以 capabilities 为准)
  capabilities: {
    view: boolean; // 看私有站点
    comment: boolean; // 发/回评论
    deploy: boolean; // 部署/草稿/回滚
    manage: boolean; // 设置/分享/删站/线程管理(站长专属)
  };
}

export interface SiteAccessInput {
  isOwner: boolean; // 请求者 == sites.ownerId
  memberRole: SiteRole | null; // site_members 行的角色;无行 = null
  grantRole: SiteRole | null; // 经 user_groups 命中的最高 group_grants 行;无 = null
  mode: SiteAccessMode; // 实例 site_access_mode(默认 open)
}

const RANK: Record<SiteRole, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };

const CAPS: Record<SiteRole, SiteAccess['capabilities']> = {
  owner: { view: true, comment: true, deploy: true, manage: true },
  editor: { view: true, comment: true, deploy: true, manage: false },
  commenter: { view: true, comment: true, deploy: false, manage: false },
  viewer: { view: true, comment: false, deploy: false, manage: false },
};

/** 纯输入 → 有效角色 + 能力集;路由侧每请求解析一次(W3 接线)。 */
export function resolveSiteAccess({
  isOwner,
  memberRole,
  grantRole,
  mode,
}: SiteAccessInput): SiteAccess {
  if (isOwner) return { role: 'owner', capabilities: { ...CAPS.owner } };

  const grant: SiteRole | null =
    grantRole == null ? null : grantRole === 'owner' ? 'editor' : grantRole;
  let best: SiteRole | null = null;
  for (const r of [memberRole, grant])
    if (r != null && (best == null || RANK[r] > RANK[best])) best = r;

  const capabilities = best
    ? { ...CAPS[best] }
    : { view: false, comment: false, deploy: false, manage: false };
  if (mode === 'open') {
    capabilities.view = true; // 已登录基线:open 下人人可看可评(v0.3.0 行为不变)
    capabilities.comment = true;
  }
  return { role: best, capabilities };
}
