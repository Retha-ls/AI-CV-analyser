const PRIORITY_CONFIG = {
  critical: { label: 'Critical', className: 'priority-critical' },
  high:     { label: 'High',     className: 'priority-high'     },
  medium:   { label: 'Medium',   className: 'priority-medium'   },
  low:      { label: 'Low',      className: 'priority-low'      },
};

export default function SuggestionsPanel({ suggestions }) {
  return (
    <div className="panel suggestions-panel">
      <h2>💡 Improvement Suggestions</h2>
      <ol className="suggestions-list">
        {suggestions.map((s, i) => {
          // Handle both old string format and new object format
          if (typeof s === 'string') {
            return (
              <li key={i} className="suggestion-item">
                <span className="suggestion-number">{i + 1}</span>
                <p>{s}</p>
              </li>
            );
          }

          const priority = PRIORITY_CONFIG[s.priority] ?? PRIORITY_CONFIG.medium;

          return (
            <li key={i} className={`suggestion-item suggestion-item--${s.priority ?? 'medium'}`}>
              <span className="suggestion-number">{i + 1}</span>
              <div className="suggestion-content">
                <div className="suggestion-header">
                  <strong className="suggestion-title">{s.title}</strong>
                  <span className={`suggestion-priority ${priority.className}`}>
                    {priority.label}
                  </span>
                </div>
                <p className="suggestion-description">{s.description}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}