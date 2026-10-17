import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { portalApi, type PortalKey } from '../../portal-api';
import { Button, Card, ConfirmDialog, EmptyState, Input, Modal, PageHeader, Spinner, Switch, toast, fmtPrice } from '../../components/ui';

function fmtWhen(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function CreateKeyModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (k: PortalKey) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => portalApi.createKey({ name }),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ['portal-keys'] });
      setName('');
      setError(null);
      onCreated(created); // hand the one-time raw key to the reveal modal
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Failed to create key'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setError(null);
      }}
      title="Create API key"
      description="Use it as a Bearer token (OpenAI SDKs) or x-api-key (Anthropic SDKs) against /v1."
    >
      <Input
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        placeholder="e.g. my coding agent"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim()) create.mutate();
        }}
      />
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => create.mutate()} disabled={create.isPending || !name.trim()}>
          {create.isPending ? <Spinner className="border-zinc-900/70 border-t-transparent" /> : null}
          Create key
        </Button>
      </div>
    </Modal>
  );
}

/** One-time raw-key reveal (the DB only stores a hash). */
function RevealKeyModal({ keyRow, onClose }: { keyRow: PortalKey | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  if (!keyRow?.key) return null;
  return (
    <Modal open onClose={onClose} title="Your new API key" description="Copy it now — this is the only time the full key is shown.">
      <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5">
        <code className="flex-1 truncate font-mono text-[13px] text-emerald-300">{keyRow.key}</code>
        <button
          className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          title="Copy"
          onClick={() => {
            void navigator.clipboard.writeText(keyRow.key!);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>
      <p className="mt-3 text-xs text-zinc-500">
        Point your SDK at this deployment: <code className="text-zinc-400">{window.location.origin}/v1</code>
      </p>
      <div className="mt-5 flex justify-end">
        <Button onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}

function KeyRow({ k }: { k: PortalKey }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const toggle = useMutation({
    mutationFn: () => portalApi.updateKey(k.id, { enabled: !k.enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['portal-keys'] }),
  });
  const del = useMutation({
    mutationFn: () => portalApi.deleteKey(k.id),
    onSuccess: () => {
      toast('Key deleted');
      void qc.invalidateQueries({ queryKey: ['portal-keys'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Delete failed', 'err'),
  });

  return (
    <tr className="border-t border-zinc-800/70">
      <td className="px-5 py-3">
        <div className="text-[13px] text-zinc-100">{k.name}</div>
        <div className="font-mono text-[11px] text-zinc-500">{k.key_prefix}…</div>
      </td>
      <td className="px-5 py-3 text-zinc-400">{fmtWhen(k.created_at)}</td>
      <td className="px-5 py-3 text-zinc-400">{fmtWhen(k.last_used_at)}</td>
      <td className="px-5 py-3 text-zinc-400">
        {k.request_count} · {fmtPrice(k.spent_usd)}
      </td>
      <td className="px-5 py-3">
        <Switch checked={k.enabled} onChange={() => toggle.mutate()} disabled={toggle.isPending} />
      </td>
      <td className="px-5 py-3 text-right">
        <button
          className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-red-400"
          title="Delete key"
          onClick={() => setConfirming(true)}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </td>
      <ConfirmDialog
        open={confirming}
        title="Delete API key"
        body={`Delete '${k.name}' (${k.key_prefix}…)? Clients using it will stop working immediately.`}
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

export function PortalKeys() {
  const keys = useQuery({ queryKey: ['portal-keys'], queryFn: portalApi.keys });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<PortalKey | null>(null);

  return (
    <>
      <PageHeader
        title="API keys"
        subtitle="Keys you create call the gateway as your account — usage draws your prepaid balance."
        action={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            New key
          </Button>
        }
      />
      <Card>
        {keys.isLoading ? (
          <div className="flex justify-center py-14">
            <Spinner />
          </div>
        ) : (keys.data?.length ?? 0) === 0 ? (
          <EmptyState
            icon={<KeyRound className="h-6 w-6" />}
            title="No API keys yet"
            description="Create a key, then point any OpenAI or Anthropic SDK at this deployment's /v1."
            action={
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="h-3.5 w-3.5" />
                Create your first key
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="text-[11px] tracking-wide text-zinc-500 uppercase">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Key</th>
                  <th className="px-5 py-2.5 font-medium">Created</th>
                  <th className="px-5 py-2.5 font-medium">Last used</th>
                  <th className="px-5 py-2.5 font-medium">Requests · spent</th>
                  <th className="px-5 py-2.5 font-medium">Enabled</th>
                  <th className="px-5 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {(keys.data ?? []).map((k) => (
                  <KeyRow key={k.id} k={k} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <CreateKeyModal open={creating} onClose={() => setCreating(false)} onCreated={setCreated} />
      <RevealKeyModal keyRow={created} onClose={() => setCreated(null)} />
    </>
  );
}
