"use client";

import { useEffect, useState } from "react";
import { API_BASE, signIn } from "@/lib/auth";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n";

/** Subtitle of the (server-rendered) login page. */
export function LoginSubtitle() {
  const t = useT();
  return t("auth.login.subtitle");
}

export default function LoginForm() {
  const t = useT();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // First start: no user yet → go straight to setup.
  useEffect(() => {
    fetch(`${API_BASE}/auth/setup-status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.needs_setup && router.replace("/register"))
      .catch(() => {});
  }, [router]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const result = await signIn({ email, password, rememberMe });

    setLoading(false);

    if (!result.ok) {
      setError(result.error || t("auth.error.invalidCredentials"));
      return;
    }

    router.push("/dashboard");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("auth.login.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form method="post" onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          <div className="space-y-2">
            <Label htmlFor="email">{t("auth.field.username")}</Label>
            <Input
              id="email"
              name="username"
              type="text"
              autoCapitalize="none"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  document.getElementById("password")?.focus();
                }
              }}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{t("auth.field.password")}</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.target.closest("form")?.requestSubmit();
                }
              }}
              required
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              className="rounded border-gray-300"
            />
            <span className="text-muted-foreground">{t("auth.login.rememberMe")}</span>
          </label>
          <Button className="w-full" type="submit" disabled={loading}>
            {loading ? t("auth.login.submitting") : t("auth.login.submit")}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          {t("auth.login.forgotPassword")}
        </p>
      </CardContent>
    </Card>
  );
}
