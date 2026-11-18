"use client";

import { useRef, useState, useCallback } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import LayoutCard from "./LayoutCard";
import { useT } from "@/lib/i18n";

const CELL_WIDTH = 112;
const CELL_HEIGHT = 78;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 1.5;
const ZOOM_STEP = 0.1;

export default function LayoutGrid({
  items,
  cols,
  rows,
  editing,
  onItemsChange,
  onDropNew,
}) {
  const gridRef = useRef(null);
  const viewportRef = useRef(null);
  const t = useT();
  const [dragState, setDragState] = useState(null);
  const [zoom, setZoom] = useState(1);
  // { index, startX, startY, origItem }

  const canvasWidth = cols * CELL_WIDTH;
  const canvasHeight = rows * CELL_HEIGHT;

  const applyZoom = useCallback((value, centerView = true) => {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(value * 100) / 100));
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (next === zoom) {
      if (!centerView) viewport.scrollTo({ left: 0, top: 0, behavior: "smooth" });
      return;
    }

    const centerX = (viewport.scrollLeft + viewport.clientWidth / 2) / zoom;
    const centerY = (viewport.scrollTop + viewport.clientHeight / 2) / zoom;
    setZoom(next);

    requestAnimationFrame(() => {
      if (!viewportRef.current) return;
      viewportRef.current.scrollLeft = centerView ? centerX * next - viewport.clientWidth / 2 : 0;
      viewportRef.current.scrollTop = centerView ? centerY * next - viewport.clientHeight / 2 : 0;
    });
  }, [zoom]);

  const fitToViewport = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const fitted = Math.min(
      (viewport.clientWidth - 32) / canvasWidth,
      (viewport.clientHeight - 32) / canvasHeight,
      1
    );
    applyZoom(fitted, false);
  }, [applyZoom, canvasHeight, canvasWidth]);

  const cellSize = useCallback(() => {
    if (!gridRef.current) return { w: 40, h: 40 };
    const rect = gridRef.current.getBoundingClientRect();
    return { w: rect.width / cols, h: rect.height / rows };
  }, [cols, rows]);

  const snapToGrid = useCallback(
    (px, py) => {
      const c = cellSize();
      return {
        x: Math.max(0, Math.min(cols - 1, Math.round(px / c.w))),
        y: Math.max(0, Math.min(rows - 1, Math.round(py / c.h))),
      };
    },
    [cellSize, cols, rows]
  );

  const collides = useCallback(
    (item, skipIndex) => {
      for (let i = 0; i < items.length; i++) {
        if (i === skipIndex) continue;
        const other = items[i];
        if (
          item.x < other.x + other.w &&
          item.x + item.w > other.x &&
          item.y < other.y + other.h &&
          item.y + item.h > other.y
        ) {
          return true;
        }
      }
      return false;
    },
    [items]
  );

  const handlePointerDown = useCallback(
    (e, index) => {
      if (!editing) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = gridRef.current.getBoundingClientRect();
      setDragState({
        index,
        startPx: e.clientX - rect.left,
        startPy: e.clientY - rect.top,
        origItem: { ...items[index] },
      });
      e.target.setPointerCapture?.(e.pointerId);
    },
    [editing, items]
  );

  const handlePointerMove = useCallback(
    (e) => {
      if (!dragState || !gridRef.current) return;
      const rect = gridRef.current.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const c = cellSize();

      const { index, origItem, startPx, startPy } = dragState;
      const newItems = [...items];
      const dx = Math.round((px - startPx) / c.w);
      const dy = Math.round((py - startPy) / c.h);
      const newX = Math.max(0, Math.min(cols - origItem.w, origItem.x + dx));
      const newY = Math.max(0, Math.min(rows - origItem.h, origItem.y + dy));
      newItems[index] = { ...newItems[index], x: newX, y: newY };

      if (!collides(newItems[index], index)) {
        onItemsChange(newItems);
      }
    },
    [dragState, items, cellSize, collides, cols, rows, onItemsChange]
  );

  const handlePointerUp = useCallback(() => {
    setDragState(null);
  }, []);

  // Drop from sidebar
  const handleDragOver = useCallback(
    (e) => {
      if (!editing) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    [editing]
  );

  const handleDrop = useCallback(
    (e) => {
      if (!editing) return;
      e.preventDefault();
      const deviceId = e.dataTransfer.getData("device_id");
      const deviceName = e.dataTransfer.getData("device_name");
      if (!deviceId) return;

      const rect = gridRef.current.getBoundingClientRect();
      const snapped = snapToGrid(e.clientX - rect.left, e.clientY - rect.top);

      const newItem = {
        device_id: deviceId,
        device_name: deviceName,
        x: Math.max(0, Math.min(cols - 3, snapped.x)),
        y: Math.max(0, Math.min(rows - 2, snapped.y)),
        w: 3,
        h: 2,
      };

      if (!collides(newItem, -1)) {
        onDropNew(newItem);
      }
    },
    [editing, snapToGrid, collides, cols, rows, onDropNew]
  );

  const handleRemove = useCallback(
    (index) => {
      const newItems = items.filter((_, i) => i !== index);
      onItemsChange(newItems);
    },
    [items, onItemsChange]
  );

  const handleWheel = useCallback((event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    applyZoom(zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
  }, [applyZoom, zoom]);

  return (
    <div className="relative h-[calc(100dvh-13rem)] min-h-[32rem] overflow-hidden rounded-xl border bg-muted/20">
      <div className="absolute top-3 right-3 z-40 flex items-center rounded-lg border bg-card/95 p-1 shadow-card backdrop-blur">
        <button type="button" onClick={() => applyZoom(zoom - ZOOM_STEP)} disabled={zoom <= MIN_ZOOM} className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30" aria-label={t("floorPlan.zoomOut")}><Minus className="size-4" /></button>
        <span className="w-14 text-center text-xs font-medium tabular-nums">{Math.round(zoom * 100)} %</span>
        <button type="button" onClick={() => applyZoom(zoom + ZOOM_STEP)} disabled={zoom >= MAX_ZOOM} className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30" aria-label={t("floorPlan.zoomIn")}><Plus className="size-4" /></button>
        <div className="mx-1 h-5 w-px bg-border" />
        <button type="button" onClick={fitToViewport} className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t("floorPlan.fit")} title={t("floorPlan.fit")}><Maximize2 className="size-4" /></button>
      </div>
      <div ref={viewportRef} className="size-full overflow-auto overscroll-contain" onWheel={handleWheel}>
        <div style={{ width: canvasWidth * zoom, height: canvasHeight * zoom }}>
          <div
            ref={gridRef}
            className="relative origin-top-left select-none bg-card"
            style={{
              width: canvasWidth,
              height: canvasHeight,
              transform: `scale(${zoom})`,
              backgroundImage:
                "linear-gradient(to right, hsl(var(--border)) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--border)) 1px, transparent 1px)",
              backgroundSize: `${CELL_WIDTH}px ${CELL_HEIGHT}px`,
            }}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {items.map((item, i) => (
              <LayoutCard
                key={item.device_id}
                item={item}
                cols={cols}
                rows={rows}
                editing={editing}
                dragging={dragState?.index === i}
                onPointerDownMove={(e) => handlePointerDown(e, i)}
                onRemove={() => handleRemove(i)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
