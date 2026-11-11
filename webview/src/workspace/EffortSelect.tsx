import type { ModelOption } from "../state/useServer";

// The effort levels a model takes, and the one it runs at when none is chosen.
export function effortOf(
  models: ModelOption[],
  model: string,
): { levels: string[]; fallback?: string } {
  const opt = models.find((m) => m.id === model);
  return { levels: opt?.effortLevels ?? [], fallback: opt?.effort ?? opt?.defaultEffort };
}

// Effort levels, "" for the model's default (`fallback`, when known): always
// for a new agent, for a running one only while none is set (/effort moves
// between levels, not back to none). Nothing when there are no levels.
export function EffortSelect({
  levels,
  fallback,
  value,
  onChange,
  className,
  label,
  fresh = false,
}: {
  levels: string[];
  fallback?: string;
  value: string;
  onChange: (effort: string) => void;
  className?: string;
  label: string;
  fresh?: boolean;
}) {
  if (levels.length === 0) return null;
  return (
    <select
      className={className}
      aria-label={label}
      title={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {(fresh || !value) && (
        <option value="">{fallback ? `default (${fallback})` : "default"}</option>
      )}
      {/* A level saved before the model's list lost it still shows as it is. */}
      {[...(value && !levels.includes(value) ? [value] : []), ...levels].map((l) => (
        <option key={l} value={l}>
          {l}
        </option>
      ))}
    </select>
  );
}
