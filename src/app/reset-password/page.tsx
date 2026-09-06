"use client";

import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, Sparkles } from "lucide-react";
import { LoaderCircle } from "lucide-react";
import { createClient } from "@/supabase/client";

export default function ResetPasswordPage() {
  const [checking, setChecking] = useState(true);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [updated, setUpdated] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) {
        window.location.assign("/login?error=session_expired");
        return;
      }
      setChecking(false);
    });
  }, []);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setMessage({ kind: "error", text: "Passwords do not match." });
      return;
    }

    setSubmitting(true);
    setMessage(null);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) {
        setMessage({ kind: "error", text: error.message });
      } else {
        setUpdated(true);
        setMessage({ kind: "success", text: "Password updated." });
      }
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Unable to update the password." });
    } finally {
      setSubmitting(false);
    }
  };

  if (checking) {
    return (
      <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10 sm:px-6">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_-10%,rgba(124,92,255,.22),transparent_38%)]" />
        <LoaderCircle className="size-6 animate-spin text-[#7c5cff]" />
      </main>
    );
  }

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10 sm:px-6">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_-10%,rgba(124,92,255,.22),transparent_38%)]" />
      <section className="studio-card relative w-full max-w-md p-6 sm:p-8">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-[#7c5cff]"><Sparkles className="size-6" /></span>
          <h1 className="text-2xl font-semibold tracking-tight">Set a new password</h1>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="new-password" className="studio-label">New password</label>
            <input id="new-password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required minLength={8} disabled={submitting || updated} className="studio-control" autoComplete="new-password" />
          </div>
          <div>
            <label htmlFor="confirm-password" className="studio-label">Confirm password</label>
            <input id="confirm-password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required disabled={submitting || updated} className="studio-control" autoComplete="new-password" />
          </div>
          {updated ? (
            <button type="button" onClick={() => window.location.assign("/projects")} className="studio-button-primary w-full">
              Continue to projects <ArrowRight className="ml-1 inline size-4" />
            </button>
          ) : (
            <button type="submit" disabled={submitting || !newPassword || !confirmPassword} className="studio-button-primary w-full">
              {submitting ? "Updating…" : "Update password"}
            </button>
          )}
          {message && <div role={message.kind === "error" ? "alert" : "status"} aria-live="polite" className={`rounded-xl border px-4 py-3 text-sm ${message.kind === "success" ? "border-[#35c48d]/30 bg-[#35c48d]/10 text-[#7ee2bc]" : "border-[#ef6262]/30 bg-[#ef6262]/10 text-[#ff9b9b]"}`}>
            <span className="flex gap-2">{message.kind === "success" && <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}{message.text}</span>
          </div>}
        </form>
      </section>
    </main>
  );
}
