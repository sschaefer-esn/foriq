"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { Eye, Pencil, Plus, Trash2 } from "lucide-react";
import api from "@/lib/api";
import { useFleetLive } from "@/components/providers/FleetLiveProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import LayoutGrid from "@/components/layout/LayoutGrid";
import DevicePanel from "@/components/layout/DevicePanel";
import { Skeleton } from "@/components/ui/Skeleton";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/lib/i18n";

// saveStatus holds a dictionary key; keys under floorPlan.error.* render as errors.
const isErrorStatus = (key) => key.startsWith("floorPlan.error.");

function geometry(item) {
  return {
    device_id: item.device_id,
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
  };
}

export default function FloorPlanPage() {
  const fleet = useFleetLive();
  const t = useT();
  const { data: session } = useAuth();
  const canEdit = ["owner", "admin"].includes(session?.user?.role);
  const [layouts, setLayouts] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [layout, setLayout] = useState(null);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState(() => t("floorPlan.defaultName"));
  const [saveStatus, setSaveStatus] = useState("");
  const saveTimer = useRef(null);

  useEffect(() => {
    api.get("/layouts").then(({ data }) => {
      setLayouts(data);
      if (data.length) setActiveId(data[0].id);
    }).catch(() => setSaveStatus("floorPlan.error.loadFailed"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!activeId) return;
    let active = true;
    api.get(`/layouts/${activeId}`).then(({ data }) => { if (active) setLayout(data); })
      .catch(() => { if (active) setSaveStatus("floorPlan.error.layoutLoadFailed"); });
    return () => { active = false; };
  }, [activeId]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const saveItems = useCallback((items) => {
    if (!activeId || !canEdit) return;
    clearTimeout(saveTimer.current);
    const cleanItems = items.map(geometry);
    saveTimer.current = setTimeout(() => {
      setSaveStatus("floorPlan.status.saving");
      api.put(`/layouts/${activeId}/items`, { items: cleanItems })
        .then(() => setSaveStatus("floorPlan.status.saved"))
        .catch(() => setSaveStatus("floorPlan.error.saveFailed"));
    }, 500);
  }, [activeId, canEdit]);

  const handleItemsChange = useCallback((items) => {
    const cleanItems = items.map(geometry);
    setLayout((current) => current ? { ...current, items: cleanItems } : current);
    saveItems(cleanItems);
  }, [saveItems]);

  const handleDropNew = useCallback((item) => {
    setLayout((current) => {
      if (!current || current.items.some((entry) => entry.device_id === item.device_id)) return current;
      const items = [...current.items, geometry(item)];
      saveItems(items);
      return { ...current, items };
    });
  }, [saveItems]);

  const displayItems = useMemo(() => (layout?.items || []).map((item) => {
    const device = fleet.devices.find((entry) => entry.id === item.device_id);
    return { ...device, ...item, device_name: device?.name || t("floorPlan.unknownMachine") };
  }), [layout?.items, fleet.devices, t]);

  async function handleCreate() {
    try {
      const { data } = await api.post("/layouts", { name: newName.trim() || t("floorPlan.defaultName") });
      setLayouts((current) => [...current, data]);
      setActiveId(data.id);
      setShowCreate(false);
      setNewName(t("floorPlan.defaultName"));
      setEditing(true);
      setSaveStatus("");
    } catch {
      setSaveStatus("floorPlan.error.createFailed");
    }
  }

  async function handleDelete() {
    if (!activeId) return;
    try {
      await api.delete(`/layouts/${activeId}`);
      const remaining = layouts.filter((item) => item.id !== activeId);
      setLayouts(remaining);
      setActiveId(remaining[0]?.id || null);
      if (!remaining.length) setLayout(null);
      setEditing(false);
      setSaveStatus("");
    } catch {
      setSaveStatus("floorPlan.error.deleteFailed");
    }
  }

  const placedDeviceIds = (layout?.items || []).map((item) => item.device_id);

  if (loading || fleet.loading) {
    return <div className="space-y-4"><Skeleton className="h-8 w-56" /><Skeleton className="h-[60vh] w-full rounded-xl" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          {layouts.length > 0 && (
            <select value={activeId || ""} onChange={(event) => { setActiveId(event.target.value); setEditing(false); }} className="h-9 rounded-md border bg-transparent px-3 text-sm">
              {layouts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          )}
          {canEdit && <Button size="sm" variant="outline" onClick={() => setShowCreate(true)}><Plus className="size-3" />{t("floorPlan.new")}</Button>}
        </div>
        <div className="flex items-center gap-3">
          {saveStatus && <span className={`text-xs ${isErrorStatus(saveStatus) ? "text-destructive" : "text-muted-foreground"}`}>{t(saveStatus)}</span>}
        {layout && canEdit && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant={editing ? "default" : "outline"} onClick={() => setEditing((value) => !value)}>
              {editing ? <><Eye className="size-3" />{t("floorPlan.done")}</> : <><Pencil className="size-3" />{t("floorPlan.edit")}</>}
            </Button>
            {editing && <Button size="sm" variant="outline" onClick={handleDelete} aria-label={t("floorPlan.deleteLayout")}><Trash2 className="size-3" /></Button>}
          </div>
        )}
        </div>
      </div>

      {layout ? (
        <div className="flex gap-4">
          <div className="min-w-0 flex-1">
            <LayoutGrid items={displayItems} cols={layout.grid_cols} rows={layout.grid_rows} editing={editing && canEdit} onItemsChange={handleItemsChange} onDropNew={handleDropNew} />
          </div>
          {editing && canEdit && <div className="w-48 shrink-0"><DevicePanel devices={fleet.devices} placedDeviceIds={placedDeviceIds} /></div>}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <p className="mb-4 text-muted-foreground">{t("floorPlan.empty")}</p>
          {canEdit && <Button onClick={() => setShowCreate(true)}><Plus className="size-4" />{t("floorPlan.createFirst")}</Button>}
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("floorPlan.newLayout")}</DialogTitle></DialogHeader>
          <Input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder={t("floorPlan.namePlaceholder")} onKeyDown={(event) => event.key === "Enter" && handleCreate()} />
          <DialogFooter><Button variant="outline" onClick={() => setShowCreate(false)}>{t("floorPlan.cancel")}</Button><Button onClick={handleCreate}>{t("floorPlan.create")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
