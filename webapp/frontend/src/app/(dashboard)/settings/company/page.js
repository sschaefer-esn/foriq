"use client";

import { useState, useEffect } from "react";
import { useAuth, signOut } from "@/lib/auth";
import api, { apiErrorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export default function CompanyPage() {
  const t = useT();
  const { data: session, update } = useAuth();
  const isOwner = session?.user?.role === "owner";

  const [name, setName] = useState(session?.user?.companyName || "");
  const [timezone, setTimezone] = useState("Europe/Berlin");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [deleteAction, setDeleteAction] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    api.get("/auth/company/settings").then((res) => {
      setTimezone(res.data.timezone || "Europe/Berlin");
    }).catch(() => {});
  }, []);

  async function handleRename(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setSaved(false);
    try {
      await api.put("/auth/company", { name: name.trim(), timezone });
      await update({
        companyName: name.trim(),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // ignore errors
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteCompany() {
    setDeleting(true);
    setDeleteError("");
    try {
      await api.delete("/auth/company");
      // There is only one company – without it a session makes no sense.
      await signOut({ callbackUrl: "/login" });
    } catch (err) {
      setDeleteError(
        apiErrorMessage(err, t("settings.company.deleteCompanyFailed"))
      );
      setDeleting(false);
    }
  }

  async function handleDeleteAccount() {
    setDeleting(true);
    setDeleteError("");
    try {
      await api.delete("/auth/account");
      await signOut({ callbackUrl: "/login" });
    } catch (err) {
      setDeleteError(
        apiErrorMessage(err, t("settings.company.deleteAccountFailed"))
      );
      setDeleting(false);
    }
  }

  async function handleDeleteCompanyAndAccount() {
    setDeleting(true);
    setDeleteError("");
    try {
      await api.delete("/auth/company-and-account");
      await signOut({ callbackUrl: "/login" });
    } catch (err) {
      setDeleteError(
        apiErrorMessage(err, t("settings.company.deleteBothFailed"))
      );
      setDeleting(false);
    }
  }

  const deleteDialog = {
    company: {
      title: t("settings.company.deleteCompany.title"),
      description: t("settings.company.deleteCompany.description", { name: session?.user?.companyName || "" }),
      confirm: t("settings.company.deleteCompany.confirm"),
      onConfirm: handleDeleteCompany,
    },
    account: {
      title: t("settings.company.deleteAccount.title"),
      description: t("settings.company.deleteAccount.description"),
      confirm: t("settings.company.deleteAccount.confirm"),
      onConfirm: handleDeleteAccount,
    },
    both: {
      title: t("settings.company.deleteBoth.title"),
      description: t("settings.company.deleteBoth.description", { name: session?.user?.companyName || "" }),
      confirm: t("settings.company.deleteBoth.confirm"),
      onConfirm: handleDeleteCompanyAndAccount,
    },
  }[deleteAction];

  return (
    <div>
      <h1 className="text-2xl font-bold">{t("settings.company.title")}</h1>
      <p className="mt-2 text-muted-foreground">
        {t("settings.company.description")}
      </p>

      <div className="mt-6 max-w-lg space-y-6">
        {/* Rename company */}
        <div className="rounded-xl border border-border/60 bg-card shadow-card p-6">
          <h2 className="text-lg font-semibold mb-4">{t("settings.company.nameHeading")}</h2>
          {isOwner ? (
            <form onSubmit={handleRename} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="company-name">{t("settings.company.name")}</Label>
                <Input
                  id="company-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="company-tz">{t("settings.company.timezone")}</Label>
                <select
                  id="company-tz"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="Europe/Berlin">Europe/Berlin ({t("settings.company.tzCentralEurope")})</option>
                  <option value="Europe/Vienna">Europe/Vienna ({t("settings.company.tzCentralEurope")})</option>
                  <option value="Europe/Zurich">Europe/Zurich ({t("settings.company.tzCentralEurope")})</option>
                  <option value="Europe/London">Europe/London (GMT/BST)</option>
                  <option value="Europe/Paris">Europe/Paris ({t("settings.company.tzCentralEurope")})</option>
                  <option value="Europe/Rome">Europe/Rome ({t("settings.company.tzCentralEurope")})</option>
                  <option value="Europe/Madrid">Europe/Madrid ({t("settings.company.tzCentralEurope")})</option>
                  <option value="Europe/Amsterdam">Europe/Amsterdam ({t("settings.company.tzCentralEurope")})</option>
                  <option value="Europe/Warsaw">Europe/Warsaw ({t("settings.company.tzCentralEurope")})</option>
                  <option value="Europe/Prague">Europe/Prague ({t("settings.company.tzCentralEurope")})</option>
                  <option value="Europe/Istanbul">Europe/Istanbul (TRT)</option>
                  <option value="US/Eastern">US/Eastern (EST/EDT)</option>
                  <option value="US/Central">US/Central (CST/CDT)</option>
                  <option value="US/Pacific">US/Pacific (PST/PDT)</option>
                  <option value="UTC">UTC</option>
                </select>
              </div>
              <div className="flex items-center gap-3">
                <Button type="submit" disabled={saving}>
                  {saving ? t("settings.company.saving") : t("settings.company.save")}
                </Button>
                {saved && (
                  <span className="text-sm text-muted-foreground">
                    {t("settings.company.saved")}
                  </span>
                )}
              </div>
            </form>
          ) : (
            <div className="space-y-2">
              <p className="text-sm">
                {session?.user?.companyName}
                <span className="ml-2 text-muted-foreground">
                  {t("settings.company.ownerOnly")}
                </span>
              </p>
              <p className="text-sm text-muted-foreground">
                {t("settings.company.timezoneValue", { timezone })}
              </p>
            </div>
          )}
        </div>

        <div className="rounded-lg border border-destructive/50 bg-card p-6">
          <h2 className="mb-4 text-lg font-semibold text-destructive">
            {t("settings.company.dangerZone")}
          </h2>
          <div className="space-y-5">
            {isOwner && (
              <div>
                <p className="text-sm font-medium">{t("settings.company.deleteCompanyOnly")}</p>
                <p className="mb-3 mt-1 text-sm text-muted-foreground">
                  {t("settings.company.deleteCompanyOnlyText")}
                </p>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setDeleteError("");
                    setDeleteAction("company");
                  }}
                >
                  {t("settings.company.deleteCompanyButton")}
                </Button>
              </div>
            )}

            <div className={isOwner ? "border-t pt-5" : ""}>
              <p className="text-sm font-medium">{t("settings.company.deleteAccountOnly")}</p>
              <p className="mb-3 mt-1 text-sm text-muted-foreground">
                {t("settings.company.deleteAccountOnlyText")}
                {isOwner && ` ${t("settings.company.deleteAccountOwnerNote")}`}
              </p>
              <Button
                variant="destructive"
                onClick={() => {
                  setDeleteError("");
                  setDeleteAction("account");
                }}
              >
                {t("settings.company.deleteAccountButton")}
              </Button>
            </div>

            {isOwner && (
              <div className="border-t pt-5">
                <p className="text-sm font-medium">{t("settings.company.deleteBothHeading")}</p>
                <p className="mb-3 mt-1 text-sm text-muted-foreground">
                  {t("settings.company.deleteBothText")}
                </p>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setDeleteError("");
                    setDeleteAction("both");
                  }}
                >
                  {t("settings.company.deleteBothHeading")}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      <Dialog
        open={Boolean(deleteAction)}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            setDeleteAction(null);
            setDeleteError("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{deleteDialog?.title}</DialogTitle>
            <DialogDescription>
              {deleteDialog?.description}
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="text-sm text-destructive">{deleteError}</p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteAction(null)}
              disabled={deleting}
            >
              {t("settings.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={deleteDialog?.onConfirm}
              disabled={deleting}
            >
              {deleting ? t("settings.company.deleting") : deleteDialog?.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
