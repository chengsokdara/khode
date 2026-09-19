import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Users as UsersIcon } from 'lucide-react';
import { api, type PortalUserRow } from '../../api';
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

function AdjustBalanceModal({ user, onClose }: { user: PortalUserRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const patch = useMutation({
    mutationFn: () => api.updateUser(user!.id, { balance_adjust_usd: Number(amount), note: note || undefined }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
      toast(`Balance adjusted for ${user!.email}`);
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Adjustment failed'),
  });

  if (!user) return null;
  const num = Number(amount);
  const valid = amount !== '' && Number.isFinite(num) && num !== 0;

  return (
    <Modal
      open={Boolean(user)}
      onClose={() => {
        onClose();
        setError(null);
      }}
      title="Adjust balance"
      description={`Grant or remove prepaid credit for ${user.email} (current: ${fmtPrice(user.balance_usd)}).`}
    >
      <Field label="Amount (USD)" hint="Positive to grant credit, negative to remove it. The adjustment is recorded in the user's ledger.">
        <Input
          type="number"
          step="0.01"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setError(null);
          }}
          placeholder="e.g. 5 or -2.50"
          autoFocus
        />
      </Field>
      <div className="mt-3">
        <Field label="Note (optional)">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why the adjustment?" />
        </Field>
      </div>
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={() => patch.mutate()}
          disabled={!valid || patch.isPending}
        >
          {patch.isPending ? <Spinner className="border-zinc-900/70 border-t-transparent" /> : null}
          Apply adjustment
        </Button>
      </div>
    </Modal>
  );
}

function UserRow({ u, onAdjust }: { u: PortalUserRow; onAdjust: (id: string) => void }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const toggle = useMutation({
    mutationFn: () => api.updateUser(u.id, { enabled: !u.enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-users'] }),
    onError: (e) => toast(e instanceof Error ? e.message : 'Update failed', 'err'),
  });
  const del = useMutation({
    mutationFn: () => api.deleteUser(u.id),
    onSuccess: () => {
      toast('User deleted');
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Delete failed', 'err'),
  });

  return (
    <tr className="border-t border-zinc-800/70">
      <td className="px-5 py-3">
        <div className="text-[13px] text-zinc-100">{u.email}</div>
        <div className="text-[11px] text-zinc-500">joined {fmtWhen(u.created_at)}</div>
      </td>
      <td className="px-5 py-3 font-mono text-[12px] text-emerald-400">{fmtPrice(u.balance_usd)}</td>
      <td className="px-5 py-3 text-zinc-400">{u.key_count}</td>
      <td className="px-5 py-3">
        <Switch checked={u.enabled} onChange={() => toggle.mutate()} disabled={toggle.isPending} />
      </td>
      <td className="px-5 py-3">
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="outline" onClick={() => onAdjust(u.id)}>
            Adjust
          </Button>
          <button
            className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-red-400"
            title="Delete user"
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </td>
      <ConfirmDialog
        open={confirming}
        title="Delete user"
        body={`Delete ${u.email} permanently? Their keys stop working immediately; request logs are kept.`}
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

export function Users() {
  const users = useQuery({ queryKey: ['admin-users'], queryFn: api.users });
  const [adjustId, setAdjustId] = useState<string | null>(null);
  const adjusting = users.data?.find((u) => u.id === adjustId) ?? null;

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Portal accounts. Requests made with user-owned keys draw each user's prepaid balance."
      />
      <Card>
        {users.isLoading ? (
          <div className="flex justify-center py-14">
            <Spinner />
          </div>
        ) : (users.data?.length ?? 0) === 0 ? (
          <EmptyState
            icon={<UsersIcon className="h-6 w-6" />}
            title="No users yet"
            description="Users self-serve at /app — sign up, create keys, top up. You can also grant credit manually here."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="text-[11px] tracking-wide text-zinc-500 uppercase">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Email</th>
                  <th className="px-5 py-2.5 font-medium">Balance</th>
                  <th className="px-5 py-2.5 font-medium">Keys</th>
                  <th className="px-5 py-2.5 font-medium">Enabled</th>
                  <th className="px-5 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {(users.data ?? []).map((u) => (
                  <UserRow key={u.id} u={u} onAdjust={setAdjustId} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <AdjustBalanceModal user={adjusting} onClose={() => setAdjustId(null)} />
    </>
  );
}
