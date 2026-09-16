"use client";

import { Suspense, useState } from "react";
import { ArrowRight, CheckCircle2, Sparkles } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/supabase/client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function LoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialError = searchParams.get("error");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "reset">("signin");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(
    initialError ? { kind: "error", text: decodeURIComponent(initialError) } : null,
  );

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setMessage(null);

    try {
      const supabase = createClient();
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim().toLowerCase(),
          password,
        });

        if (error) {
          setMessage({ kind: "error", text: error.message });
          return;
        }
        router.replace("/projects");
        router.refresh();
        return;
      }

      const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
        redirectTo: `${window.location.origin}/auth/callback`,
      });
      if (error) {
        setMessage({ kind: "error", text: error.message });
      } else {
        setMessage({ kind: "success", text: "Reset link sent. Check your email to set a new password." });
      }
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : mode === "signin" ? "Unable to sign in." : "Unable to send the reset link." });
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <Card className="relative w-full max-w-md">
        <CardHeader className="items-center text-center">
          <span className="mb-2 flex size-12 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Sparkles className="size-6" /></span>
          <CardTitle className="text-2xl">Welcome to SeniorStudio</CardTitle>
          <CardDescription>Generate and refine images in a focused, immutable creative workspace.</CardDescription>
        </CardHeader>
        <CardContent>
        <form onSubmit={handleLogin} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email" className="text-xs font-semibold">Email address</Label>
            <Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={loading} placeholder="owner@example.com" autoComplete="email" />
          </div>
          {mode === "signin" && (
            <div className="space-y-2">
              <Label htmlFor="password" className="text-xs font-semibold">Password</Label>
              <Input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={loading} autoComplete="current-password" />
            </div>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={loading || !email.trim() || (mode === "signin" && !password)}
          >
            {loading
              ? mode === "signin" ? "Signing in…" : "Sending…"
              : mode === "signin" ? <>Sign in <ArrowRight className="size-4" /></> : "Send reset link"}
          </Button>
          {mode === "signin" ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => { setMode("reset"); setMessage(null); }}
              className="mx-auto block text-xs text-muted-foreground"
            >
              Forgot password?
            </Button>
          ) : (
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => { setMode("signin"); setMessage(null); setPassword(""); }}
              className="mx-auto block text-xs text-muted-foreground"
            >
              Back to sign in
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
        <p className="mt-6 text-center text-xs leading-5 text-muted-foreground">Sign in with your email and password.</p>
        </CardContent>
      </Card>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="flex min-h-dvh items-center justify-center bg-background text-sm text-muted-foreground">Loading sign in…</div>}>
      <LoginInner />
    </Suspense>
  );
}
