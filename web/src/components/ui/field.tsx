import { cn } from "@/lib/utils";

interface FieldProps {
  id?: string;
  label: React.ReactNode;
  /** Says what goes in and gives an example. */
  help?: React.ReactNode;
  /** Replaces the hint and turns it red. */
  error?: React.ReactNode;
  optional?: boolean;
  className?: string;
  children: React.ReactNode;
}

/** Label, control, hint. 7px between each. */
export function Field({ id, label, help, error, optional, className, children }: FieldProps) {
  return (
    <div className={cn("ui-field", className)}>
      <label htmlFor={id} className="t-label">
        {label}
        {optional ? <span className="ml-1.5 font-medium text-fg-3">optional</span> : null}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-bad">{error}</p>
      ) : help ? (
        <p className="t-small">{help}</p>
      ) : null}
    </div>
  );
}
