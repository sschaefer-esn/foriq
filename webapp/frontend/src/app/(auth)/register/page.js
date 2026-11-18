"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { API_BASE, signIn } from "@/lib/auth";
import { useRouter } from "next/navigation";
import axios from "axios";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";

export default function RegisterPage() {
  const t = useT();
  const router = useRouter();
  const [companyName, setCompanyName] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Only reachable on first start; afterwards the admin creates users.
  useEffect(() => {
    fetch(`${API_BASE}/auth/setup-status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && !d.needs_setup && router.replace("/login"))
      .catch(() => {});
  }, [router]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await axios.post(`${API_BASE}/auth/register`, {
        company_name: companyName.trim() || t("auth.register.defaultCompanyName"),
        name,
        email,
        password,
      });

      const result = await signIn({ email, password });

      if (!result.ok) {
        setError(t("auth.register.signInFailed"));
        setLoading(false);
        return;
      }

      router.push("/dashboard");
    } catch (err) {
      const message = apiErrorMessage(err, t("auth.register.failed"));
      setError(message);
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="w-full max-w-md p-8">
        <div className="mb-8 text-center">
          <Image src="/foriq-logo-gear.svg" alt="Foriq" width={48} height={48} className="mx-auto h-12 w-auto" priority />
          <p className="mt-2 text-muted-foreground">
            {t("auth.register.subtitle")}
          </p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{t("auth.register.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}
              <div className="space-y-2">
                <Label htmlFor="company">{t("auth.register.companyName")}</Label>
                <Input
                  id="company"
                  placeholder={t("auth.register.companyPlaceholder")}
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="name">{t("auth.register.yourName")}</Label>
                <Input
                  id="name"
                  placeholder={t("auth.register.namePlaceholder")}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">{t("auth.field.username")}</Label>
                <Input
                  id="email"
                  type="text"
                  placeholder="admin"
                  autoCapitalize="none"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">{t("auth.field.password")}</Label>
                <Input
                  id="password"
                  type="password"
                  minLength={8}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <Button className="w-full" type="submit" disabled={loading}>
                {loading ? t("auth.register.submitting") : t("auth.register.submit")}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
