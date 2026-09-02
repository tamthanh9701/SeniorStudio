"use client";

import { Suspense, useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, Sparkles } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/supabase/client";

function LoginInner() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    const error = searchParams.get("error");
    if (error) {
      setMessage({ kind: "error", text: decodeURIComponent(error) });
    }
  }, [searchParams]);

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setMessage(null);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim().toLowerCase(),
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });

      if (error) {
        setMessage({ kind: "error", text: error.message });
      } else {
        setMessage({ kind: "success", text: "Magic link sent. Check your email to continue." });
      }
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Unable to send the magic link." });
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10 sm:px-6">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_-10%,rgba(124,92,255,.22),transparent_38%)]" />
      <section className="studio-card relative w-full max-w-md p-6 sm:p-8">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-[#7c5cff]"><Sparkles className="size-6" /></span>
          <h1 className="text-2xl font-semibold tracking-tight">Welcome to SeniorStudio</h1>
          <p className="mt-2 text-sm leading-6 text-[#98a2b3]">Generate and refine images in a focused, immutable creative workspace.</p>
        </div>
        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label htmlFor="email" className="studio-label">Email address</label>
            <input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={loading} className="studio-control" placeholder="owner@example.com" autoComplete="email" />
          </div>
          <button type="submit" disabled={loading || !email.trim()} className="studio-button-primary w-full">
            {loading ? "Sending magic link…" : <>Continue with email <ArrowRight className="size-4" /></>}
          </button>
          {message && <div role={message.kind === "error" ? "alert" : "status"} aria-live="polite" className={`rounded-xl border px-4 py-3 text-sm ${message.kind === "success" ? "border-[#35c48d]/30 bg-[#35c48d]/10 text-[#7ee2bc]" : "border-[#ef6262]/30 bg-[#ef6262]/10 text-[#ff9b9b]"}`}>
            <span className="flex gap-2">{message.kind === "success" && <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}{message.text}</span>
          </div>}
        </form>
        <p className="mt-6 text-center text-xs leading-5 text-[#667085]">No password required. We will send a secure, single-use sign-in link.</p>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="flex min-h-dvh items-center justify-center text-sm text-[#98a2b3]">Loading sign in…</div>}>
      <LoginInner />
    </Suspense>
  );
}
