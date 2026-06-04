import { useState } from 'react'
import { FiUser } from 'react-icons/fi'
import { HiDocumentMagnifyingGlass } from "react-icons/hi2"
import { TfiLayout } from "react-icons/tfi"
import { MdBarChart } from "react-icons/md"
import { FaEdit } from "react-icons/fa"
import UploadForm from './components/UploadForm'
import ScoreCard from './components/ScoreCard'
import KeywordPanel from './components/KeywordPanel'
import FeedbackPanel from './components/FeedbackPanel'
import SuggestionsPanel from './components/SuggestionsPanel'
import './App.css'

function App() {
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  return (
    <div className="app">
      <nav className="topnav">
        <div className="brand">
          <img src="/logo.png" alt="ResuMatch logo" className="brand-logo" />
          <span>ResuMatch</span>
        </div>
        <div className="nav-actions">
          <a className="nav-link" href="/">Home</a>
          <a className="nav-link" href="/">Job Finder</a>
          <a className="nav-link" href="/">Support</a>
          <button className="profile-btn" aria-label="Profile">
            <FiUser />
          </button>
        </div>
      </nav>
      
      <header className="header">
        <h1>CV Analyser <span>& ATS Scorer</span></h1>
        <p>Upload your CV and paste a job description to get an instant ATS score and feedback</p>
      </header>

      <main className="main">
        <div className="left">
          <div className="panel upload-panel">
            <UploadForm
              setResults={setResults}
              setLoading={setLoading}
              setError={setError}
            />
          </div>
        </div>

        <div className="right">
          {error && (
            <div className="panel error-box" role="alert" aria-live="assertive">
              <strong>⚠️ Error:</strong> {error}
              <p style={{ fontSize: '0.75rem', marginTop: '8px', opacity: 0.8 }}>
                Please check that the backend server is running and try again.
              </p>
            </div>
          )}
          
          {loading && !error ? (
            <div className="panel loading-panel">
              <div className="loading-box" role="status" aria-live="polite">
                <div className="spinner" aria-hidden="true"></div>
                <div className="loading-message">Wait a sec...</div>
              </div>
            </div>
          ) : results && !loading && !error ? (
            <>
              <div className="panel score-panel">
                <ScoreCard score={results.atsScore} verdict={results.recruiterVerdict} />
              </div>

              <div className="panel keywords-panel">
                <KeywordPanel keywordMatch={results.keywordMatch} />
              </div>

              <div className="panel sections-panel">
                <FeedbackPanel sections={results.sections} />
              </div>

              <div className="panel suggestions-panel">
                <SuggestionsPanel suggestions={results.suggestions} />
              </div>
            </>
          ) : (
            <>
              <div>
                
                <p className="rp-headline">See exactly how a real ATS reads your CV</p>
                <p className="rp-sub">Our AI replicates how applicant tracking systems rank and filter candidates — so you know what recruiters actually see before they do.</p>
              </div>

              <div className="rp-divider"></div>

              <div>
                <div className="rp-steps-label">What our ATS checks</div>

                <div className="rp-cards">
                  <div className="rp-card">
                    <div className="rp-card-icon">
                      <HiDocumentMagnifyingGlass size={20} aria-hidden="true" />
                    </div>
                    <div>
                      <p className="rp-card-title">Keyword matching</p>
                      <p className="rp-card-desc">Spots which terms from the job description appear in your CV — and flags the ones that don't.</p>
                    </div>
                  </div>

                  <div className="rp-card">
                    <div className="rp-card-icon">
                      <TfiLayout size={20} aria-hidden="true" />
                    </div>
                    <div>
                      <p className="rp-card-title">Format check</p>
                      <p className="rp-card-desc">Detects layouts, tables, and structures that cause ATS software to misread or skip your content.</p>
                    </div>
                  </div>

                  <div className="rp-card">
                    <div className="rp-card-icon">
                      <MdBarChart size={20} aria-hidden="true" />
                    </div>
                    <div>
                      <p className="rp-card-title">Role-fit scoring</p>
                      <p className="rp-card-desc">Measures how closely your experience and skills align with what the employer is asking for.</p>
                    </div>
                  </div>

                  <div className="rp-card">
                    <div className="rp-card-icon">
                      <FaEdit size={20} aria-hidden="true" />
                    </div>
                    <div>
                      <p className="rp-card-title">Rewrite suggestions</p>
                      <p className="rp-card-desc">Gives you specific, line-level fixes — not generic advice — so you know exactly what to change.</p>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  )
}

export default App