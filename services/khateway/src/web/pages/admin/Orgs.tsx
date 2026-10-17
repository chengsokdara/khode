// Admin Organizations (/orgs) — M9. Platform admin stays global: every org is
// visible and manageable here without membership — rename, enable/disable,
// ledgered balance adjustments and deletion. Members/roles/invite codes are
// self-served by org owners in the portal (/app/teams).
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building, Trash2 } from 'lucide-react';
import { api, type OrgRow } from '../../api';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Spinner,
  Switch,
  Textarea,
  toast,
  fmtPrice,
} from '../../components/ui';

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function EditOrgModal({ org, onClose }: { org: OrgRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Re-seed the fields whenever a different org is opened.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (org && seededFor !== org.id) {
    setSeededFor(org.id);
    setName(org.name);
    setAmount('');
    setNote('');
    setError(null);
  }

  const patch = useMutation({
    mutationFn: () => {
      if (!org) throw new Error('No organization selected');
      const body: Record<string, unknown> = {};
      const trimmed = name.trim();
      if (trimmed && trimmed !== org.name) body.name = trimmed;
      const num = Number(amount);
      if (amount !== '' && Number.isFinite(num) && num !== 0) {
        body.balance_adjust_usd = num;
        if (note.trim()) body.note = note.trim();
      }
      return api.updateOrg(org.id, body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-orgs'] });
      toast('Organization updated');
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Update failed'),
  });

  if (!org) return null;

  const num = Number(amount);
  const valid = Boolean(name.trim()) && (amount === '' || (Number.isFinite(num) && num !== 0));

  return (
    <Modal
      open={Boolean(org)}
      onClose={() => {
        onClose();
        setError(null);
      }}
      title="Edit organization"
      description={`Members, keys and invite codes are managed by org owners in the portal. Current balance: ${fmtPrice(org.balance_usd)}.`}
    >
      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          autoFocus
        />
      </Field>
      <div className="mt-3">
        <Field label="Balance adjustment (USD, optional)" hint="Positive to grant credit, negative to remove it. Lands in the org's ledger.">
          <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 20 or -5" />
        </Field>
      </div>
      {amount !== '' && Number.isFinite(num) && num !== 0 ? (
        <div className="mt-3">
          <Field label="Note (optional)">
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why the adjustment?" />
          </Field>
        </div>
      ) : null}
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => patch.mutate()} disabled={!valid || patch.isPending}>
          {patch.isPending ? <Spinner className="border-zinc-900/70 border-t-transparent" /> : null}
          Save changes
        </Button>
      </div>
    </Modal>
  );
}

function OrgRowItem({ o, onEdit }: { o: OrgRow; onEdit: (id: string) => void }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const toggle = useMutation({
    mutationFn: () => api.updateOrg(o.id, { enabled: !o.enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-orgs'] }),
    onError: (e) => toast(e instanceof Error ? e.message : 'Update failed', 'err'),
  });
  const del = useMutation({
    mutationFn: () => api.deleteOrg(o.id),
    onSuccess: () => {
      toast('Organization deleted');
      void qc.invalidateQueries({ queryKey: ['admin-orgs'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Delete failed', 'err'),
  });

  return (
    <tr className="border-t border-zinc-800/70">
      <td className="px-5 py-3">
        <div className="text-[13px] text-zinc-100">{o.name}</div>
        <div className="text-[11px] text-zinc-500">
          created {fmtWhen(o.created_at)} · join code <code className="font-mono">{o.join_code}</code>
        </div>
      </td>
      <td className="px-5 py-3 font-mono text-[12px] text-emerald-400">{fmtPrice(o.balance_usd)}</td>
      <td className="px-5 py-3 text-zinc-400">{o.member_count}</td>
      <td className="px-5 py-3 text-zinc-400">{o.key_count}</td>
      <td className="px-5 py-3">
        <Switch checked={o.enabled} onChange={() => toggle.mutate()} disabled={toggle.isPending} />
      </td>
      <td className="px-5 py-3">
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="outline" onClick={() => onEdit(o.id)}>
            Edit
          </Button>
          <button
            className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-red-400"
            title="Delete organization"
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </td>
      <ConfirmDialog
        open={confirming}
        title="Delete organization"
        body={`Delete '${o.name}' permanently? Its ${o.key_count} org key(s) stop working immediately and members lose access. Request logs are kept.`}
        busy={del.isPending}
        onConfirm={() => {
          setConfirming(false);
          del.mutate();
        }}
        onClose={() => setConfirming(false)}
      />
    </tr>
  );
}

export function Orgs() {
  const orgs = useQuery({ queryKey: ['admin-orgs'], queryFn: api.orgs });
  const [editId, setEditId] = useState<string | null>(null);
  const editing = orgs.data?.find((o) => o.id === editId) ?? null;

  return (
    <>
      <PageHeader
        title="Organizations"
        subtitle="Teams created in the portal. Each org pools a prepaid balance drawn by its org-scoped keys — you can rename, disable, grant credit or delete any of them."
      />
      <Card>
        {orgs.isLoading ? (
          <div className="flex justify-center py-14">
            <Spinner />
          </div>
        ) : (orgs.data?.length ?? 0) === 0 ? (
          <EmptyState
            icon={<Building className="h-6 w-6" />}
            title="No organizations yet"
            description="Portal users create orgs at /app/teams — they get shared balances, member roles and org-scoped keys."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="text-[11px] tracking-wide text-zinc-500 uppercase">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Organization</th>
                  <th className="px-5 py-2.5 font-medium">Balance</th>
                  <th className="px-5 py-2.5 font-medium">Members</th>
                  <th className="px-5 py-2.5 font-medium">Keys</th>
                  <th className="px-5 py-2.5 font-medium">Enabled</th>
                  <th className="px-5 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {(orgs.data ?? []).map((o) => (
                  <OrgRowItem key={o.id} o={o} onEdit={setEditId} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <EditOrgModal org={editing} onClose={() => setEditId(null)} />
    </>
  );
}
