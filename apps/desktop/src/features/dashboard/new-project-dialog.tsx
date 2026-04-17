import { useState } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { FolderOpen, Loader2, X } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { useCreateProject } from "@/ipc/projects";
import {
  dialogBackdropMotionClassName,
  dialogCenteredPopupMotionClassName,
  dialogViewportClassName,
} from "@/components/ui/dialog-motion";

interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (projectId: string) => void;
}

export function NewProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: NewProjectDialogProps) {
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useCreateProject();

  const pickParent = async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Pick a parent folder for the new project",
      });
      if (typeof picked === "string") setParent(picked);
    } catch (e) {
      setError(String(e));
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Project name is required.");
      return;
    }
    if (!parent) {
      setError("Pick a parent folder.");
      return;
    }
    try {
      const project = await create.mutateAsync({ name: name.trim(), parent });
      setName("");
      setParent("");
      onCreated(project.id);
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className={`fixed inset-0 z-40 bg-[var(--color-fg-primary)/50] backdrop-blur-sm ${dialogBackdropMotionClassName}`}
        />
        <Dialog.Viewport className={dialogViewportClassName}>
          <Dialog.Popup
            className={`w-full max-w-md rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-6 shadow-xl ${dialogCenteredPopupMotionClassName}`}
          >
            <div className="flex items-start justify-between">
            <div>
              <Dialog.Title className="text-base font-semibold text-[var(--color-fg-primary)]">
                New project
              </Dialog.Title>
              <Dialog.Description className="text-sm text-[var(--color-fg-muted)] mt-1">
                Create a new StoryCapture project folder.
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Close dialog"
              className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] rounded-md p-1"
            >
              <X size={18} aria-hidden="true" />
            </Dialog.Close>
          </div>

          <form onSubmit={submit} className="mt-5 flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-[var(--color-fg-secondary)]">Name</span>
              <input
                autoFocus
                required
                minLength={1}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My first demo"
                className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] text-[var(--color-fg-primary)] px-3 py-2 focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-[var(--color-fg-secondary)]">Parent folder</span>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={parent}
                  placeholder="Click Browse to pick a folder"
                  aria-label="Parent folder path"
                  className="flex-1 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] text-[var(--color-fg-primary)] px-3 py-2 text-sm"
                />
                <button
                  type="button"
                  onClick={pickParent}
                  aria-label="Browse for parent folder"
                  className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] hover:bg-[var(--color-bg-surface)] px-3 py-2 text-sm text-[var(--color-fg-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
                >
                  <FolderOpen size={16} aria-hidden="true" />
                  Browse
                </button>
              </div>
            </label>

            {error && (
              <p role="alert" className="text-sm text-[var(--color-danger)]">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2 mt-2">
              <Dialog.Close
                className="rounded-md border border-[var(--color-border-default)] bg-transparent px-4 py-2 text-sm text-[var(--color-fg-secondary)] hover:text-[var(--color-fg-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
              >
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={create.isPending}
                className="inline-flex items-center gap-2 rounded-md bg-[var(--color-accent-primary)] px-4 py-2 text-sm font-medium text-[var(--color-fg-primary)] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)] disabled:opacity-60"
              >
                {create.isPending && (
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                )}
                Create project
              </button>
            </div>
          </form>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
