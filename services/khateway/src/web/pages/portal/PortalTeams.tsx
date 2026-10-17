// Portal Teams (/app/teams) — M9 orgs. List + create + join on the index;
// per-org detail at /app/teams/:orgId with members, invite code, org-scoped
// keys, shared balance and usage. Owners manage members/billing/any key;
// members create + manage their OWN org keys and see usage + balance.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, Building, Check, Copy, CreditCard, KeyRound, LogOut, Plus, RefreshCw, Trash2, UserMinus, Users } from 'lucide-react';
import { portalApi, type OrgKey, type OrgMember, type OrgRole, type PortalOrg, type PortalUsageRow } from '../../portal-api';
import { navigate, useRoute, Link } from '../../router';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Input, Modal, PageHeader, Spinner, Switch, toast, fmtPrice, fmtTokens, cn } from '../../components/ui';

const TOPUP_PRESETS = [5, 10, 25, 50];

function fmtWhen(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function RoleBadge({ role }: { role: OrgRole }) {
  return role === 'owner' ? (
    <Badge tone="ok">owner</Badge>
  ) : (
    <Badge>member</Badge>
  );
}

// ------------------------------------------------------------------- index

function CreateOrgModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => portalApi.createOrg(name.trim()),
    onSuccess: (org) => {
      void qc.invalidateQueries({ queryKey: ['portal-orgs'] });
      toast(`Organization '${org.name}' created`);
      navigate(`/app/teams/${org.id}`);
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Failed to create organization'),
  });
  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setError(null);
      }}
      title="Create organization"
      description="A shared space with its own keys, members and prepaid balance."
    >
      <Input
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        placeholder="e.g. Acme AI team"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim()) create.mutate();
        }}
      />
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
      <p className="mt-3 text-[11px] text-zinc-500">You become the first owner. Invite teammates with the join code afterwards.</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => create.mutate()} disabled={create.isPending || !name.trim()}>
          {create.isPending ? <Spinner className="border-zinc-900/70 border-t-transparent" /> : null}
          Create
        </Button>
      </div>
    </Modal>
  );
}

function JoinOrgModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const join = useMutation({
    mutationFn: () => portalApi.joinOrg(code.trim()),
    onSuccess: (org) => {
      void qc.invalidateQueries({ queryKey: ['portal-orgs'] });
      toast(`Joined '${org.name}'`);
      navigate(`/app/teams/${org.id}`);
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Failed to join'),
  });
  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setError(null);
      }}
      title="Join an organization"
      description="Enter the join code an owner shared with you."
    >
      <Input
        value={code}
        onChange={(e) => {
          setCode(e.target.value);
          setError(null);
        }}
        placeholder="10-character code"
        className="font-mono"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && code.trim()) join.mutate();
        }}
      />
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => join.mutate()} disabled={join.isPending || !code.trim()}>
          {join.isPending ? <Spinner className="border-zinc-900/70 border-t-transparent" /> : null}
          Join
        </Button>
      </div>
    </Modal>
  );
}

function OrgList() {
  const orgs = useQuery({ queryKey: ['portal-orgs'], queryFn: portalApi.orgs });
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);

  return (
    <>
      <PageHeader
        title="Teams"
        subtitle="Organizations pool a prepaid balance and share usage — your personal keys and balance stay separate."
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setJoining(true)}>
              <Users className="h-4 w-4" />
              Join with code
            </Button>
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              New organization
            </Button>
          </div>
        }
      />
      {orgs.isLoading ? (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      ) : (orgs.data?.length ?? 0) === 0 ? (
        <Card>
          <EmptyState
            icon={<Building className="h-6 w-6" />}
            title="No organizations yet"
            description="Create one for your team, or join an existing one with an owner's code."
            action={
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="h-3.5 w-3.5" />
                Create your first organization
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {(orgs.data ?? []).map((org) => (
            <Link key={org.id} to={`/app/teams/${org.id}`} className="group">
              <Card className="p-5 transition-colors group-hover:border-zinc-700">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Building className="h-4 w-4 shrink-0 text-zinc-500" />
                    <span className="truncate text-[14px] font-medium text-zinc-100">{org.name}</span>
                  </div>
                  <RoleBadge role={org.role} />
                </div>
                <div className="mt-4 flex items-center gap-5 text-[12px] text-zinc-500">
                  <span>
                    Balance <span className={cn('font-mono', org.balance_usd > 0 ? 'text-emerald-400' : 'text-zinc-400')}>{fmtPrice(org.balance_usd)}</span>
                  </span>
                  <span>{org.member_count ?? 1} member{(org.member_count ?? 1) === 1 ? '' : 's'}</span>
                  {!org.enabled ? <Badge tone="warn">disabled</Badge> : null}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
      <CreateOrgModal open={creating} onClose={() => setCreating(false)} />
      <JoinOrgModal open={joining} onClose={() => setJoining(false)} />
    </>
  );
}

// ------------------------------------------------------------------- detail

function JoinCodeCard({ org }: { org: PortalOrg }) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const rotate = useMutation({
    mutationFn: () => portalApi.regenerateCode(org.id),
    onSuccess: () => {
      toast('New join code generated — the old one is dead');
      void qc.invalidateQueries({ queryKey: ['portal-org', org.id] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed to rotate code', 'err'),
  });
  if (!org.join_code) return null;
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-medium text-zinc-200">Invite teammates</div>
        <Button size="sm" variant="outline" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
          {rotate.isPending ? <Spinner className="border-zinc-400 border-t-transparent" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Rotate
        </Button>
      </div>
      <p className="mt-1 text-xs text-zinc-500">Anyone with a portal account can redeem this code to join as a member.</p>
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2.5">
        <code className="flex-1 font-mono text-[14px] tracking-widest text-emerald-300 select-all">{org.join_code}</code>
        <button
          className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          title="Copy code"
          onClick={() => {
            void navigator.clipboard.writeText(org.join_code!);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>
    </Card>
  );
}

function MembersCard({ org, myId }: { org: PortalOrg; myId: string }) {
  const qc = useQueryClient();
  const isOwner = org.role === 'owner';
  const owners = (org.members ?? []).filter((m) => m.role === 'owner').length;
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['portal-org', org.id] });
    void qc.invalidateQueries({ queryKey: ['portal-orgs'] });
  };
  const setRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: OrgRole }) => portalApi.setMemberRole(org.id, userId, role),
    onSuccess: () => {
      toast('Role updated');
      invalidate();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed to change role', 'err'),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => portalApi.removeMember(org.id, userId),
    onSuccess: () => {
      toast('Member removed');
      invalidate();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed to remove member', 'err'),
  });

  return (
    <Card>
      <div className="border-b border-zinc-800/70 px-5 py-4 text-[13px] font-medium text-zinc-200">Members</div>
      <div className="divide-y divide-zinc-800/70">
        {(org.members ?? []).map((m: OrgMember) => {
          const lastOwner = m.role === 'owner' && owners <= 1;
          return (
            <div key={m.user_id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-zinc-200">
                  {m.email ?? m.user_id}
                  {m.user_id === myId ? <span className="ml-2 text-[11px] text-zinc-500">(you)</span> : null}
                </div>
                <div className="text-[11px] text-zinc-500">joined {fmtWhen(m.joined_at)}</div>
              </div>
              <RoleBadge role={m.role} />
              {isOwner ? (
                <>
                  <select
                    className="h-8 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-200"
                    value={m.role}
                    disabled={lastOwner || setRole.isPending}
                    title={lastOwner ? 'Cannot demote the last owner' : 'Change role'}
                    onChange={(e) => setRole.mutate({ userId: m.user_id, role: e.target.value as OrgRole })}
                  >
                    <option value="owner">owner</option>
                    <option value="member">member</option>
                  </select>
                  <button
                    className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-red-400 disabled:opacity-30"
                    title={lastOwner ? 'Cannot remove the last owner' : 'Remove member'}
                    disabled={lastOwner || remove.isPending}
                    onClick={() => remove.mutate(m.user_id)}
                  >
                    <UserMinus className="h-4 w-4" />
                  </button>
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function OrgKeysCard({ org, myId }: { org: PortalOrg; myId: string }) {
  const qc = useQueryClient();
  const isOwner = org.role === 'owner';
  const keys = useQuery({ queryKey: ['portal-org-keys', org.id], queryFn: () => portalApi.orgKeys(org.id) });
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<OrgKey | null>(null);
  const [confirming, setConfirming] = useState<OrgKey | null>(null);

  const create = useMutation({
    mutationFn: () => portalApi.createOrgKey(org.id, { name: name.trim() }),
    onSuccess: (k) => {
      void qc.invalidateQueries({ queryKey: ['portal-org-keys', org.id] });
      setName('');
      setCreating(false);
      setCreated(k);
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed to create key', 'err'),
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['portal-org-keys', org.id] });
  };
  const toggle = useMutation({
    mutationFn: (k: OrgKey) => portalApi.updateOrgKey(org.id, k.id, { enabled: !k.enabled }),
    onSuccess: invalidate,
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed', 'err'),
  });
  const del = useMutation({
    mutationFn: (k: OrgKey) => portalApi.deleteOrgKey(org.id, k.id),
    onSuccess: () => {
      toast('Key deleted');
      setConfirming(null);
      invalidate();
    },
    onError: (e) => {
      toast(e instanceof Error ? e.message : 'Delete failed', 'err');
      setConfirming(null);
    },
  });

  const canManage = (k: OrgKey) => isOwner || k.created_by === myId;

  return (
    <Card>
      <div className="flex items-center justify-between border-b border-zinc-800/70 px-5 py-4">
        <span className="text-[13px] font-medium text-zinc-200">API keys</span>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-3.5 w-3.5" />
          New key
        </Button>
      </div>
      {keys.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (keys.data?.length ?? 0) === 0 ? (
        <EmptyState icon={<KeyRound className="h-6 w-6" />} title="No org keys yet" description="Org keys draw the shared organization balance — your personal keys stay separate." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="text-[11px] tracking-wide text-zinc-500 uppercase">
              <tr>
                <th className="px-5 py-2.5 font-medium">Key</th>
                <th className="px-5 py-2.5 font-medium">Created by</th>
                <th className="px-5 py-2.5 font-medium">Requests · spent</th>
                <th className="px-5 py-2.5 font-medium">Enabled</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {(keys.data ?? []).map((k) => (
                <tr key={k.id} className="border-t border-zinc-800/70">
                  <td className="px-5 py-3">
                    <div className="text-zinc-100">{k.name}</div>
                    <div className="font-mono text-[11px] text-zinc-500">{k.key_prefix}…</div>
                  </td>
                  <td className="px-5 py-3 text-zinc-400">
                    {k.created_by === myId ? 'you' : (k.created_by_email ?? '—')}
                  </td>
                  <td className="px-5 py-3 text-zinc-400">
                    {k.request_count} · {fmtPrice(k.spent_usd)}
                  </td>
                  <td className="px-5 py-3">
                    <Switch checked={k.enabled} onChange={() => toggle.mutate(k)} disabled={!canManage(k) || toggle.isPending} />
                  </td>
                  <td className="px-5 py-3 text-right">
                    {canManage(k) ? (
                      <button
                        className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-red-400"
                        title="Delete key"
                        onClick={() => setConfirming(k)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Create org API key"
        description="Usage draws this organization's shared balance."
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. team runner" autoFocus />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setCreating(false)}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending || !name.trim()}>
            Create key
          </Button>
        </div>
      </Modal>
      <Modal open={!!created?.key} onClose={() => setCreated(null)} title="Your new API key" description="Copy it now — this is the only time the full key is shown.">
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5">
          <code className="flex-1 truncate font-mono text-[13px] text-emerald-300">{created?.key}</code>
        </div>
        <p className="mt-3 text-xs text-zinc-500">
          Point your SDK at <code className="text-zinc-400">{typeof window !== 'undefined' ? window.location.origin : ''}/v1</code>
        </p>
        <div className="mt-5 flex justify-end">
          <Button onClick={() => setCreated(null)}>Done</Button>
        </div>
      </Modal>
      <ConfirmDialog
        open={!!confirming}
        title="Delete API key"
        body={`Delete '${confirming?.name}' (${confirming?.key_prefix}…)? Clients using it will stop working immediately.`}
        busy={del.isPending}
        onConfirm={() => confirming && del.mutate(confirming)}
        onClose={() => setConfirming(null)}
      />
    </Card>
  );
}

function OrgBillingCard({ org }: { org: PortalOrg }) {
  const qc = useQueryClient();
  const [toppingUp, setToppingUp] = useState<number | null>(null);
  const billing = useQuery({ queryKey: ['portal-org-billing', org.id], queryFn: () => portalApi.orgBilling(org.id) });
  const isOwner = org.role === 'owner';

  const checkout = useMutation({
    mutationFn: (amount: number) => portalApi.orgCheckout(org.id, amount),
    onMutate: (amount) => setToppingUp(amount),
    onSuccess: (res) => {
      window.location.href = res.url;
    },
    onError: (e) => {
      toast(e instanceof Error ? e.message : 'Checkout failed', 'err');
      setToppingUp(null);
    },
  });

  const entries = billing.data?.entries ?? [];
  const balance = billing.data?.balance_usd ?? org.balance_usd;

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-[13px] text-zinc-400">
        <CreditCard className="h-4 w-4" />
        Shared balance
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div className={cn('text-3xl font-semibold tracking-tight', balance > 0 ? 'text-emerald-400' : 'text-zinc-300')}>{fmtPrice(balance)}</div>
        {isOwner && billing.data?.configured ? (
          <div className="flex flex-wrap justify-end gap-2">
            {TOPUP_PRESETS.map((amount) => (
              <Button key={amount} size="sm" variant={amount === 10 ? 'primary' : 'outline'} disabled={checkout.isPending} onClick={() => checkout.mutate(amount)}>
                {toppingUp === amount ? <Spinner className="border-zinc-900/70 border-t-transparent" /> : <CreditCard className="h-3.5 w-3.5" />}
                ${amount}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-zinc-500">
        {isOwner
          ? billing.data?.configured
            ? 'Org keys draw this balance down per token. Secure checkout by our merchant of record.'
            : 'Card top-ups are not enabled yet — an administrator can grant credit from the console.'
          : 'Org keys draw this balance. Only owners can top up.'}
      </p>
      {entries.length > 0 ? (
        <div className="mt-4 max-h-56 overflow-y-auto border-t border-zinc-800/70 pt-2">
          <table className="w-full text-left text-[12px]">
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-zinc-800/50 last:border-b-0">
                  <td className="py-1.5 pr-3 whitespace-nowrap text-zinc-500">{fmtWhen(e.created_at)}</td>
                  <td className="py-1.5 pr-3">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]',
                        e.kind === 'topup' ? 'bg-emerald-500/10 text-emerald-300' : e.kind === 'usage' ? 'bg-zinc-800 text-zinc-400' : 'bg-sky-500/10 text-sky-300',
                      )}
                    >
                      {e.delta_usd >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                      {e.kind}
                    </span>
                  </td>
                  <td className="max-w-0 truncate py-1.5 pr-3 text-zinc-500">{e.note ?? ''}</td>
                  <td className={cn('py-1.5 text-right font-mono', e.delta_usd >= 0 ? 'text-emerald-400' : 'text-zinc-300')}>
                    {e.delta_usd >= 0 ? '+' : ''}
                    {e.delta_usd.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

function OrgUsageCard({ org }: { org: PortalOrg }) {
  const qc = useQueryClient();
  const usage = useQuery({ queryKey: ['portal-org-usage', org.id], queryFn: () => portalApi.orgUsage(org.id, 25) });
  const rows: PortalUsageRow[] = usage.data ?? [];
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-zinc-800/70 px-5 py-4">
        <span className="text-[13px] font-medium text-zinc-200">Recent requests</span>
        <button className="text-[11px] text-zinc-500 transition-colors hover:text-zinc-300" onClick={() => {
          void qc.invalidateQueries({ queryKey: ['portal-org-usage', org.id] });
          void qc.invalidateQueries({ queryKey: ['portal-org-billing', org.id] });
        }}>
          Refresh
        </button>
      </div>
      {usage.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title="No requests yet" description="Calls made with this org's keys show up here with tokens and cost." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="text-[11px] tracking-wide text-zinc-500 uppercase">
              <tr>
                <th className="px-4 py-2.5 font-medium">When</th>
                <th className="px-4 py-2.5 font-medium">Model</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Tokens (in/out)</th>
                <th className="px-4 py-2.5 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-zinc-800/70">
                  <td className="px-4 py-2.5 whitespace-nowrap text-zinc-400">{fmtWhen(r.created_at)}</td>
                  <td className="px-4 py-2.5 font-mono text-[12px] text-zinc-200">{r.model_slug}</td>
                  <td className="px-4 py-2.5">
                    <span className={cn('font-mono text-[12px]', r.status < 400 ? 'text-emerald-400' : r.status < 500 ? 'text-amber-400' : 'text-red-400')}>{r.status}</span>
                  </td>
                  <td className="px-4 py-2.5 text-zinc-400">
                    {fmtTokens(r.tokens_in)} / {fmtTokens(r.tokens_out)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-300">{r.cost_usd == null ? '—' : fmtPrice(r.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function OrgDetail({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const me = useQuery({ queryKey: ['portal-me'], queryFn: portalApi.me });
  const org = useQuery({ queryKey: ['portal-org', orgId], queryFn: () => portalApi.org(orgId) });

  const leave = useMutation({
    mutationFn: () => portalApi.leaveOrg(orgId),
    onSuccess: () => {
      toast('You left the organization');
      void qc.invalidateQueries({ queryKey: ['portal-orgs'] });
      navigate('/app/teams');
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed to leave', 'err'),
  });
  const del = useMutation({
    mutationFn: () => portalApi.deleteOrg(orgId),
    onSuccess: () => {
      toast('Organization deleted');
      void qc.invalidateQueries({ queryKey: ['portal-orgs'] });
      navigate('/app/teams');
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed to delete', 'err'),
  });

  // Landing back from the Lemon Squeezy hosted checkout.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('topup') === 'success') {
      toast('Payment received — the org balance updates as soon as the webhook lands.');
      window.history.replaceState({}, '', `/app/teams/${orgId}`);
    }
  }, [orgId]);

  if (org.isLoading || me.isLoading) {
    return (
      <div className="flex justify-center py-24">
        <Spinner />
      </div>
    );
  }
  if (org.isError || !org.data) {
    return (
      <Card>
        <EmptyState
          icon={<Building className="h-6 w-6" />}
          title="Organization not found"
          description="It may have been deleted, or you are not a member."
          action={
            <Button size="sm" variant="outline" onClick={() => navigate('/app/teams')}>
              Back to teams
            </Button>
          }
        />
      </Card>
    );
  }

  const data = org.data;
  const myId = me.data?.user.id ?? '';

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link to="/app/teams" className="text-[11px] text-zinc-500 transition-colors hover:text-zinc-300">
            ← All teams
          </Link>
          <div className="mt-1 flex items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-100">{data.name}</h1>
            <RoleBadge role={data.role} />
            {!data.enabled ? <Badge tone="warn">disabled</Badge> : null}
          </div>
          <p className="mt-1 text-[13px] text-zinc-500">
            {data.role === 'owner' ? 'You manage this organization.' : 'You are a member — create keys and track usage.'}
          </p>
        </div>
        <div className="flex gap-2">
          {data.role === 'member' ? (
            <Button variant="outline" onClick={() => setConfirmingLeave(true)}>
              <LogOut className="h-4 w-4" />
              Leave
            </Button>
          ) : null}
          {data.role === 'owner' ? (
            <Button variant="danger" onClick={() => setConfirmingDelete(true)}>
              <Trash2 className="h-4 w-4" />
              Delete org
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <OrgBillingCard org={data} />
        </div>
        <div className="space-y-4 lg:col-span-2">
          <MembersCard org={data} myId={myId} />
          {data.role === 'owner' ? <JoinCodeCard org={data} /> : null}
        </div>
      </div>

      <div className="mt-4 space-y-4">
        <OrgKeysCard org={data} myId={myId} />
        <OrgUsageCard org={data} />
      </div>

      <ConfirmDialog
        open={confirmingLeave}
        title="Leave organization"
        body={`Leave '${data.name}'? Your org keys keep working until an owner removes them, but you lose access to this space.`}
        confirmLabel="Leave"
        busy={leave.isPending}
        onConfirm={() => {
          setConfirmingLeave(false);
          leave.mutate();
        }}
        onClose={() => setConfirmingLeave(false)}
      />
      <ConfirmDialog
        open={confirmingDelete}
        title="Delete organization"
        body={`Permanently delete '${data.name}'? All org keys stop working immediately and members lose access. Request logs are kept.`}
        confirmLabel="Delete org"
        busy={del.isPending}
        onConfirm={() => {
          setConfirmingDelete(false);
          del.mutate();
        }}
        onClose={() => setConfirmingDelete(false)}
      />
    </>
  );
}

export function PortalTeams() {
  const path = useRoute();
  const orgId = path.startsWith('/app/teams/') ? path.slice('/app/teams/'.length).split('/')[0] : '';
  if (orgId) return <OrgDetail orgId={orgId} />;
  return <OrgList />;
}
