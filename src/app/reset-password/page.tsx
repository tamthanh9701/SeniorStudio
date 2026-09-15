"use client";

import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, Sparkles } from "lucide-react";
import { LoaderCircle } from "lucide-react";
import { createClient } from "@/supabase/client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
      <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
        <LoaderCircle className="size-6 animate-spin text-primary" />
      </main>
    );
  }

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <Card className="relative w-full max-w-md">
        <CardHeader className="items-center text-center">
          <span className="mb-2 flex size-12 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Sparkles className="size-6" /></span>
          <CardTitle className="text-2xl">Set a new password</CardTitle>
        </CardHeader>
        <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-password" className="text-xs font-semibold">New password</Label>
            <Input id="new-password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required minLength={8} disabled={submitting || updated} autoComplete="new-password" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password" className="text-xs font-semibold">Confirm password</Label>
            <Input id="confirm-password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required disabled={submitting || updated} autoComplete="new-password" />
          </div>
          {updated ? (
            <Button type="button" onClick={() => window.location.assign("/projects")} className="w-full">
              Continue to projects <ArrowRight className="ml-1 inline size-4" />
            </Button>
          ) : (
            <Button type="submit" className="w-full" disabled={submitting || !newPassword || !confirmPassword}>
              {submitting ? "Updating…" : "Update password"}
            </Button>
          )}
          {message && (
            <Alert
              variant={message.kind === "error" ? "destructive" : "default"}
              role={message.kind === "error" ? "alert" : "status"}
              aria-live="polite"
              className={message.kind === "success" ? "border-success/30 bg-success/10 text-success" : undefined}
            >
              <AlertDescription className="flex gap-2">
                {message.kind === "success" && <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}
                {message.text}
              </AlertDescription>
            </Alert>
          )}
        </form>
        </CardContent>
      </Card>
    </main>
  );
}
