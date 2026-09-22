"use client";

import { useActionState } from "react";

import { signIn, signUp, type AuthFormState } from "./actions";

const EMPTY: AuthFormState = { error: null };

export function LoginForm({ next }: { next: string }) {
  const [signInState, signInAction, signingIn] = useActionState(signIn, EMPTY);
  const [signUpState, signUpAction, signingUp] = useActionState(signUp, EMPTY);

  const message = signInState.error ?? signUpState.error;
  const busy = signingIn || signingUp;

  return (
    <form className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Email</span>
        <input
          name="email"
          type="email"
          autoComplete="email"
          required
          className="rounded-md border border-black/15 px-3 py-2 dark:border-white/20"
        />
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="rounded-md border border-black/15 px-3 py-2 dark:border-white/20"
        />
      </label>

      {message ? (
        <p role="alert" className="text-sm text-red-600">
          {message}
        </p>
      ) : null}

      <div className="mt-2 flex gap-3">
        <button
          formAction={signInAction}
          disabled={busy}
          className="flex-1 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {signingIn ? "Signing in…" : "Sign in"}
        </button>
        <button
          formAction={signUpAction}
          disabled={busy}
          className="flex-1 rounded-md border border-black/15 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-white/20"
        >
          {signingUp ? "Creating…" : "Create account"}
        </button>
      </div>
    </form>
  );
}
