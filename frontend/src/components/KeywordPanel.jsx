export default function KeywordPanel({ keywordMatch }) {
  const { found, missing, totalKeywords, matchPercentage } = keywordMatch

  return (
    <div className="panel">
      <h2>Keyword Match</h2>
      <div className="match-stats">
        <span>{matchPercentage}% match</span>
        <span>{found.length} of {totalKeywords} keywords found</span>
      </div>
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${matchPercentage}%` }} />
      </div>

      <div className="keyword-section">
        <h3>✅ Found</h3>
        <div className="keyword-chips">
          {found.map((kw, i) => (
            <span key={i} className="chip found">{kw}</span>
          ))}
        </div>
      </div>

      <div className="keyword-section">
        <h3>❌ Missing</h3>
        <div className="keyword-chips">
          {missing.map((kw, i) => (
            <span key={i} className="chip missing">{kw}</span>
          ))}
        </div>
      </div>
    </div>
  )
}