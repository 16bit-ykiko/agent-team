export function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Quota windows reset at a unix timestamp (seconds).
export function formatResetTime(resetsAt: number, now = Date.now()): string {
  const delta = resetsAt * 1000 - now;
  if (delta <= 0) return "now";
  const mins = Math.floor(delta / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h${remMins}m` : `${hours}h`;
}

// "3d ago", "2h ago", "just now" — for sidebar recency labels.
export function formatRelative(ts: number, now = Date.now()): string {
  const delta = Math.max(0, now - ts);
  const mins = Math.floor(delta / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

// "claude-fable-5-1[1m]" → "fable 5.1 [1m]", "claude-opus-4-6" → "opus 4.6",
// "claude-haiku-4-5-20251001" → "haiku 4.5", "gpt-5.6-sol" → "gpt 5.6 sol".
// 84_000 → "84k", 1_200_000 → "1.2M".
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

// 4200 → "4.2s", 45000 → "45s", 65000 → "1m 5s", 3_900_000 → "1h 5m".
export function formatDuration(ms: number): string {
  // Rounded first, or 59.96 s would read "60s".
  const secs = Math.round(ms / 100) / 10;
  if (secs < 60) return `${secs.toFixed(1).replace(/\.0$/, "")}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${Math.floor(secs % 60)}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function shortModel(model: string): string {
  const m = model.match(/^(.*?)(\[1m\])?$/i);
  let base = (m?.[1] ?? model).replace(/^claude-/, "").replace(/-\d{8}$/, "");
  base = base.replace(/-(\d+)-(\d+)(?=-|$)/, " $1.$2").replace(/-/g, " ");
  return m?.[2] ? `${base} ${m[2]}` : base;
}
