"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth";
import api, { apiErrorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function AccountPage() {
  const t = useT();
  const { data: session, update } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSuccess(false);
    if (next !== repeat) {
      setError(t("settings.account.mismatch"));
      return;
    }
    setLoading(true);
    try {
      const res = await api.post("/auth/me/change-password", {
        current_password: current,
        new_password: next,
      });
      // The backend ends all other sessions; this one gets a fresh token.
      await update({ accessToken: res.data.token });
      setCurrent("");
      setNext("");
      setRepeat("");
      setSuccess(true);
    } catch (err) {
      setError(apiErrorMessage(err, t("settings.account.changeFailed")));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">{t("settings.account.title")}</h1>
      <p className="mt-2 text-muted-foreground">
        {t("settings.account.signedInAs")} <span className="font-medium text-foreground">{session?.user?.name}</span>
        {session?.user?.email && <> ({session.user.email})</>}.
      </p>

      <div className="mt-6 max-w-lg space-y-6">
        <div className="rounded-xl border border-border/60 bg-card shadow-card p-6">
          <h2 className="text-lg font-semibold mb-1">{t("settings.account.changePassword")}</h2>
          <p className="text-sm text-muted-foreground mb-4">
            {t("settings.account.otherSessionsNote")}
          </p>
          <form onSubmit={handleSubmit} className="space-y-4">
            <input type="text" autoComplete="username" value={session?.user?.email || ""} readOnly hidden />
            <div className="space-y-2">
              <Label htmlFor="current-password">{t("settings.account.currentPassword")}</Label>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">{t("settings.account.newPassword")}</Label>
              <Input
                id="new-password"
                type="password"
                minLength={8}
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="repeat-password">{t("settings.account.repeatPassword")}</Label>
              <Input
                id="repeat-password"
                type="password"
                minLength={8}
                autoComplete="new-password"
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
                required
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {success && <p className="text-sm text-muted-foreground">{t("settings.account.changed")}</p>}
            <Button type="submit" disabled={loading}>
              {loading ? t("settings.account.changing") : t("settings.account.changePassword")}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
