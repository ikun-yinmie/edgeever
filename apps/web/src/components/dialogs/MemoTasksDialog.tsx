import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MemoTasksView } from "../MemoTasksView";
import type { MemoTask, MemoTaskMark } from "@/lib/memo-tasks";

export const MemoTasksDialog = ({ open, onOpenChange, memoTitle, tasks, readOnly, onMark, onNavigate, triggerRef, navigatingRef }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  memoTitle: string;
  tasks: MemoTask[];
  readOnly: boolean;
  onMark: (task: MemoTask, mark: MemoTaskMark) => void | Promise<void>;
  onNavigate: (task: MemoTask) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  navigatingRef: RefObject<boolean>;
}) => {
  const { t } = useTranslation();
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0" onCloseAutoFocus={event => { event.preventDefault(); if (!navigatingRef.current) triggerRef.current?.focus(); }}>
      <DialogHeader className="shrink-0 border-b px-6 py-5 pr-14"><DialogTitle>{t("memoTasks.inNote")}</DialogTitle><DialogDescription>{t("memoTasks.noteDescription", { name: memoTitle })}</DialogDescription></DialogHeader>
      <div className="min-h-0 overflow-y-auto px-4 py-5 sm:px-6"><p className="mb-4 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600 dark:bg-slate-900 dark:text-slate-300">{t("memoTasks.rule")}</p><MemoTasksView tasks={tasks} memoTitles={new Map(tasks.map(task => [task.memoId, memoTitle]))} readOnly={readOnly} onMark={onMark} onNavigate={onNavigate} /></div>
      <footer className="flex shrink-0 justify-end border-t px-6 py-3"><Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>{t("memoTasks.returnNote")}</Button></footer>
    </DialogContent>
  </Dialog>;
};
