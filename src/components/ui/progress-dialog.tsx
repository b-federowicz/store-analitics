"use client";

import { Dispatch, SetStateAction } from "react";
import { Loader2, Minus, X } from "lucide-react";
import { Button } from "./button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./dialog";
import { Progress } from "./progress";

export interface ProgressDialogState {
  open: boolean;
  minimized: boolean;
  percent: number;
  message: string;
  error: string | null;
  done: boolean;
}

export const INITIAL_PROGRESS_DIALOG_STATE: ProgressDialogState = {
  open: false,
  minimized: false,
  percent: 0,
  message: "",
  error: null,
  done: false,
};

// Streamed long-running action UI: a dialog with a progress bar while open,
// collapsible into a small bottom-right bubble that keeps tracking progress
// in the background. Used by any action backed by an ndjson progress stream
// (see readNdjsonStream).
export function ProgressDialog({
  title,
  description,
  state,
  setState,
}: {
  title: string;
  description: string;
  state: ProgressDialogState;
  setState: Dispatch<SetStateAction<ProgressDialogState>>;
}) {
  const finished = state.done || !!state.error;

  return (
    <>
      <Dialog
        open={state.open && !state.minimized}
        onOpenChange={(open) => {
          if (open) return;
          if (finished) {
            setState(INITIAL_PROGRESS_DIALOG_STATE);
          } else {
            setState((prev) => ({ ...prev, minimized: true }));
          }
        }}
      >
        <DialogContent showCloseButton={finished}>
          {!finished && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-2 right-10"
              onClick={() => setState((prev) => ({ ...prev, minimized: true }))}
            >
              <Minus />
              <span className="sr-only">Minimize</span>
            </Button>
          )}
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Progress value={state.percent} />
            <p className="text-sm text-muted-foreground">
              {state.error ?? state.message}
            </p>
          </div>
        </DialogContent>
      </Dialog>
      {state.open && state.minimized && (
        <div
          role="button"
          tabIndex={0}
          onClick={() => setState((prev) => ({ ...prev, minimized: false }))}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              setState((prev) => ({ ...prev, minimized: false }));
            }
          }}
          className="fixed bottom-4 right-4 z-50 flex w-72 cursor-pointer items-center gap-3 rounded-xl bg-popover p-3 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10"
        >
          {state.error ? (
            <span className="size-4 shrink-0 rounded-full bg-destructive" />
          ) : state.done ? (
            <span className="size-4 shrink-0 rounded-full bg-primary" />
          ) : (
            <Loader2 className="size-4 shrink-0 animate-spin" />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="truncate font-medium">{title}</p>
            <Progress value={state.percent} className="h-1.5" />
            <p className="truncate text-xs text-muted-foreground">
              {state.error ?? state.message}
            </p>
          </div>
          {finished && (
            <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              setState(INITIAL_PROGRESS_DIALOG_STATE);
            }}
          >
            <X />
            <span className="sr-only">Dismiss</span>
          </Button>
          )}
          
        </div>
      )}
    </>
  );
}
