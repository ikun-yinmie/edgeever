import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

type LoadingIndicatorProps = {
  label: string;
  size?: "sm" | "md";
  centered?: boolean;
  className?: string;
};

export const LoadingIndicator = ({
  label,
  size = "sm",
  centered = false,
  className,
}: LoadingIndicatorProps) => (
  <div
    className={cn(
      "flex items-center gap-2 text-sm text-slate-500",
      centered && "justify-center",
      className,
    )}
    role="status"
    aria-live="polite"
  >
    <LoaderCircle
      className={cn(
        "shrink-0 animate-spin text-emerald-600 motion-reduce:animate-none",
        size === "md" ? "h-5 w-5" : "h-4 w-4",
      )}
      aria-hidden="true"
    />
    <span>{label}</span>
  </div>
);
