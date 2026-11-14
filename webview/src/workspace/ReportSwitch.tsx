import type { ProjectLink } from "../state/useServer";

// Whether a project session reports to the lead, as the user switches it.
// The lead itself has no switch.
export function ReportSwitch({
  link,
  onSet,
}: {
  link?: ProjectLink;
  onSet: (reports: boolean) => void;
}) {
  if (link?.role !== "worker") return null;
  const reports = !link.unreported;
  return (
    <button
      className={`btn-ghost ws-report-btn${reports ? " on" : ""}`}
      aria-pressed={reports}
      title={
        reports
          ? "Reports to the project's lead, which may send it work. Click to stop: it keeps reading the board and history"
          : "Your own session: the lead neither hears from it nor sends it work. Click to report to the lead"
      }
      onClick={() => onSet(!reports)}
    >
      {reports ? "Reports to lead" : "Not reporting"}
    </button>
  );
}
