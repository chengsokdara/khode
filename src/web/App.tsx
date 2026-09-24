import { useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Boxes, Building, KeyRound, LogOut, MessageSquare, ScrollText, Server, Settings as SettingsIcon, Users as UsersIcon, type LucideIcon } from 'lucide-react';
import { api } from './api';
import { portalApi } from './portal-api';
import { navigate, replace, useRoute, Link } from './router';
import { cn, Logo, Spinner } from './components/ui';
import { Landing } from './pages/Landing';
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
import { PortalDevice } from './pages/portal/PortalDevice';

const NAV: { to: string; label: string; icon: LucideIcon; soon?: string }[] = [
  { to: '/admin', label: 'Overview', icon: Activity },
  { to: '/admin/providers', label: 'Providers', icon: Server },
  { to: '/admin/models', label: 'Models', icon: Boxes },
  { to: '/admin/playground', label: 'Playground', icon: MessageSquare },
  { to: '/admin/api-keys', label: 'API Keys', icon: KeyRound },
  { to: '/admin/users', label: 'Users', icon: UsersIcon },
  { to: '/admin/orgs', label: 'Organizations', icon: Building },
  { to: '/admin/logs', label: 'Logs', icon: ScrollText },
  { to: '/admin/settings', label: 'Settings', icon: SettingsIcon },
];

/** Pre-/admin bookmarks: root-level console paths redirect to their /admin homes. */
const LEGACY_ROUTES: Record<string, string> = {
  '/login': '/admin/login',
  '/overview': '/admin',
  '/providers': '/admin/providers',
  '/models': '/admin/models',
  '/playground': '/admin/playground',
  '/api-keys': '/admin/api-keys',
  '/users': '/admin/users',
  '/orgs': '/admin/orgs',
  '/logs': '/admin/logs',
  '/settings': '/admin/settings',
};

function Redirect({ to }: { to: string }) {
  useEffect(() => replace(to), [to]);
  return null;
}

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
          <div className="px-3 pt-2 pb-1 text-[10px] text-zinc-600">M1–M14 · development</div>
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

  /** Login target that remembers where the user was headed — the device
   * verification link must survive the login round-trip. */
  const loginWithNext = (p: string) => `/app/login?next=${encodeURIComponent(p + window.location.search)}`;

  useEffect(() => {
    const go = () => {
      // Already on the login page: a background me() 401 fires here on every
      // mount, and re-navigating would bury the page's own ?error=/?next=
      // inside a nested next= (the OAuth failure + device-link params).
      if (path === '/app/login') return;
      qc.clear();
      navigate(loginWithNext(path));
    };
    window.addEventListener('khateway:portal-unauthorized', go);
    return () => window.removeEventListener('khateway:portal-unauthorized', go);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc, path]);

  const me = useQuery({ queryKey: ['portal-me'], queryFn: portalApi.me, retry: false });

  if (path === '/app/login') return <PortalLogin />;
  if (me.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (me.isError || !me.data) return <Redirect to={loginWithNext(path === '/app/login' ? '/app' : path)} />;

  let page: ReactNode;
  if (path === '/app') page = <PortalDashboard />;
  else if (path === '/app/keys') page = <PortalKeys />;
  else if (path === '/app/device') page = <PortalDevice />;
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
      navigate('/admin/login');
    };
    window.addEventListener('khateway:unauthorized', go);
    return () => window.removeEventListener('khateway:unauthorized', go);
  }, [qc]);

  if (path === '/') return <Landing />;
  if (path === '/app' || path.startsWith('/app/')) return <Portal />;
  if (LEGACY_ROUTES[path]) return <Redirect to={LEGACY_ROUTES[path]} />;
  if (path === '/admin/login') return <Login />;

  if (path !== '/admin' && !path.startsWith('/admin/'))
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-6 py-14 text-center text-sm text-zinc-400">
          Page not found. <Link to="/" className="text-emerald-400 hover:underline">Back home</Link>
        </div>
      </div>
    );

  let page: ReactNode;
  if (path === '/admin') page = <Overview />;
  else if (path === '/admin/providers') page = <Providers />;
  else if (path === '/admin/models') page = <Models />;
  else if (path === '/admin/playground') page = <Playground />;
  else if (path === '/admin/api-keys') page = <ApiKeys />;
  else if (path === '/admin/users') page = <Users />;
  else if (path === '/admin/orgs') page = <Orgs />;
  else if (path === '/admin/logs') page = <Logs />;
  else if (path === '/admin/settings') page = <Settings />;
  else
    page = (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-6 py-14 text-center text-sm text-zinc-400">
        Page not found. <Link to="/admin" className="text-emerald-400 hover:underline">Back to overview</Link>
      </div>
    );

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      // ignore network errors during sign-out
    }
    qc.clear();
    navigate('/admin/login');
  };

  return <Shell onLogout={logout}>{page}</Shell>;
}
