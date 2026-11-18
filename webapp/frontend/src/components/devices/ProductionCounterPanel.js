"use client";

import { useState } from "react";
import { Boxes, ChevronRight, Expand, Pencil, Square } from "lucide-react";
import api, { apiErrorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { formatCount, formatEta, productionMetrics } from "@/lib/productionCounter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function projectionCopy(metrics, now, t) {
  if (!metrics) return { value: "–", note: t("deviceDetail.production.note.noTarget") };
  if (metrics.projectionStatus === "complete") return { value: t("deviceDetail.projection.complete"), note: t("deviceDetail.production.note.complete") };
  if (metrics.projectionStatus === "available") return { value: formatEta(metrics.etaAt, now), note: t("deviceDetail.production.note.available") };
  if (metrics.projectionStatus === "too_long") return { value: t("deviceDetail.projection.tooLong"), note: t("deviceDetail.production.note.tooLong") };
  if (metrics.projectionStatus === "stale") return { value: t("deviceDetail.projection.stale"), note: t("deviceDetail.production.note.stale") };
  return { value: t("deviceDetail.projection.pending"), note: t("deviceDetail.production.note.pending") };
}

export default function ProductionCounterPanel({
  device,
  now,
  canEdit,
  onProductionChanged,
  onOpenMachineDisplay,
}) {
  const t = useT();
  const production = device?.production;
  const metrics = productionMetrics(device, now);
  const projection = projectionCopy(metrics, now, t);
  const [setupOpen, setSetupOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [material, setMaterial] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function openSetup() {
    setTarget(production?.target_count != null ? String(production.target_count) : "");
    setMaterial(production?.material_remaining != null ? String(production.material_remaining) : "");
    setError("");
    setSetupOpen(true);
  }

  async function saveProduction(event) {
    event.preventDefault();
    const targetCount = Number(target);
    const materialCount = material === "" ? null : Number(material);
    if (!Number.isInteger(targetCount) || targetCount < 1) {
      setError(t("deviceDetail.production.error.target"));
      return;
    }
    if (materialCount != null && (!Number.isInteger(materialCount) || materialCount < 0)) {
      setError(t("deviceDetail.production.error.material"));
      return;
    }

    setSaving(true);
    setError("");
    try {
      const payload = {
        target_count: targetCount,
        material_count: materialCount,
      };
      const { data } = production
        ? await api.put(`/devices/${device.id}/production`, payload)
        : await api.post(`/devices/${device.id}/production`, payload);
      onProductionChanged?.(data);
      setSetupOpen(false);
    } catch (requestError) {
      setError(apiErrorMessage(requestError, t("deviceDetail.production.error.save")));
    } finally {
      setSaving(false);
    }
  }

  async function stopProduction() {
    setSaving(true);
    setError("");
    try {
      await api.delete(`/devices/${device.id}/production`);
      onProductionChanged?.(null);
      setStopOpen(false);
    } catch (requestError) {
      setError(apiErrorMessage(requestError, t("deviceDetail.production.error.stop")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {!production ? (
        <section className="flex min-h-14 items-stretch overflow-hidden rounded-xl border border-border/60 bg-card/35 transition-colors hover:border-border hover:bg-card/70">
          {canEdit ? (
            <button type="button" onClick={openSetup} className="group flex min-w-0 flex-1 items-center gap-3 px-3.5 py-2.5 text-left outline-none transition-colors focus-visible:bg-muted/60 sm:px-4">
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted/70 text-muted-foreground transition-colors group-hover:text-foreground">
                <Boxes className="size-4" strokeWidth={1.75} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{t("deviceDetail.production.setTarget")}</span>
                <span className="hidden text-xs text-muted-foreground sm:block">{t("deviceDetail.production.setTargetHint")}</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
            </button>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-3 px-3.5 py-2.5 sm:px-4">
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted/70 text-muted-foreground">
                <Boxes className="size-4" strokeWidth={1.75} />
              </span>
              <span className="text-sm text-muted-foreground">{t("deviceDetail.production.noTargetSet")}</span>
            </div>
          )}
          <div className="flex items-center border-l border-border/60 px-2">
            <button type="button" onClick={onOpenMachineDisplay} aria-label={t("deviceDetail.production.openDisplay")} title={t("deviceDetail.production.openDisplay")} className="grid size-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
              <Expand className="size-4" />
            </button>
          </div>
        </section>
      ) : (
        <section className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-4">
            <div className="flex items-center gap-3">
              <span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
                <Boxes className="size-[18px]" strokeWidth={1.8} />
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold">{t("deviceDetail.production.title")}</h2>
                  <span className="size-1.5 animate-[pulse-online_2s_ease-in-out_infinite] rounded-full bg-emerald-500" />
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{t("deviceDetail.production.subtitle")}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onOpenMachineDisplay} aria-label={t("deviceDetail.production.openDisplay")} title={t("deviceDetail.production.openDisplay")}>
                <Expand className="size-4" />
                <span className="hidden sm:inline">{t("deviceDetail.production.machineView")}</span>
              </Button>
              {canEdit && (
                <Button type="button" size="sm" onClick={openSetup}>
                  <Pencil className="size-4" /> {t("deviceDetail.production.edit")}
                </Button>
              )}
            </div>
          </div>
          <div className="grid lg:grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)]">
            <div className="border-b border-border/60 px-5 py-6 sm:px-7 lg:border-b-0 lg:border-r">
              <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
                <div>
                  <div className="text-label">{t("deviceDetail.display.producedSinceStart")}</div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-[clamp(3.5rem,10vw,5.5rem)] font-medium leading-[0.9] tracking-[-0.03em] in-data-[font=clash]:tracking-[-0.055em] tabular-nums">
                      {formatCount(metrics.current)}
                    </span>
                    <span className="text-sm text-muted-foreground">{t("deviceDetail.display.pieces")}</span>
                  </div>
                </div>
                <div className="pb-1 text-right">
                  <div className="text-label">{t("deviceDetail.production.targetQuantity")}</div>
                  <div className="mt-1 text-xl font-medium tabular-nums">{formatCount(metrics.target)}</div>
                </div>
              </div>
              <div className="mt-7">
                <div className="machine-progress-track h-3 overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full transition-[width] duration-500 ${metrics.remaining === 0 ? "bg-emerald-500" : "bg-primary"}`}
                    style={{ width: `${metrics.progress}%` }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{t("deviceDetail.production.progress", { percent: Math.round(metrics.progress) })}</span>
                  {metrics.overTarget > 0 && <span className="font-medium text-emerald-600 dark:text-emerald-400">{t("deviceDetail.display.overTarget", { count: formatCount(metrics.overTarget) })}</span>}
                </div>
              </div>
            </div>

            <dl className="grid grid-cols-2">
              <div className="border-b border-r border-border/60 px-4 py-5 sm:px-5">
                <dt className="text-label">{t("deviceDetail.display.remaining")}</dt>
                <dd className="mt-2 text-2xl font-medium tabular-nums">{formatCount(metrics.remaining)}</dd>
                <p className="mt-1 text-xs text-muted-foreground">{t("deviceDetail.production.piecesToTarget")}</p>
              </div>
              <div className="border-b border-border/60 px-4 py-5 sm:px-5">
                <dt className="text-label">{t("deviceDetail.display.material")}</dt>
                <dd className="mt-2 text-2xl font-medium tabular-nums">
                  {metrics.materialRemaining == null ? "–" : formatCount(metrics.materialRemaining)}
                </dd>
                <p className={`mt-1 text-xs ${metrics.materialShortfall > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
                  {metrics.materialRemaining == null
                    ? t("deviceDetail.production.materialNotSet")
                    : metrics.materialShortfall > 0
                      ? t("deviceDetail.production.materialShortfall", { count: formatCount(metrics.materialShortfall) })
                      : t("deviceDetail.production.materialSufficient")}
                </p>
              </div>
              <div className="border-r border-border/60 px-4 py-5 sm:px-5">
                <dt className="text-label">{t("deviceDetail.display.currentRate")}</dt>
                <dd className="mt-2 text-2xl font-medium tabular-nums">{metrics.rate != null ? formatCount(metrics.rate) : "–"}</dd>
                <p className="mt-1 text-xs text-muted-foreground">{t("deviceDetail.display.piecesPerHour")}</p>
              </div>
              <div className="px-4 py-5 sm:px-5">
                <dt className="text-label">{t("deviceDetail.display.projection")}</dt>
                <dd className="mt-2 truncate text-lg font-medium tabular-nums" title={projection.value}>{projection.value}</dd>
                <p className="mt-1 text-xs text-muted-foreground">{projection.note}</p>
              </div>
            </dl>
          </div>

          {canEdit && (
            <div className="flex justify-end border-t border-border/60 px-5 py-3">
              <button type="button" onClick={() => { setError(""); setStopOpen(true); }} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground">
                <Square className="size-3" fill="currentColor" /> {t("deviceDetail.production.stop")}
              </button>
            </div>
          )}
        </section>
      )}

      <Dialog open={setupOpen} onOpenChange={(open) => !saving && setSetupOpen(open)}>
        <DialogContent>
          <form onSubmit={saveProduction}>
            <DialogHeader>
              <DialogTitle>{production ? t("deviceDetail.production.dialog.editTitle") : t("deviceDetail.production.dialog.startTitle")}</DialogTitle>
              <DialogDescription>
                {production
                  ? t("deviceDetail.production.dialog.editDescription")
                  : t("deviceDetail.production.dialog.startDescription")}
              </DialogDescription>
            </DialogHeader>
            <div className="mt-6 space-y-5">
              <div className="space-y-2">
                <Label htmlFor="production-target">{t("deviceDetail.production.dialog.targetLabel")}</Label>
                <Input id="production-target" type="number" min="1" max="1000000000" step="1" inputMode="numeric" value={target} onChange={(event) => setTarget(event.target.value)} placeholder={t("deviceDetail.production.dialog.targetPlaceholder")} autoFocus />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="production-material">{t("deviceDetail.production.dialog.materialLabel")}</Label>
                  {target && <button type="button" onClick={() => setMaterial(target)} className="text-xs font-medium text-primary hover:underline">{t("deviceDetail.production.dialog.useTarget")}</button>}
                </div>
                <Input id="production-material" type="number" min="0" max="1000000000" step="1" inputMode="numeric" value={material} onChange={(event) => setMaterial(event.target.value)} placeholder={t("deviceDetail.production.dialog.optional")} />
                <p className="text-xs text-muted-foreground">{t("deviceDetail.production.dialog.materialHint")}</p>
              </div>
              {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter className="mt-6">
              <Button type="button" variant="outline" onClick={() => setSetupOpen(false)} disabled={saving}>{t("deviceDetail.cancel")}</Button>
              <Button type="submit" disabled={saving}>{saving ? t("deviceDetail.saving") : production ? t("deviceDetail.production.dialog.saveChanges") : t("deviceDetail.production.dialog.start")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={stopOpen} onOpenChange={(open) => !saving && setStopOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deviceDetail.production.stopDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("deviceDetail.production.stopDialog.description")}
            </DialogDescription>
          </DialogHeader>
          {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setStopOpen(false)} disabled={saving}>{t("deviceDetail.cancel")}</Button>
            <Button type="button" variant="destructive" onClick={stopProduction} disabled={saving}>{saving ? t("deviceDetail.production.stopping") : t("deviceDetail.production.stop")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
