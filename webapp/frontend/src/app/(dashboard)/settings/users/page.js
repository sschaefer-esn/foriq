"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { UserPlus, Trash2, KeyRound } from "lucide-react";
import api, { apiErrorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import InviteUserDialog from "@/components/users/InviteUserDialog";

const roleBadgeStyles = {
  owner: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  admin: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  viewer:
    "bg-gray-100 text-gray-800 dark:bg-gray-800/50 dark:text-gray-400",
};

const roleLabelKeys = {
  owner: "settings.role.owner",
  admin: "settings.role.admin",
  viewer: "settings.role.viewer",
};

export default function UsersPage() {
  const t = useT();
  const { data: session } = useAuth();
  const [members, setMembers] = useState([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const currentRole = session?.user?.role;
  const currentUserId = session?.user?.id;
  const isOwner = currentRole === "owner";
  const isAdmin = currentRole === "admin";
  const canManage = isOwner || isAdmin;

  const loadUsers = useCallback(async () => {
    try {
      const res = await api.get("/users");
      setMembers(res.data.members);
    } catch {
      // ignore errors
    }
  }, []);

  useEffect(() => {
    if (!canManage) return;
    const timer = setTimeout(loadUsers, 0);
    return () => clearTimeout(timer);
  }, [loadUsers, canManage]);

  function showConfirm({ title, description, confirmLabel, variant, onConfirm }) {
    setConfirmDialog({ title, description, confirmLabel, variant, onConfirm });
  }

  async function handleRoleChange(userId, newRole) {
    try {
      await api.put(`/users/${userId}/role`, { role: newRole });
      loadUsers();
    } catch {
      // ignore errors
    }
  }

  function handleRemoveUser(userId, name) {
    showConfirm({
      title: t("settings.users.deleteTitle"),
      description: t("settings.users.deleteDescription", { name }),
      confirmLabel: t("settings.users.delete"),
      variant: "destructive",
      onConfirm: async () => {
        await api.delete(`/users/${userId}`);
        loadUsers();
      },
    });
  }

  if (!canManage) {
    return (
      <div>
        <h1 className="text-2xl font-bold">{t("settings.users.title")}</h1>
        <p className="mt-2 text-muted-foreground">
          {t("settings.users.noPermission")}
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("settings.users.title")}</h1>
          <p className="mt-2 text-muted-foreground">
            {t("settings.users.description")}
          </p>
        </div>
        <Button onClick={() => setInviteOpen(true)}>
          <UserPlus className="mr-2 h-4 w-4" />
          {t("settings.users.create")}
        </Button>
      </div>

      {/* Member list */}
      <div className="mt-6 rounded-xl border border-border/60 bg-card shadow-card">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-semibold">{t("settings.users.members")}</h2>
        </div>
        <div className="divide-y">
          {members.map((member) => (
            <div
              key={member.id}
              className="flex items-center justify-between px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <div>
                  <div className="text-sm font-medium">
                    {member.name}
                    {member.id === currentUserId && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {t("settings.users.you")}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {member.email}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${roleBadgeStyles[member.role]}`}
                >
                  {roleLabelKeys[member.role] ? t(roleLabelKeys[member.role]) : member.role}
                </span>
                {isOwner && member.role !== "owner" && (
                  <>
                    <select
                      value={member.role}
                      onChange={(e) =>
                        handleRoleChange(member.id, e.target.value)
                      }
                      className="h-7 rounded border border-input bg-transparent px-2 text-xs outline-none"
                    >
                      <option value="admin">{t("settings.role.admin")}</option>
                      <option value="viewer">{t("settings.role.viewer")}</option>
                    </select>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title={t("settings.users.resetPassword")}
                      onClick={() => setResetTarget(member)}
                    >
                      <KeyRound className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() =>
                        handleRemoveUser(member.id, member.name)
                      }
                    >
                      <Trash2 className="h-3 w-3 text-destructive" />
                    </Button>
                  </>
                )}
                {isAdmin &&
                  member.role === "viewer" &&
                  member.id !== currentUserId && (
                    <>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title={t("settings.users.resetPassword")}
                      onClick={() => setResetTarget(member)}
                    >
                      <KeyRound className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() =>
                        handleRemoveUser(member.id, member.name)
                      }
                    >
                      <Trash2 className="h-3 w-3 text-destructive" />
                    </Button>
                    </>
                  )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <InviteUserDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvited={loadUsers}
      />
      <ResetPasswordDialog
        member={resetTarget}
        onClose={() => setResetTarget(null)}
      />
      <ConfirmDialog
        dialog={confirmDialog}
        onClose={() => setConfirmDialog(null)}
      />
    </div>
  );
}

function ConfirmDialog({ dialog, onClose }) {
  const t = useT();
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    setLoading(true);
    try {
      await dialog.onConfirm();
      onClose();
    } catch {
      // ignore errors
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={!!dialog} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{dialog?.title}</DialogTitle>
          <DialogDescription>{dialog?.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            {t("settings.cancel")}
          </Button>
          <Button
            variant={dialog?.variant || "default"}
            onClick={handleConfirm}
            disabled={loading}
          >
            {loading ? t("settings.pleaseWait") : dialog?.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ member, onClose }) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function close() {
    setPassword("");
    setError("");
    onClose();
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await api.put(`/users/${member.id}/password`, { password });
      close();
    } catch (err) {
      setError(apiErrorMessage(err, t("settings.users.resetFailed")));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={!!member} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.users.resetPassword")}</DialogTitle>
          <DialogDescription>
            {t("settings.users.resetDescription", { name: member?.name })}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reset-password">{t("settings.users.newPassword")}</Label>
            <Input
              id="reset-password"
              type="password"
              minLength={8}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={loading}>
              {t("settings.cancel")}
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? t("settings.users.setting") : t("settings.users.set")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
