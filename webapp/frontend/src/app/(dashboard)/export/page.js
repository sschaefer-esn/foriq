"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  Download,
  FileSpreadsheet,
  FileText,
  FileCode,
  FileJson,
  Hash,
  Plus,
  Trash2,
} from "lucide-react";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { apiDetailMessage, useLocale, useT } from "@/lib/i18n";

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function todayStr() {
  return isoDate(new Date());
}

function startOfWeek() {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return isoDate(d);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
}

const RANGE_OPTIONS = [
  { id: "week", labelKey: "export.range.week", get: () => ({ start: startOfWeek(), end: todayStr() }) },
  { id: "month", labelKey: "export.range.month", get: () => ({ start: daysAgo(30), end: todayStr() }) },
  { id: "year", labelKey: "export.range.year", get: () => ({ start: daysAgo(365), end: todayStr() }) },
  { id: "custom", labelKey: "export.range.custom" },
];

const FORMATS = [
  {
    id: "xlsx",
    label: "Excel",
    ext: "xlsx",
    descKey: "export.format.xlsx.desc",
    icon: FileSpreadsheet,
    splitLabelKey: "export.split.sheets",
  },
  {
    id: "csv",
    label: "CSV",
    ext: "csv",
    descKey: "export.format.csv.desc",
    icon: FileText,
    splitLabelKey: "export.split.files",
  },
  {
    id: "html",
    label: "HTML",
    ext: "html",
    descKey: "export.format.html.desc",
    icon: FileCode,
    splitLabelKey: "export.split.files",
  },
  {
    id: "txt",
    labelKey: "export.format.text",
    ext: "txt",
    descKey: "export.format.txt.desc",
    icon: FileText,
    splitLabelKey: "export.split.files",
  },
  {
    id: "json",
    label: "JSON",
    ext: "json",
    descKey: "export.format.json.desc",
    icon: FileJson,
    splitLabelKey: "export.split.files",
  },
  {
    id: "md",
    label: "Markdown",
    ext: "md",
    descKey: "export.format.md.desc",
    icon: Hash,
    splitLabelKey: "export.split.files",
  },
];

export default function ExportPage() {
  const t = useT();
  const { locale, intlLocale } = useLocale();
  const [devices, setDevices] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [rangeId, setRangeId] = useState("month");
  const [start, setStart] = useState(daysAgo(30));
  const [end, setEnd] = useState(todayStr());
  const [formatId, setFormatId] = useState("xlsx");
  const [splitSheets, setSplitSheets] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadDevices = useCallback(async () => {
    try {
      const res = await api.get("/devices");
      setDevices(res.data);
      setSelectedIds(res.data.map((d) => d.id));
    } catch {
      // ignore errors
    }
  }, []);

  useEffect(() => {
    loadDevices();
  }, [loadDevices]);

  function selectRange(id) {
    setRangeId(id);
    const opt = RANGE_OPTIONS.find((r) => r.id === id);
    if (opt?.get) {
      const r = opt.get();
      setStart(r.start);
      setEnd(r.end);
    }
  }

  const byId = useMemo(
    () => Object.fromEntries(devices.map((d) => [d.id, d])),
    [devices]
  );

  const sortedDevices = useMemo(
    () =>
      [...devices].sort((a, b) =>
        a.name.localeCompare(b.name, intlLocale, { numeric: true, sensitivity: "base" })
      ),
    [devices, intlLocale]
  );

  // Available for a slot: all machines not yet chosen (alphabetical), plus the
  // one currently in this slot (so it stays visible).
  function availableFor(currentId) {
    return sortedDevices.filter(
      (d) => d.id === currentId || !selectedIds.includes(d.id)
    );
  }

  // Let the dropdown close first, then apply the selection — otherwise the
  // slot "jumps" while the menu is still closing.
  function deferAfterClose(fn) {
    setTimeout(fn, 90);
  }

  function setSlot(index, id) {
    deferAfterClose(() =>
      setSelectedIds((prev) => {
        const next = [...prev];
        next[index] = id;
        return next;
      })
    );
  }

  function addSlot(id) {
    deferAfterClose(() => setSelectedIds((prev) => [...prev, id]));
  }

  function removeSlot(index) {
    deferAfterClose(() =>
      setSelectedIds((prev) => prev.filter((_, i) => i !== index))
    );
  }

  function selectAll() {
    setSelectedIds(sortedDevices.map((d) => d.id));
  }

  function selectNone() {
    setSelectedIds([]);
  }

  const activeFormat = FORMATS.find((f) => f.id === formatId) || FORMATS[0];
  const formatLabel = (fmt) => (fmt.labelKey ? t(fmt.labelKey) : fmt.label);

  async function handleExport() {
    if (selectedIds.length === 0) {
      setError(t("export.error.noDevice"));
      return;
    }
    setError("");
    setLoading(true);
    try {
      const params = new URLSearchParams({
        start,
        end,
        device_ids: selectedIds.join(","),
        mode: splitSheets ? "multi" : "single",
        format: formatId,
        lang: locale,
      });
      const res = await api.get(`/export?${params.toString()}`, {
        responseType: "blob",
      });
      // For "per machine" the backend returns a ZIP for non-Excel formats
      const ext =
        splitSheets && formatId !== "xlsx" ? "zip" : activeFormat.ext;
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `Foriq_${start}_${end}.${ext}`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      // Blob responses carry the JSON error body as a Blob.
      let detail = null;
      try {
        detail = JSON.parse(await err?.response?.data?.text?.())?.detail;
      } catch {
        // not JSON
      }
      setError(apiDetailMessage(detail) || t("export.error.failed"));
    } finally {
      setLoading(false);
    }
  }

  const remaining = devices.length - selectedIds.length;

  return (
    <div className="mx-auto w-full max-w-2xl">
      <header className="mb-8">
        <h1 className="text-[22px] font-semibold tracking-tight">{t("export.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("export.subtitle")}
        </p>
      </header>

      <ol className="space-y-8">
        <li>
          <div className="mb-3 flex items-baseline justify-between">
            <div className="text-label">{t("export.step.machines")}</div>
            <span className="text-xs tabular-nums text-muted-foreground">
              {t("export.selectedCount", { selected: selectedIds.length, total: devices.length })}
            </span>
          </div>
          {devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("export.noDevices")}</p>
          ) : (
            <>
              <div className="mb-3 flex gap-2">
                <button
                  type="button"
                  onClick={selectAll}
                  disabled={remaining === 0}
                  className="rounded-lg border border-border/70 bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                >
                  {t("export.selectAll")}
                </button>
                <button
                  type="button"
                  onClick={selectNone}
                  disabled={selectedIds.length === 0}
                  className="rounded-lg border border-border/70 bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                >
                  {t("export.selectNone")}
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {selectedIds.map((id, index) => (
                  <DropdownMenu key={`${id}-${index}`}>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="flex h-11 w-full items-center gap-2 rounded-xl border border-primary/40 bg-primary/10 px-2.5 text-left text-sm outline-none transition-colors hover:bg-primary/15"
                      >
                        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold tabular-nums text-primary">
                          {index + 1}
                        </span>
                        <span className="flex-1 truncate font-medium text-foreground">
                          {byId[id]?.name ?? "—"}
                        </span>
                        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="max-h-64 w-56">
                      {availableFor(id).map((d) => (
                        <DropdownMenuItem
                          key={d.id}
                          onSelect={() => setSlot(index, d.id)}
                          className="gap-2"
                        >
                          <Check
                            className={cn(
                              "size-3.5 text-primary",
                              d.id === id ? "opacity-100" : "opacity-0"
                            )}
                            strokeWidth={2.25}
                          />
                          <span className="truncate">{d.name}</span>
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => removeSlot(index)}
                        className="gap-2 text-destructive focus:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                        {t("export.remove")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ))}

                {remaining > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="flex h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border bg-card px-2.5 text-sm text-muted-foreground outline-none transition-colors hover:border-primary/40 hover:text-foreground"
                      >
                        <Plus className="size-4" />
                        {t("export.add")}
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="max-h-64 w-56">
                      {availableFor(null).map((d) => (
                        <DropdownMenuItem
                          key={d.id}
                          onSelect={() => addSlot(d.id)}
                          className="truncate"
                        >
                          {d.name}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </>
          )}
        </li>

        <li>
          <div className="mb-3 text-label">{t("export.step.range")}</div>
          <div className="flex flex-wrap gap-2">
            {RANGE_OPTIONS.map((opt) => {
              const active = rangeId === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => selectRange(opt.id)}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-sm transition-colors",
                    active
                      ? "border-primary/30 bg-primary/10 text-foreground"
                      : "border-border/70 bg-card text-muted-foreground hover:text-foreground"
                  )}
                >
                  {t(opt.labelKey)}
                </button>
              );
            })}
          </div>
          {rangeId === "custom" && (
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="export-start" className="text-xs text-muted-foreground">
                  {t("export.from")}
                </Label>
                <Input
                  id="export-start"
                  type="date"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="export-end" className="text-xs text-muted-foreground">
                  {t("export.to")}
                </Label>
                <Input
                  id="export-end"
                  type="date"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </div>
            </div>
          )}
          {rangeId !== "custom" && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t("export.rangeSummary", { start, end })}
            </p>
          )}
        </li>

        <li>
          <div className="mb-3 text-label">{t("export.step.format")}</div>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {FORMATS.map((fmt) => {
              const active = formatId === fmt.id;
              const Icon = fmt.icon;
              return (
                <button
                  key={fmt.id}
                  type="button"
                  onClick={() => setFormatId(fmt.id)}
                  className={cn(
                    "group relative flex flex-col items-start gap-1.5 rounded-xl border p-3 text-left transition-colors",
                    active
                      ? "border-primary/40 bg-primary/10"
                      : "border-border/70 bg-card hover:border-border"
                  )}
                >
                  {active && (
                    <span className="absolute right-2.5 top-2.5 text-primary">
                      <Check className="size-3.5" strokeWidth={2.5} />
                    </span>
                  )}
                  <Icon
                    className={cn(
                      "size-5",
                      active ? "text-primary" : "text-muted-foreground"
                    )}
                    strokeWidth={1.75}
                  />
                  <span
                    className={cn(
                      "text-sm font-medium",
                      active ? "text-foreground" : "text-foreground/90"
                    )}
                  >
                    {formatLabel(fmt)}
                  </span>
                  <span className="text-[11px] leading-tight text-muted-foreground">
                    {t(fmt.descKey)}
                  </span>
                </button>
              );
            })}
          </div>
        </li>

        <li>
          <div className="mb-3 text-label">{t("export.step.save")}</div>
          {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
          <Button
            className="h-12 w-full rounded-xl text-base"
            onClick={handleExport}
            disabled={loading || selectedIds.length === 0}
          >
            <Download className="mr-2 size-4" strokeWidth={1.75} />
            {loading
              ? t("export.preparing")
              : t("export.download", { format: formatLabel(activeFormat), count: selectedIds.length })}
          </Button>
          <button
            type="button"
            onClick={() => setSplitSheets((v) => !v)}
            className="mt-3 flex w-full items-center justify-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <span
              className={cn(
                "inline-block size-3 rounded-sm border transition-colors",
                splitSheets ? "border-primary bg-primary" : "border-border"
              )}
            />
            {t(activeFormat.splitLabelKey)}
          </button>
        </li>
      </ol>
    </div>
  );
}
