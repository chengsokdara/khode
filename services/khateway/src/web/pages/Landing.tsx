// Public landing page at / — the only page a visitor sees without signing in.
// Links only to the user portal (/app); the admin console (/admin) is deliberately
// unlinked — it's the operator surface, reached by URL/bookmark only.
import { ArrowRight, Boxes, Database, Gauge, Languages, Route, Users } from 'lucide-react';
import { Link } from '../router';
import { Card, Logo } from '../components/ui';

const FEATURES: { icon: typeof Languages; title: string; text: string }[] = [
  {
    icon: Languages,
    title: 'Three API dialects, one gateway',
    text: 'OpenAI Chat Completions, OpenAI Responses and Anthropic Messages — clients keep their SDK and just point it at Khateway.',
  },
  {
    icon: Route,
    title: 'Routing + fallback chains',
    text: 'Model slugs resolve to provider models with per-provider pins and automatic failover on 429, 5xx, timeout or network errors.',
  },
  {
    icon: Boxes,
    title: 'Cross-dialect translation',
    text: 'Requests and streaming responses are translated both ways — an Anthropic client can talk to an OpenAI or Gemini model seamlessly.',
  },
  {
    icon: Gauge,
    title: 'Rate limits + spend caps',
    text: 'Per-key, per-IP and per-model request caps plus prepaid balances and per-key spend limits and allowed-model lists.',
  },
  {
    icon: Database,
    title: 'Semantic cache',
    text: 'Opt-in per model or per key — dialect-independent cache entries serve identical requests with a single upstream call.',
  },
  {
    icon: Users,
    title: 'Teams + billing',
    text: 'Organizations with shared prepaid balances, a self-serve user portal and per-request usage, latency and cost logs.',
  },
];

export function Landing() {
  return (
    <div className="flex min-h-screen flex-col bg-zinc-950">
      <header className="border-b border-zinc-800/80">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-6">
          <div className="flex items-center gap-2.5">
            <Logo size={26} />
            <span className="text-[15px] font-semibold tracking-tight text-zinc-100">Khateway</span>
          </div>
          <nav className="flex items-center gap-2">
            <Link
              to="/app"
              className="inline-flex h-8 items-center rounded-lg bg-emerald-500 px-3 text-xs font-medium text-zinc-950 transition-colors hover:bg-emerald-400"
            >
              Portal
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="bg-[radial-gradient(60%_50%_at_50%_0%,rgba(16,185,129,0.09),transparent)]">
          <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-6 py-24 text-center">
            <span className="rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1 text-[11px] text-zinc-400">
              Self-hosted AI model router
            </span>
            <h1 className="mt-6 text-4xl font-semibold tracking-tight text-zinc-100 sm:text-5xl">
              One base URL for <span className="text-emerald-400">every model</span>
            </h1>
            <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-zinc-400">
              Point any OpenAI or Anthropic SDK at a single endpoint. Khateway authenticates the client,
              resolves the model, translates between API dialects both ways and logs every token, request
              and cent — on your own infrastructure.
            </p>
            <div className="mt-8 flex items-center gap-3">
              <Link
                to="/app"
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-500 px-5 text-sm font-medium text-zinc-950 transition-colors hover:bg-emerald-400"
              >
                Create an account
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-5xl px-6 pb-24">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => {
              const Icon = f.icon;
              return (
                <Card key={f.title} className="p-5">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10">
                    <Icon className="h-4.5 w-4.5 text-emerald-400" />
                  </div>
                  <h2 className="mt-4 text-sm font-medium text-zinc-100">{f.title}</h2>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-zinc-400">{f.text}</p>
                </Card>
              );
            })}
          </div>
        </section>
      </main>

      <footer className="border-t border-zinc-800/80">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-6 text-[11px] text-zinc-600">
          <span>Khateway — self-hosted AI model router</span>
          <div className="flex items-center gap-4">
            <Link to="/app" className="hover:text-zinc-400">Portal</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
