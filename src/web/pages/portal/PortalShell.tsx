import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Building, KeyRound, LogOut, Wallet, type LucideIcon } from 'lucide-react';
import { portalApi, type PortalUser } from '../../portal-api';
import { navigate, useRoute, Link } from '../../router';
import { Logo, cn, fmtPrice } from '../../components/ui';

const NAV: { to: string; label: string; icon: LucideIcon; prefix?: boolean }[] = [
  { to: '/app', label: 'Overview', icon: Wallet },
  { to: '/app/keys', label: 'API Keys', icon: KeyRound },
  { to: '/app/teams', label: 'Teams', icon: Building, prefix: true },
];

/** Top-bar shell for the user portal (contrast with the admin sidebar shell). */
export function PortalShell({ user, children }: { user: PortalUser; children: ReactNode }) {
  const path = useRoute();
  const qc = useQueryClient();

  const logout = async () => {
    try {
      await portalApi.logout();
    } catch {
      // ignore network errors during sign-out
    }
    qc.clear();
    navigate('/app/login');
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-5 px-6">
          <Link to="/app" className="flex items-center gap-2.5">
            <Logo size={22} />
            <span className="text-[15px] font-semibold tracking-tight text-zinc-100">Khateway</span>
          </Link>
          <nav className="flex items-center gap-1">
            {NAV.map((item) => {
              const Icon = item.icon;
              const active = item.prefix ? path === item.to || path.startsWith(`${item.to}/`) : path === item.to;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    'flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] transition-colors',
                    active ? 'bg-zinc-800/80 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-4">
            <div className="text-right">
              <div className="text-[11px] text-zinc-500">Balance</div>
              <div className={cn('text-[13px] font-semibold', user.balance_usd > 0 ? 'text-emerald-400' : 'text-zinc-400')}>
                {fmtPrice(user.balance_usd)}
              </div>
            </div>
            <div className="hidden text-right sm:block">
              <div className="text-[11px] text-zinc-500">Signed in</div>
              <div className="max-w-48 truncate text-[13px] text-zinc-300">{user.email}</div>
            </div>
            <button
              onClick={logout}
              title="Sign out"
              className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
