/** Content-plane site role lookup (W4).
 *
 * The content plane (serving + comment routes) resolves one already-identified
 * site row, so it needs none of the console plane's slug-ambiguity rules (W3).
 * Resolution order (design §2): site owner first, then the highest of the
 * member row and group grants; an owner-role group grant caps to editor (D1).
 */

import { and, eq, inArray } from 'drizzle-orm';

import { groupGrants, siteMembers, userGroups, type Db, type SiteRow } from './db/index.js';
import type { SiteRole } from './rbac.js';

// Same values as the RANK copies in rbac.ts / api/sites.ts; kept local per-file
// (the pure-function module stays import-free by design).
const RANK: Record<SiteRole, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };

/** Rank comparison against a minimum role; null (no member row, no grant) never passes. */
export function roleAtLeast(role: SiteRole | null, min: SiteRole): boolean {
  return role !== null && RANK[role] >= RANK[min];
}

export async function roleOnSite(db: Db, userId: string, site: SiteRow): Promise<SiteRole | null> {
  if (site.ownerId === userId) return 'owner';
  const member =
    (
      await db
        .select({ role: siteMembers.role })
        .from(siteMembers)
        .where(and(eq(siteMembers.siteId, site.id), eq(siteMembers.userId, userId)))
    )[0] ?? null;
  const groups = (
    await db
      .select({ name: userGroups.groupName })
      .from(userGroups)
      .where(eq(userGroups.userId, userId))
  ).map((g) => g.name);
  let grantRole: SiteRole | null = null;
  if (groups.length > 0) {
    const grants = await db
      .select({ role: groupGrants.role })
      .from(groupGrants)
      .where(and(eq(groupGrants.siteId, site.id), inArray(groupGrants.groupName, groups)));
    for (const g of grants) {
      if (grantRole === null || RANK[g.role] > RANK[grantRole]) grantRole = g.role;
    }
  }
  // Group grants never carry owner powers; cap at resolution like resolveSiteAccess (D1).
  if (grantRole === 'owner') grantRole = 'editor';
  let best: SiteRole | null = member?.role ?? null;
  if (grantRole !== null && (best === null || RANK[grantRole] > RANK[best])) best = grantRole;
  return best;
}
