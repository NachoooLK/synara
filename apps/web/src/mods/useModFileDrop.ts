// FILE: useModFileDrop.ts
// Purpose: Takes files dropped anywhere in the window while Settings → Mods is open,
//          so an exported mod can be imported by dragging it in. Listeners bind on
//          `window` in the capture phase, as in useWindowFolderDrop, so a drop beside
//          the list is not lost.
// Layer: Web hook (mods)
// Exports: useModFileDrop, DroppedModFiles

import { useEffect, useRef, useState } from "react";

import { isDroppedComposerDirectory } from "~/lib/composerDropPaths";
import { isFileDrag } from "~/lib/folderDrop";

export type DroppedModFiles =
  | { readonly kind: "files"; readonly files: ReadonlyArray<File> }
  /** A folder was dropped; only exported files can be imported this way. */
  | { readonly kind: "folder" };

/** Returns whether files are being dragged over the window. */
export function useModFileDrop(options: {
  readonly enabled: boolean;
  readonly onDrop: (dropped: DroppedModFiles) => void;
}): boolean {
  const [isDropTarget, setIsDropTarget] = useState(false);
  // The latest callback through a ref so the listeners bind once per `enabled` flip.
  const onDropRef = useRef(options.onDrop);
  onDropRef.current = options.onDrop;

  useEffect(() => {
    if (!options.enabled) return;
    let dragDepth = 0;
    const handleDragEnter = (event: globalThis.DragEvent) => {
      if (!isFileDrag(event)) return;
      dragDepth += 1;
      setIsDropTarget(true);
    };
    const handleDragOver = (event: globalThis.DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const handleDragLeave = (event: globalThis.DragEvent) => {
      if (!isFileDrag(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setIsDropTarget(false);
    };
    const handleDrop = (event: globalThis.DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepth = 0;
      setIsDropTarget(false);
      const dataTransfer = event.dataTransfer;
      if (!dataTransfer) return;
      const items = Array.from(dataTransfer.items).filter((item) => item.kind === "file");
      if (items.some((item) => isDroppedComposerDirectory(item))) {
        onDropRef.current({ kind: "folder" });
        return;
      }
      const files = Array.from(dataTransfer.files);
      if (files.length > 0) onDropRef.current({ kind: "files", files });
    };
    window.addEventListener("dragenter", handleDragEnter, true);
    window.addEventListener("dragover", handleDragOver, true);
    window.addEventListener("dragleave", handleDragLeave, true);
    window.addEventListener("drop", handleDrop, true);
    return () => {
      setIsDropTarget(false);
      window.removeEventListener("dragenter", handleDragEnter, true);
      window.removeEventListener("dragover", handleDragOver, true);
      window.removeEventListener("dragleave", handleDragLeave, true);
      window.removeEventListener("drop", handleDrop, true);
    };
  }, [options.enabled]);

  return isDropTarget;
}
