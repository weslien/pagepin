import { useState } from 'react';
import {
  Ban,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  Globe2,
  History,
  Link2,
  Loader2,
  Lock,
  MessageSquare,
  Plus,
  Settings2,
  Trash2,
  UploadCloud,
  Users,
  UsersRound,
} from 'lucide-react';
import { api } from '../api';
import { useT } from '../i18n';
import { confirmDanger } from './ConfirmDialog';
import { ShareLinkDialog } from './ShareLinkDialog';
import { copyText, formatBytes, formatRelative, formatRemaining } from '../lib/format';
import { useStore } from '../store';
import type { GroupGrant, SiteMember, SiteOut, SiteRole, VersionsOut } from '../types';
import { toast, toastError } from './Toast';

const SHARE_HOURS = [1, 6, 24, 72, 168] as const;

/** D1 four-role set; the API only accepts the three non-owner values on write. */
const ROLES: SiteRole[] = ['owner', 'editor', 'commenter', 'viewer'];

type Panel = 'share' | 'settings' | 'versions' | 'members' | 'grants' | null;

/** Upsert a returned row into a local list: same id → replace, else append. */
function mergeById<T extends { id: string }>(list: T[], row: T): T[] {
  return list.some((x) => x.id === row.id)
    ? list.map((x) => (x.id === row.id ? row : x))
    : [...list, row];
}

/** Role picker: all four D1 values are visible; owner renders disabled because a
 *  membership row can never grant it — the request body only carries the other three. */
function RolePicker({
  value,
  onChange,
  disabled,
}: {
  value: SiteRole;
  onChange: (r: SiteRole) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap gap-1.5">
      {ROLES.map((r) => (
        <button
          key={r}
          type="button"
          disabled={disabled || r === 'owner'}
          title={r === 'owner' ? t('sites.role.ownerHint') : t(`sites.role.${r}.desc`)}
          onClick={() => onChange(r)}
          className={`rounded-field border px-2.5 py-1 text-[11px] font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
            value === r
              ? 'border-tide-300 bg-tide-50 text-tide-700'
              : 'border-ink-200 bg-white text-ink-600 hover:border-tide-300 hover:text-tide-700'
          }`}
        >
          {t(`sites.role.${r}.label`)}
        </button>
      ))}
    </div>
  );
}

export function SiteCard({
  site,
  now,
  expanded,
  onToggle,
}: {
  site: SiteOut;
  now: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const me = useStore((s) => s.me);
  const upsertSite = useStore((s) => s.upsertSite);
  const removeSite = useStore((s) => s.removeSite);
  const setDeployTarget = useStore((s) => s.setDeployTarget);

  // 文件计数 / 公开窗口时长 的文案助手
  const fileCount = (n: number) =>
    t(n === 1 ? 'sites.fileCount.one' : 'sites.fileCount.other', { n });
  const windowLabel = (hours: number) => t(`sites.window.${hours}h`);

  const [panel, setPanel] = useState<Panel>(null);
  const [shareLinkOpen, setShareLinkOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState<VersionsOut | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [members, setMembers] = useState<SiteMember[] | null>(null);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersFailed, setMembersFailed] = useState(false);
  const [memberHandle, setMemberHandle] = useState('');
  const [memberRole, setMemberRole] = useState<SiteRole>('editor');
  const [grants, setGrants] = useState<GroupGrant[] | null>(null);
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [grantsFailed, setGrantsFailed] = useState(false);
  const [grantGroup, setGrantGroup] = useState('');
  const [grantRole, setGrantRole] = useState<SiteRole>('editor');

  const remaining =
    site.visibility === 'public' && site.public_expires_at
      ? formatRemaining(site.public_expires_at, now)
      : null;
  // public + public_expires_at=null 是永久公开(无窗口、不会自动恢复私有)
  const isForever = site.visibility === 'public' && site.public_expires_at === null;
  const isPublicLive = site.visibility === 'public' && (isForever || remaining !== null);
  const isExpired = site.visibility === 'public' && !isForever && remaining === null;

  const shareOptions = me
    ? SHARE_HOURS.filter((h) => h <= me.limits.public_max_hours)
    : SHARE_HOURS;

  function togglePanel(p: Panel) {
    setPanel((cur) => (cur === p ? null : p));
    if (p === 'versions' && panel !== 'versions') {
      setVersionsLoading(true);
      void api
        .versions(site.slug)
        .then(setVersions)
        .catch((e) => toastError(e, t('sites.toast.loadVersionsFailed')))
        .finally(() => setVersionsLoading(false));
    }
    if (p === 'members' && panel !== 'members') {
      setMembersLoading(true);
      setMembersFailed(false);
      void api
        .listMembers(site.slug)
        .then((r) => setMembers(r.members))
        .catch((e) => {
          setMembersFailed(true);
          toastError(e, t('sites.toast.loadMembersFailed'));
        })
        .finally(() => setMembersLoading(false));
    }
    if (p === 'grants' && panel !== 'grants') {
      setGrantsLoading(true);
      setGrantsFailed(false);
      void api
        .listGroupGrants(site.slug)
        .then((r) => setGrants(r.grants))
        .catch((e) => {
          setGrantsFailed(true);
          toastError(e, t('sites.toast.loadGrantsFailed'));
        })
        .finally(() => setGrantsLoading(false));
    }
  }

  async function run<T>(fn: () => Promise<T>, onOk: (r: T) => void) {
    if (busy) return;
    setBusy(true);
    try {
      onOk(await fn());
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  function makePublic(hours: number) {
    void run(
      () => api.patchSite(site.slug, { visibility: 'public', public_hours: hours }),
      (updated) => {
        upsertSite(updated);
        setPanel(null);
        toast(t('sites.toast.public', { window: windowLabel(hours) }));
      },
    );
  }

  function makePublicForever() {
    void run(
      () => api.patchSite(site.slug, { visibility: 'public', public_forever: true }),
      (updated) => {
        upsertSite(updated);
        setPanel(null);
        toast(t('sites.toast.publicForever'));
      },
    );
  }

  function makePrivate() {
    void run(
      () => api.patchSite(site.slug, { visibility: 'private' }),
      (updated) => {
        upsertSite(updated);
        setPanel(null);
        toast(t('sites.toast.private'));
      },
    );
  }

  function toggleSpa(next: boolean) {
    void run(
      () => api.patchSite(site.slug, { spa_fallback: next }),
      (updated) => {
        upsertSite(updated);
        toast(next ? t('sites.toast.spaOn') : t('sites.toast.spaOff'));
      },
    );
  }

  function toggleComments(next: boolean) {
    void run(
      () => api.patchSite(site.slug, { comments_enabled: next }),
      (updated) => {
        upsertSite(updated);
        toast(next ? t('sites.toast.commentsOn') : t('sites.toast.commentsOff'));
      },
    );
  }

  function rollback(versionId: string) {
    void run(
      () => api.rollback(site.slug, versionId),
      (updated) => {
        upsertSite(updated);
        setPanel(null);
        toast(t('sites.toast.rolledBack'));
      },
    );
  }

  // Members / group grants: both PUTs upsert in place (same body re-adds a deleted
  // row), which is why the remove buttons carry no confirm dialog. Adds are gated
  // on the list load: the load's wholesale setMembers would otherwise wipe a row
  // added while the fetch was still in flight.
  function addMember() {
    const handle = memberHandle.trim().replace(/^@+/, '');
    if (!handle || membersLoading) return;
    void run(
      () => api.putMember(site.slug, { handle, role: memberRole }),
      (m) => {
        setMembers((prev) => mergeById(prev ?? [], m));
        setMemberHandle('');
        toast(t('sites.toast.memberSaved'));
      },
    );
  }

  function removeMember(id: string) {
    void run(
      () => api.deleteMember(site.slug, id),
      () => {
        setMembers((prev) => (prev ?? []).filter((x) => x.id !== id));
        toast(t('sites.toast.memberRemoved'));
      },
    );
  }

  function addGrant() {
    const groupName = grantGroup.trim();
    if (!groupName || grantsLoading) return;
    void run(
      () => api.putGroupGrant(site.slug, { group_name: groupName, role: grantRole }),
      (g) => {
        setGrants((prev) => mergeById(prev ?? [], g));
        setGrantGroup('');
        toast(t('sites.toast.grantSaved'));
      },
    );
  }

  function removeGrant(id: string) {
    void run(
      () => api.deleteGroupGrant(site.slug, id),
      () => {
        setGrants((prev) => (prev ?? []).filter((x) => x.id !== id));
        toast(t('sites.toast.grantRemoved'));
      },
    );
  }

  async function remove() {
    const ok = await confirmDanger({
      title: t('sites.delete.title', { slug: site.slug }),
      body: t('sites.delete.body'),
      confirmText: t('sites.delete.confirm'),
    });
    if (!ok) return;
    void run(
      () => api.deleteSite(site.slug),
      () => {
        removeSite(site.slug);
        toast(t('sites.toast.deleted'));
      },
    );
  }

  return (
    <div
      data-testid="site-card"
      data-slug={site.slug}
      className="group flex flex-col rounded-card border border-ink-200 bg-white shadow-card transition-shadow hover:shadow-lift"
    >
      {/* 折叠头（始终显示）：点击展开/收起；右侧快捷复制/打开不触发展开 */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onToggle()}
        className="flex w-full cursor-pointer items-center gap-2.5 px-4 py-3 text-left"
      >
        <ChevronRight
          className={`h-4 w-4 shrink-0 text-ink-300 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate font-mono text-sm font-semibold text-ink-800">{site.slug}</span>
          {site.title && (
            <span className="hidden truncate text-xs text-ink-400 sm:inline">{site.title}</span>
          )}
        </span>
        {site.unresolved_comments > 0 && (
          <span
            title={t(
              site.unresolved_comments === 1 ? 'sites.unresolved.one' : 'sites.unresolved.other',
              { n: site.unresolved_comments },
            )}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700 ring-1 ring-amber-200"
          >
            <MessageSquare className="h-3 w-3" />
            {site.unresolved_comments}
          </span>
        )}
        {site.suspended ? (
          <span
            title={t('sites.badge.disabledTitle')}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-600 ring-1 ring-red-200"
          >
            <Ban className="h-3 w-3" />
            {t('sites.badge.disabled')}
          </span>
        ) : isPublicLive ? (
          <span
            title={isForever ? t('sites.badge.publicForeverTitle') : undefined}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-tide-50 px-2.5 py-1 text-xs font-semibold text-tide-700 ring-1 ring-tide-200"
          >
            <Globe2 className="h-3 w-3" />
            {isForever
              ? t('sites.badge.publicForever')
              : t('sites.badge.public', { remaining: remaining ?? '' })}
          </span>
        ) : isExpired ? (
          <span
            title={t('sites.badge.revertedTitle')}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ink-100 px-2.5 py-1 text-xs font-semibold text-ink-500 ring-1 ring-ink-200"
          >
            <Clock className="h-3 w-3" />
            {t('sites.badge.reverted')}
          </span>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ink-100 px-2.5 py-1 text-xs font-semibold text-ink-600 ring-1 ring-ink-200">
            <Lock className="h-3 w-3" />
            {t('sites.badge.private')}
          </span>
        )}
        <span className="hidden shrink-0 text-xs text-ink-400 md:inline">
          {formatRelative(site.updated_at)}
        </span>
        <button
          type="button"
          title={t('sites.copyLink')}
          className="shrink-0 rounded-chip p-1.5 text-ink-300 hover:bg-ink-100 hover:text-tide-700"
          onClick={(e) => {
            e.stopPropagation();
            void copyText(site.url).then((ok) =>
              ok ? toast(t('sites.toast.linkCopied')) : toast(t('sites.toast.copyFailed'), 'err'),
            );
          }}
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        <a
          href={site.url}
          target="_blank"
          rel="noreferrer"
          title={t('sites.open')}
          className="shrink-0 rounded-chip p-1.5 text-ink-300 hover:bg-ink-100 hover:text-tide-700"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      {!expanded ? null : (
        <div className="px-5 pb-5">
          {site.suspended && (
            <div className="mb-3 rounded-panel border border-red-200 bg-red-50 p-3 text-xs">
              <div className="font-semibold text-red-700">{t('sites.suspended.title')}</div>
              <div className="mt-0.5 leading-relaxed text-red-600">
                {t('sites.suspended.body')}
                {site.suspended_reason
                  ? t('sites.suspended.reason', { reason: site.suspended_reason })
                  : ''}
                {t('sites.suspended.appeal')}
              </div>
            </div>
          )}
          {/* URL 行 */}
          <div className="flex items-center gap-1.5 rounded-field border border-ink-200 bg-ink-50 px-2.5 py-1.5">
            <a
              href={site.url}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 flex-1 truncate font-mono text-xs text-tide-700 hover:underline"
              title={site.url}
            >
              {site.url}
            </a>
            <button
              type="button"
              title={t('sites.copyLink')}
              className="rounded-chip p-1 text-ink-400 hover:bg-white hover:text-tide-700"
              onClick={() => {
                void copyText(site.url).then((ok) =>
                  ok
                    ? toast(t('sites.toast.linkCopied'))
                    : toast(t('sites.toast.copyFailed'), 'err'),
                );
              }}
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
            <a
              href={site.url}
              target="_blank"
              rel="noreferrer"
              title={t('sites.open')}
              className="rounded-chip p-1 text-ink-400 hover:bg-white hover:text-tide-700"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>

          <div className="mt-3 text-xs text-ink-400">
            {fileCount(site.file_count)} · {formatBytes(site.total_bytes)} ·{' '}
            {t('sites.updatedAt', { time: formatRelative(site.updated_at) })}
          </div>

          {/* 操作行 */}
          <div className="mt-4 flex flex-wrap gap-1.5 border-t border-ink-100 pt-3">
            <button
              type="button"
              className={`btn-ghost !px-2.5 !py-1.5 !text-xs ${panel === 'share' ? '!border-tide-300 !text-tide-700' : ''}`}
              onClick={() => togglePanel('share')}
              disabled={busy}
            >
              <Globe2 className="h-3.5 w-3.5" />
              {isPublicLive ? t('sites.action.makePrivate') : t('sites.action.makePublic')}
            </button>
            <button
              type="button"
              className="btn-ghost !px-2.5 !py-1.5 !text-xs"
              onClick={() => setShareLinkOpen(true)}
              disabled={busy}
            >
              <Link2 className="h-3.5 w-3.5" />
              {t('sites.action.shareLink')}
            </button>
            <button
              type="button"
              className="btn-ghost !px-2.5 !py-1.5 !text-xs"
              onClick={() => setDeployTarget(site.slug)}
              disabled={busy}
            >
              <UploadCloud className="h-3.5 w-3.5" />
              {t('sites.action.redeploy')}
            </button>
            <button
              type="button"
              className={`btn-ghost !px-2.5 !py-1.5 !text-xs ${panel === 'versions' ? '!border-tide-300 !text-tide-700' : ''}`}
              onClick={() => togglePanel('versions')}
              disabled={busy}
            >
              <History className="h-3.5 w-3.5" />
              {t('sites.action.versions', { count: site.version_count })}
            </button>
            <button
              type="button"
              className={`btn-ghost !px-2.5 !py-1.5 !text-xs ${panel === 'settings' ? '!border-tide-300 !text-tide-700' : ''}`}
              onClick={() => togglePanel('settings')}
              disabled={busy}
            >
              <Settings2 className="h-3.5 w-3.5" />
              {t('sites.action.settings')}
            </button>
            <button
              type="button"
              className={`btn-ghost !px-2.5 !py-1.5 !text-xs ${panel === 'members' ? '!border-tide-300 !text-tide-700' : ''}`}
              onClick={() => togglePanel('members')}
              disabled={busy}
            >
              <Users className="h-3.5 w-3.5" />
              {t('sites.action.members')}
            </button>
            <button
              type="button"
              className={`btn-ghost !px-2.5 !py-1.5 !text-xs ${panel === 'grants' ? '!border-tide-300 !text-tide-700' : ''}`}
              onClick={() => togglePanel('grants')}
              disabled={busy}
            >
              <UsersRound className="h-3.5 w-3.5" />
              {t('sites.action.grants')}
            </button>
            <button
              type="button"
              className="btn-danger-ghost ml-auto !px-2.5 !py-1.5 !text-xs"
              onClick={() => void remove()}
              disabled={busy}
              title={t('sites.action.deleteTitle')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* ── 面板：公开分享 ── */}
          {panel === 'share' && (
            <div className="mt-3 rounded-panel border border-ink-200 bg-ink-50 p-3 animate-fade-up">
              <div className="text-xs font-semibold text-ink-500">
                {isForever
                  ? t('sites.share.foreverOn')
                  : isPublicLive
                    ? t('sites.share.extend')
                    : t('sites.share.publicFor')}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {shareOptions.map((h) => (
                  <button
                    key={h}
                    type="button"
                    className="rounded-field border border-ink-200 bg-white px-3 py-1.5 text-xs font-semibold text-ink-600 hover:border-tide-300 hover:text-tide-700 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => makePublic(h)}
                  >
                    {windowLabel(h)}
                  </button>
                ))}
                {/* 永久公开:不设窗口,故不受 public_max_hours 约束,始终可选 */}
                <button
                  type="button"
                  title={t('sites.share.foreverTitle')}
                  className={`rounded-field border px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${
                    isForever
                      ? 'border-tide-300 bg-tide-50 text-tide-700'
                      : 'border-ink-200 bg-white text-ink-600 hover:border-tide-300 hover:text-tide-700'
                  }`}
                  disabled={busy || isForever}
                  onClick={makePublicForever}
                >
                  {t('sites.window.forever')}
                </button>
              </div>
              {isPublicLive && (
                <button
                  type="button"
                  className="mt-2 text-xs font-semibold text-ink-500 underline-offset-2 hover:text-red-600 hover:underline"
                  disabled={busy}
                  onClick={makePrivate}
                >
                  {t('sites.share.revertNow')}
                </button>
              )}
            </div>
          )}

          {/* ── 面板：设置 ── */}
          {panel === 'settings' && (
            <div className="mt-3 space-y-3 rounded-panel border border-ink-200 bg-ink-50 p-3 animate-fade-up">
              <label className="flex cursor-pointer items-start justify-between gap-3">
                <span>
                  <span className="block text-xs font-semibold text-ink-700">
                    {t('sites.settings.comments')}
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-400">
                    {t('sites.settings.commentsDesc')}
                  </span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={site.comments_enabled}
                  disabled={busy}
                  onClick={() => toggleComments(!site.comments_enabled)}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                    site.comments_enabled ? 'bg-tide-600' : 'bg-ink-300'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
                      site.comments_enabled ? 'left-[18px]' : 'left-0.5'
                    }`}
                  />
                </button>
              </label>
              <label className="flex cursor-pointer items-start justify-between gap-3">
                <span>
                  <span className="block text-xs font-semibold text-ink-700">
                    {t('sites.settings.spa')}
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-400">
                    {t('sites.settings.spaDesc')}
                  </span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={site.spa_fallback}
                  disabled={busy}
                  onClick={() => toggleSpa(!site.spa_fallback)}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                    site.spa_fallback ? 'bg-tide-600' : 'bg-ink-300'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
                      site.spa_fallback ? 'left-[18px]' : 'left-0.5'
                    }`}
                  />
                </button>
              </label>
            </div>
          )}

          {/* ── 面板：版本 ── */}
          {panel === 'versions' && (
            <div className="mt-3 rounded-panel border border-ink-200 bg-ink-50 p-3 animate-fade-up">
              {versionsLoading ? (
                <div className="flex items-center gap-2 py-2 text-xs text-ink-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('sites.versions.loading')}
                </div>
              ) : versions && versions.versions.length > 0 ? (
                <ul className="space-y-1.5">
                  {versions.versions.map((v) => {
                    const isCurrent = v.id === versions.current;
                    return (
                      <li
                        key={v.id}
                        className="flex items-center justify-between gap-2 rounded-field bg-white px-2.5 py-2 ring-1 ring-ink-200"
                      >
                        <div className="min-w-0 text-xs">
                          <span className="font-mono text-ink-600">
                            {formatRelative(v.created_at)}
                          </span>
                          <span className="ml-2 text-ink-400">
                            {fileCount(v.file_count)} · {formatBytes(v.total_bytes)}
                          </span>
                        </div>
                        {isCurrent ? (
                          <span className="shrink-0 rounded-full bg-tide-50 px-2 py-0.5 text-[11px] font-semibold text-tide-700 ring-1 ring-tide-200">
                            {t('sites.versions.current')}
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="shrink-0 rounded-field border border-ink-200 px-2 py-1 text-[11px] font-semibold text-ink-600 hover:border-tide-300 hover:text-tide-700 disabled:opacity-50"
                            disabled={busy}
                            onClick={() => rollback(v.id)}
                          >
                            {t('sites.versions.rollback')}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="py-2 text-xs text-ink-400">{t('sites.versions.empty')}</div>
              )}
              {me && me.limits.keep_versions > 0 && versions && versions.versions.length > 0 && (
                <p className="mt-2 px-0.5 text-[11px] leading-relaxed text-ink-400">
                  {t('sites.versions.keepNote', { n: me.limits.keep_versions })}
                </p>
              )}
            </div>
          )}

          {/* ── 面板:成员(owner-only) ── */}
          {panel === 'members' && (
            <div className="mt-3 rounded-panel border border-ink-200 bg-ink-50 p-3 animate-fade-up">
              <div className="text-xs font-semibold text-ink-500">{t('sites.members.heading')}</div>
              {membersLoading ? (
                <div className="flex items-center gap-2 py-2 text-xs text-ink-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('common.loading')}
                </div>
              ) : membersFailed ? (
                <div className="py-2 text-xs text-ink-400">
                  {t('sites.toast.loadMembersFailed')}
                </div>
              ) : members && members.length > 0 ? (
                <ul className="mt-2 space-y-1.5">
                  {members.map((m) => (
                    <li
                      key={m.id}
                      className="flex items-center justify-between gap-2 rounded-field bg-white px-2.5 py-2 ring-1 ring-ink-200"
                    >
                      <span className="min-w-0 truncate font-mono text-xs text-ink-700">
                        @{m.handle}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <span className="rounded-full bg-tide-50 px-2 py-0.5 text-[11px] font-semibold text-tide-700 ring-1 ring-tide-200">
                          {t(`sites.role.${m.role}.label`)}
                        </span>
                        <button
                          type="button"
                          title={t('sites.members.remove')}
                          className="rounded-chip p-1 text-ink-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                          disabled={busy}
                          onClick={() => removeMember(m.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-2 py-2 text-xs text-ink-400">{t('sites.members.empty')}</div>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <input
                  className="input !w-40 !py-1.5 !text-xs"
                  placeholder={t('sites.members.handlePlaceholder')}
                  maxLength={32}
                  value={memberHandle}
                  onChange={(e) => setMemberHandle(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addMember()}
                />
                <RolePicker
                  value={memberRole}
                  onChange={setMemberRole}
                  disabled={busy || membersLoading}
                />
                <button
                  type="button"
                  className="btn-primary !px-2.5 !py-1.5 !text-xs"
                  disabled={busy || membersLoading || !memberHandle.trim()}
                  onClick={addMember}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t('sites.members.add')}
                </button>
              </div>
            </div>
          )}

          {/* ── 面板:组授予(owner-only) ── */}
          {panel === 'grants' && (
            <div className="mt-3 rounded-panel border border-ink-200 bg-ink-50 p-3 animate-fade-up">
              <div className="text-xs font-semibold text-ink-500">{t('sites.grants.heading')}</div>
              {grantsLoading ? (
                <div className="flex items-center gap-2 py-2 text-xs text-ink-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('common.loading')}
                </div>
              ) : grantsFailed ? (
                <div className="py-2 text-xs text-ink-400">{t('sites.toast.loadGrantsFailed')}</div>
              ) : grants && grants.length > 0 ? (
                <ul className="mt-2 space-y-1.5">
                  {grants.map((g) => (
                    <li
                      key={g.id}
                      className="flex items-center justify-between gap-2 rounded-field bg-white px-2.5 py-2 ring-1 ring-ink-200"
                    >
                      <span className="min-w-0 truncate font-mono text-xs text-ink-700">
                        {g.group_name}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <span className="rounded-full bg-tide-50 px-2 py-0.5 text-[11px] font-semibold text-tide-700 ring-1 ring-tide-200">
                          {t(`sites.role.${g.role}.label`)}
                        </span>
                        <button
                          type="button"
                          title={t('sites.grants.remove')}
                          className="rounded-chip p-1 text-ink-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                          disabled={busy}
                          onClick={() => removeGrant(g.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-2 py-2 text-xs text-ink-400">{t('sites.grants.empty')}</div>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <input
                  className="input !w-40 !py-1.5 !text-xs"
                  placeholder={t('sites.grants.groupPlaceholder')}
                  maxLength={64}
                  value={grantGroup}
                  onChange={(e) => setGrantGroup(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addGrant()}
                />
                <RolePicker
                  value={grantRole}
                  onChange={setGrantRole}
                  disabled={busy || grantsLoading}
                />
                <button
                  type="button"
                  className="btn-primary !px-2.5 !py-1.5 !text-xs"
                  disabled={busy || grantsLoading || !grantGroup.trim()}
                  onClick={addGrant}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t('sites.grants.add')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {shareLinkOpen && <ShareLinkDialog site={site} onClose={() => setShareLinkOpen(false)} />}
    </div>
  );
}
