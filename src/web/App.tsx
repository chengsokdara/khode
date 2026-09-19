import { useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Boxes, Building, KeyRound, LogOut, MessageSquare, ScrollText, Server, Settings as SettingsIcon, Users as UsersIcon, type LucideIcon } from 'lucide-react';
import { api } from './api';
import { portalApi } from './portal-api';
import { navigate, useRoute, Link } from './router';
import { cn, Logo, Spinner } from './components/ui';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Providers } from './pages/Providers';
import { Models } from './pages/Models';
import { Playground } from './pages/Playground';
import { ApiKeys } from './pages/ApiKeys';
import { Logs } from './pages/Logs';
import { Users } from './pages/admin/Users';
import { Orgs } from './pages/admin/Orgs';
import { Settings } from './pages/admin/Settings';
import { PortalLogin } from './pages/portal/PortalLogin';
import { PortalShell } from './pages/portal/PortalShell';
import { PortalDashboard } from './pages/portal/PortalDashboard';
import { PortalKeys } from './pages/portal/PortalKeys';
import { PortalTeams } from './pages/portal/PortalTeams';

const NAV: { to: string; label: string; icon: LucideIcon; soon?: string }[] = [
  { to: '/', label: 'Overview', icon: Activity },
  { to: '/providers', label: 'Providers', icon: Server },
  { to: '/models', label: 'Models', icon: Boxes },
  { to: '/playground', label: 'Playground', icon: MessageSquare },
  { to: '/api-keys', label: 'API Keys', icon: KeyRound },
  { to: '/users', label: 'Users', icon: UsersIcon },
  { to: '/orgs', label: 'Organizations', icon: Building },
  { to: '/logs', label: 'Logs', icon: ScrollText },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

function Shell({ children, onLogout }: { children: ReactNode; onLogout: () => void }) {
  const path = useRoute();
  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-zinc-800/80 bg-zinc-950">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <Logo size={26} />
          <div>
            <div className="text-[15px] leading-none font-semibold tracking-tight text-zinc-100">Khateway</div>
            <div className="mt-1 text-[10px] text-zinc-500">AI model router</div>
          </div>
        </div>
        <nav className="mt-2 flex flex-1 flex-col gap-0.5 px-3">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = path === item.to;
            const cls = cn(
              'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors',
              active ? 'bg-zinc-800/80 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
              item.soon && 'opacity-40',
            );
            const inner = (
              <>
                <Icon className="h-4 w-4" />
                {item.label}
                {item.soon ? <span className="ml-auto text-[10px] text-zinc-500">{item.soon}</span> : null}
              </>
            );
            return item.soon ? (
              <span key={item.to} className={cn(cls, 'cursor-not-allowed select-none')} title={`${item.label} — arrives in ${item.soon}`}>
                {inner}
              </span>
            ) : (
              <Link key={item.to} to={item.to} className={cls} title={item.label}>
                {inner}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-zinc-800/70 p-3">
          <button
            onClick={onLogout}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
          <div className="px-3 pt-2 pb-1 text-[10px] text-zinc-600">MVP · M1–M7 · development</div>
        </div>
      </aside>
      <main className="ml-60 min-w-0">
        <div className="mx-auto max-w-6xl px-8 py-8">{children}</div>
      </main>
    </div>
  );
}

/** User portal (/app*): its own session + 401 redirect surface. */
function Portal() {
  const path = useRoute();
  const qc = useQueryClient();

  useEffect(() => {
    const go = () => {
      qc.clear();
      navigate('/app/login');
    };
    window.addEventListener('khateway:portal-unauthorized', go);
    return () => window.removeEventListener('khateway:portal-unauthorized', go);
  }, [qc]);

  const me = useQuery({ queryKey: ['portal-me'], queryFn: portalApi.me, retry: false });

  if (path === '/app/login') return <PortalLogin />;
  if (me.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (me.isError || !me.data) return <PortalLogin />;

  let page: ReactNode;
  if (path === '/app') page = <PortalDashboard />;
  else if (path === '/app/keys') page = <PortalKeys />;
  else if (path === '/app/teams' || path.startsWith('/app/teams/')) page = <PortalTeams />;
  else
    page = (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-6 py-14 text-center text-sm text-zinc-400">
        Page not found. <Link to="/app" className="text-emerald-400 hover:underline">Back to overview</Link>
      </div>
    );
  return <PortalShell user={me.data.user}>{page}</PortalShell>;
}

export default function App() {
  const path = useRoute();
  const qc = useQueryClient();

  useEffect(() => {
    const go = () => {
      qc.clear();
      navigate('/login');
    };
    window.addEventListener('khateway:unauthorized', go);
    return () => window.removeEventListener('khateway:unauthorized', go);
  }, [qc]);

  if (path === '/login') return <Login />;
  if (path === '/app' || path.startsWith('/app/')) return <Portal />;

  let page: ReactNode;
  if (path === '/') page = <Overview />;
  else if (path === '/providers') page = <Providers />;
  else if (path === '/models') page = <Models />;
  else if (path === '/playground') page = <Playground />;
  else if (path === '/api-keys') page = <ApiKeys />;
  else if (path === '/users') page = <Users />;
  else if (path === '/orgs') page = <Orgs />;
  else if (path === '/logs') page = <Logs />;
  else if (path === '/settings') page = <Settings />;
  else
    page = (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-6 py-14 text-center text-sm text-zinc-400">
        Page not found. <Link to="/" className="text-emerald-400 hover:underline">Back to overview</Link>
      </div>
    );

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      // ignore network errors during sign-out
    }
    qc.clear();
    navigate('/login');
  };

  return <Shell onLogout={logout}>{page}</Shell>;
}
