export default function FeedbackPanel({ sections }) {
  const getColor = (score) => {
    if (score >= 75) return '#22c55e'
    if (score >= 50) return '#f59e0b'
    return '#ef4444'
  }

  return (
    <div className="panel">
      <h2>Section Breakdown</h2>
      {Object.entries(sections).map(([key, value]) => (
        <div key={key} className="section-item">
          <div className="section-header">
            <span className="section-name">{key.charAt(0).toUpperCase() + key.slice(1)}</span>
            <span className="section-score" style={{ color: getColor(value.score) }}>
              {value.score}/100
            </span>
          </div>
          <div className="section-bar">
            <div
              className="section-bar-fill"
              style={{ width: `${value.score}%`, background: getColor(value.score) }}
            />
          </div>
          <p className="section-feedback">{value.feedback}</p>
        </div>
      ))}
    </div>
  )
}