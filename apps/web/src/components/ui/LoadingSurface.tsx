import { FileText, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type LoadingSurfaceProps = {
  label: string;
  title?: string;
  detail?: string;
  variant?: "startup" | "pane" | "editor" | "tasks";
  action?: ReactNode;
  className?: string;
};

const TaskSkeleton = ({ label }: { label: string }) => (
  <div className="edgeever-loading__tasks">
    <h2 className="edgeever-loading__tasks-title">{label}</h2>
    <div className="edgeever-loading__task-filters" aria-hidden="true">
      <span className="edgeever-loading__task-filter edgeever-loading__task-filter--active" />
      <span className="edgeever-loading__task-filter" />
      <span className="edgeever-loading__task-filter edgeever-loading__task-filter--short" />
    </div>
    <div className="edgeever-loading__task-cards" aria-hidden="true">
      {[0, 1, 2].map((card) => (
        <div className="edgeever-loading__task-card" key={card}>
          <div className="edgeever-loading__task-card-heading">
            <span className="edgeever-loading__task-heading-mark" />
            <span className="edgeever-loading__task-heading-line" />
          </div>
          {[0, 1, ...(card === 2 ? [] : [2])].map((row) => (
            <div className="edgeever-loading__task-row" key={row}>
              <span className="edgeever-loading__task-checkbox" />
              <span className={cn("edgeever-loading__task-row-line", row === 1 && "edgeever-loading__task-row-line--short")} />
            </div>
          ))}
        </div>
      ))}
    </div>
  </div>
);

export const LoadingSurface = ({
  label,
  title,
  detail,
  variant = "pane",
  action,
  className,
}: LoadingSurfaceProps) => (
  <section
    className={cn("edgeever-loading", `edgeever-loading--${variant}`, className)}
    data-loading-surface={variant}
    role="status"
    aria-live="polite"
    aria-label={label}
  >
    {variant === "startup" ? (
      <div className="edgeever-loading__startup">
        <div className="edgeever-loading__brand-mark" aria-hidden="true">
          <span className="edgeever-loading__halo" />
          <span className="edgeever-loading__paper"><i /><i /><i /></span>
          <span className="edgeever-loading__note"><i /><i /></span>
        </div>
        {title && <h1 className="edgeever-loading__title">{title}</h1>}
        {detail && <p className="edgeever-loading__detail">{detail}</p>}
        <LoaderCircle className="edgeever-loading__spinner" aria-hidden="true" />
        {action}
      </div>
    ) : variant === "editor" ? (
      <div className="edgeever-loading__editor" aria-hidden="true">
        <div className="edgeever-loading__editor-title" />
        <div className="edgeever-loading__editor-meta" />
        <div className="edgeever-loading__editor-body"><i /><i /><i /><i /><i /></div>
      </div>
    ) : variant === "tasks" ? (
      <TaskSkeleton label={label} />
    ) : (
      <div className="edgeever-loading__pane">
        <span className="edgeever-loading__pane-icon" aria-hidden="true">
          <FileText strokeWidth={1.5} />
        </span>
        <span className="edgeever-loading__pane-label">{label}</span>
        <div className="edgeever-loading__pane-lines" aria-hidden="true">
          <span className="edgeever-loading__pane-line edgeever-loading__pane-line--long" />
          <span className="edgeever-loading__pane-line edgeever-loading__pane-line--short" />
        </div>
      </div>
    )}
  </section>
);

export const MemoTasksLoadingSurface = ({ label }: { label: string }) => (
  <LoadingSurface label={label} variant="tasks" />
);
