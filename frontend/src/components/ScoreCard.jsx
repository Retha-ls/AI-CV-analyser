export default function ScoreCard({ score, verdict }) {
  const getColor = (score) => {
    if (score >= 75) return '#22c55e'
    if (score >= 50) return '#f59e0b'
    return '#ef4444'
  }

  const getLabel = (score) => {
    if (score >= 75) return 'Strong Match'
    if (score >= 50) return 'Moderate Match'
    return 'Weak Match'
  }

  const color = getColor(score)
  const circumference = 2 * Math.PI * 54
  const offset = circumference - (score / 100) * circumference

  return (
    <div className="score-card">
      <div className="score-circle-wrap">
        <svg width="140" height="140" viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="54" fill="none" stroke="#e5e7eb" strokeWidth="10" />
          <circle
            cx="60" cy="60" r="54"
            fill="none"
            stroke={color}
            strokeWidth="10"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            transform="rotate(-90 60 60)"
          />
        </svg>
        <div className="score-label">
          <span className="score-number" style={{ color }}>{score}</span>
          <span className="score-pct">/ 100</span>
        </div>
      </div>
      <div className="score-info">
        <span className="score-badge" style={{ background: color }}>{getLabel(score)}</span>
        <h2>ATS Compatibility Score</h2>
        <p className="verdict">{verdict}</p>
      </div>
    </div>
  )
}