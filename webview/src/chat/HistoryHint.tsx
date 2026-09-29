// Top-of-list status for paginated history: what is happening while older
// messages load, and where the conversation begins.
export function HistoryHint({
  hasMore,
  loading,
  loaded,
  count,
}: {
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  count: number;
}) {
  if (!loaded) {
    return (
      <div className="history-hint history-loading">
        <span className="spinner" /> Loading conversation…
      </div>
    );
  }
  if (loading) {
    return (
      <div className="history-hint history-loading">
        <span className="spinner" /> Loading older messages…
      </div>
    );
  }
  if (hasMore) return <div className="history-hint">Scroll up for older messages</div>;
  if (count > 0) return <div className="history-hint history-start">Beginning of conversation</div>;
  return null;
}
