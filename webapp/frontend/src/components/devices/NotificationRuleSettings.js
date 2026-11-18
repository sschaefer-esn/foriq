"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, BellRing } from "lucide-react";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

function assignedDeviceIds(rule) {
  if (rule.device_ids?.length) return rule.device_ids.map(String);
  return (rule.devices || []).map((device) => String(device.id));
}

export default function NotificationRuleSettings({ deviceId }) {
  const t = useT();
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let active = true;
    api.get("/notifications/rule-sets")
      .then(({ data }) => {
        if (!active) return;
        setRules(Array.isArray(data) ? data : data?.items || []);
      })
      .catch(() => {
        if (active) setLoadError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const assignedRules = useMemo(() => rules.filter((rule) =>
    assignedDeviceIds(rule).includes(String(deviceId))), [deviceId, rules]);
  const activeRules = assignedRules.filter((rule) => rule.enabled);
  const centerHref = `/notifications?tab=rules&device=${encodeURIComponent(deviceId)}`;

  return (
    <section className="rounded-xl border border-border/60 bg-card p-4 shadow-card">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <BellRing className="size-[18px]" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{t("devices.rules.title")}</h3>
          {loading ? (
            <div className="mt-2 h-4 w-52 animate-pulse rounded bg-muted/50" />
          ) : loadError ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("devices.rules.loadFailed")}
            </p>
          ) : activeRules.length > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("devices.rules.activeCount", { count: activeRules.length })}
              {activeRules.length === 1
                ? activeRules[0].require_work_phase
                  ? t("devices.rules.workPause", { work: activeRules[0].minimum_work_minutes, pause: activeRules[0].threshold_minutes })
                  : t("devices.rules.noStroke", { minutes: activeRules[0].threshold_minutes })
                : t("devices.rules.forMachine")}
            </p>
          ) : assignedRules.length > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("devices.rules.paused", { count: assignedRules.length })}
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("devices.rules.none")}
            </p>
          )}

          {!loading && assignedRules.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {assignedRules.slice(0, 2).map((rule) => (
                <span key={rule.id} className="max-w-full truncate rounded-md bg-muted/60 px-2 py-1 text-xs font-medium">
                  {rule.name}
                </span>
              ))}
              {assignedRules.length > 2 && (
                <span className="rounded-md bg-muted/60 px-2 py-1 text-xs text-muted-foreground">
                  +{assignedRules.length - 2}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 border-t border-border/60 pt-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href={centerHref}>
            {t("devices.rules.openCenter")}
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </div>
    </section>
  );
}
