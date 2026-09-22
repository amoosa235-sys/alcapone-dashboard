import { redirect } from "next/navigation";

import { getMembership, getUser, hasAnyTenant } from "@/lib/auth";

import { SetupForm } from "./setup-form";

export const metadata = { title: "Set up your workspace" };
export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const user = await getUser();
  if (!user) {
    redirect("/login");
  }

  if (await getMembership()) {
    redirect("/");
  }

  if (await hasAnyTenant()) {
    redirect("/pending");
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Set up your workspace
        </h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Every ticket, channel and agent lives under this workspace. You will
          be its owner.
        </p>
      </header>

      <SetupForm />
    </main>
  );
}
