import type { GitInfo, PrInfo } from "./useServer";

// Branch, working-tree and PR summary for the workspace header.
export function GitBar({ git, pr }: { git: GitInfo | null; pr: PrInfo | null }) {
  if (!git?.branch && !pr) return null;
  const dirtyTitle = git
    ? [
        git.dirty ? `${git.dirty} changed file${git.dirty === 1 ? "" : "s"}` : "clean",
        git.ahead ? `${git.ahead} ahead of upstream` : "",
        git.behind ? `${git.behind} behind upstream` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const prLabel = pr
    ? pr.state === "merged"
      ? "merged"
      : pr.state === "closed"
        ? "closed"
        : pr.draft
          ? "draft"
          : "open"
    : null;
  return (
    <>
      {git?.branch && (
        <span className="ws-info-item ws-info-branch" title={dirtyTitle}>
          <span className="ws-info-icon">&#9831;</span>
          <span className="ws-branch-name">{git.branch}</span>
          {git.dirty > 0 && <span className="git-badge git-dirty">●{git.dirty}</span>}
          {git.ahead > 0 && <span className="git-badge git-ahead">↑{git.ahead}</span>}
          {git.behind > 0 && <span className="git-badge git-behind">↓{git.behind}</span>}
        </span>
      )}
      {pr && (
        <a
          className={`pr-card pr-${prLabel}`}
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          title={`${pr.title} (${prLabel}${pr.checks ? `, checks ${pr.checks}` : ""})`}
        >
          <span className="pr-number">#{pr.number}</span>
          {pr.title && <span className="pr-title">{pr.title}</span>}
          <span className="pr-state">{prLabel}</span>
          {pr.checks && <span className={`pr-checks pr-checks-${pr.checks}`} />}
        </a>
      )}
    </>
  );
}
