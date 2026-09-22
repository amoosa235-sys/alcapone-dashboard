import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

/**
 * `next` is read here rather than in the form so that the form is server
 * rendered. Reading it client-side would put the whole form behind a Suspense
 * boundary and leave the page blank until JavaScript loads.
 */
export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const raw = params.next;
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  const next =
    candidate?.startsWith("/") && !candidate.startsWith("//") ? candidate : "";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Support dashboard
        </h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Sign in, or create an account if this is your first time.
        </p>
      </header>

      <LoginForm next={next} />
    </main>
  );
}
