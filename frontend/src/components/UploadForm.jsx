import { useState, useCallback, useRef } from 'react'
import { IoCloudUpload, IoClose } from "react-icons/io5";
import { MdDescription } from "react-icons/md";

const BACKEND_URL = 'http://localhost:5000'

// Validation constants (must match backend)
const MIN_CV_LENGTH = 100
const MIN_JOB_DESC_LENGTH = 50
const MIN_WORD_COUNT = 10
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
const ALLOWED_FILE_TYPES = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']

/**
 * Validates if text is meaningful (not gibberish)
 */
function validateTextQuality(text, fieldName, minLength, minWords) {
  if (!text?.trim()) {
    return `${fieldName} is required.`
  }
  
  // Check minimum length
  if (text.trim().length < minLength) {
    return `${fieldName} is too short. Please provide at least ${minLength} characters.`
  }

  // Check word count
  const wordCount = text.trim().split(/\s+/).length
  if (wordCount < minWords) {
    return `${fieldName} must contain at least ${minWords} words. You provided ${wordCount} word${wordCount === 1 ? '' : 's'}.`
  }

  // Check if gibberish (single letters/numbers)
  const meaningfulWords = text.match(/[a-zA-Z]{2,}/g) || []
  const meaningfulRatio = wordCount > 0 ? meaningfulWords.length / wordCount : 0
  
  if (meaningfulRatio < 0.3) {
    return `${fieldName} appears to be invalid or gibberish. Please enter real text with actual words.`
  }

  return null
}

/**
 * Validates file before upload
 */
function validateFile(file) {
  if (!file) {
    return 'No file selected.'
  }
  
  if (!ALLOWED_FILE_TYPES.includes(file.type)) {
    return `Unsupported file type: ${file.type}. Please upload PDF or DOCX files only.`
  }
  
  if (file.size > MAX_FILE_SIZE) {
    return `File too large (${(file.size / 1024 / 1024).toFixed(2)}MB). Maximum size is 10MB.`
  }
  
  // Check for empty file
  if (file.size === 0) {
    return 'File is empty. Please upload a valid file.'
  }
  
  // Check for suspicious file names or extensions
  const suspiciousExtensions = ['.exe', '.bat', '.sh', '.cmd', '.js', '.html', '.php']
  const fileExt = file.name.substring(file.name.lastIndexOf('.')).toLowerCase()
  if (suspiciousExtensions.includes(fileExt)) {
    return 'Invalid file type. Please upload a PDF or DOCX file.'
  }
  
  return null
}

export default function UploadForm({ setResults, setLoading, setError }) {
  const [cvFile, setCvFile] = useState(null)
  const [cvText, setCvText] = useState('')
  const [jobDescription, setJobDescription] = useState('')
  const [inputMode, setInputMode] = useState('file')
  const [fileValidationError, setFileValidationError] = useState(null)
  const [isUploading, setIsUploading] = useState(false)
  const fileInputRef = useRef(null)

  const handleFileChange = useCallback((e) => {
    const file = e.target.files[0]
    setFileValidationError(null)
    
    if (!file) {
      setCvFile(null)
      return
    }
    
    const validationError = validateFile(file)
    if (validationError) {
      setFileValidationError(validationError)
      setCvFile(null)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
      return
    }
    
    setCvFile(file)
  }, [])

  const handleFileDrop = useCallback((e) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    setFileValidationError(null)
    
    if (!file) return
    
    const validationError = validateFile(file)
    if (validationError) {
      setFileValidationError(validationError)
      setCvFile(null)
      return
    }
    
    setCvFile(file)
  }, [])

  const removeFile = useCallback((e) => {
    e.stopPropagation()
    setCvFile(null)
    setFileValidationError(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }, [])

  const handleSubmit = async () => {
    setError(null)
    setResults(null)
    setFileValidationError(null)

    // Validation - Required fields
    if (!jobDescription.trim()) {
      setError('Job description is required. Please paste the job posting you are applying for.')
      return
    }

    if (inputMode === 'file' && !cvFile) {
      setError('CV file required. Please upload a PDF or DOCX file.')
      return
    }

    if (inputMode === 'text' && !cvText.trim()) {
      setError('CV text required. Please paste your resume content.')
      return
    }

    // File validation
    if (inputMode === 'file') {
      const fileError = validateFile(cvFile)
      if (fileError) {
        setError(fileError)
        return
      }
    }

    // Text quality validation - Job description
    const jobDescError = validateTextQuality(jobDescription, 'Job description', MIN_JOB_DESC_LENGTH, MIN_WORD_COUNT)
    if (jobDescError) {
      setError(jobDescError)
      return
    }

    // Text quality validation - CV text (if in text mode)
    if (inputMode === 'text') {
      const cvError = validateTextQuality(cvText, 'CV', MIN_CV_LENGTH, MIN_WORD_COUNT)
      if (cvError) {
        setError(cvError)
        return
      }
    }

    setLoading(true)
    setIsUploading(true)

    try {
      let finalCvText = cvText

      if (inputMode === 'file') {
        const formData = new FormData()
        formData.append('file', cvFile)
        
        // Add timeout for upload
        const uploadController = new AbortController()
        const uploadTimeout = setTimeout(() => uploadController.abort(), 30000) // 30 second timeout
        
        try {
          console.log('Uploading file:', cvFile.name, 'Type:', cvFile.type, 'Size:', cvFile.size)
          
          const uploadRes = await fetch(`${BACKEND_URL}/api/upload`, {
            method: 'POST',
            body: formData,
            signal: uploadController.signal
          })
          
          clearTimeout(uploadTimeout)
          
          if (!uploadRes.ok) {
            let errorMessage = 'Failed to upload CV.'
            let errorDetails = null
            
            try {
              const uploadData = await uploadRes.json()
              errorMessage = uploadData.error || errorMessage
              errorDetails = uploadData.details
            } catch (e) {
              // If response isn't JSON, use status text
              errorMessage = `Upload failed (HTTP ${uploadRes.status}): ${uploadRes.statusText}`
            }
            
            // Provide specific guidance for PDF extraction errors
            if (errorMessage.toLowerCase().includes('extract') || errorMessage.toLowerCase().includes('pdf')) {
              errorMessage = 'Unable to extract text from the uploaded file. This can happen if the file is:\n' +
                           '- Password protected\n' +
                           '- A scanned image (not real text)\n' +
                           '- Corrupted or damaged\n\n' +
                           'Please try: Converting to plain text and pasting manually, or saving as a new PDF file.'
            } else if (errorMessage.toLowerCase().includes('docx')) {
              errorMessage = 'Unable to read the DOCX file. Please try saving it as a PDF or pasting the text directly.'
            }
            
            throw new Error(errorMessage)
          }
          
          const uploadData = await uploadRes.json()
          
          // Validate extracted text
          if (!uploadData.text || uploadData.text.trim().length === 0) {
            throw new Error('File was uploaded but no text could be extracted. The file may contain only images or be corrupted. Try pasting the text manually.')
          }
          
          if (uploadData.text.trim().length < MIN_CV_LENGTH) {
            throw new Error(`Extracted CV text is too short (${uploadData.text.length} characters). Minimum required is ${MIN_CV_LENGTH} characters. The file may not contain enough readable text.`)
          }
          
          console.log('File uploaded successfully. Extracted text length:', uploadData.text.length)
          finalCvText = uploadData.text
          
        } catch (uploadError) {
          if (uploadError.name === 'AbortError') {
            throw new Error('Upload timeout after 30 seconds. The file may be too large or the server is busy. Try pasting text directly.')
          }
          throw uploadError
        }
      }

      // Analyse endpoint with timeout
      const analyseController = new AbortController()
      const analyseTimeout = setTimeout(() => analyseController.abort(), 60000) // 60 second timeout
      
      console.log('Sending analysis request. CV length:', finalCvText.length, 'JD length:', jobDescription.length)
      
      const analyseRes = await fetch(`${BACKEND_URL}/api/analyse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cvText: finalCvText, jobDescription }),
        signal: analyseController.signal
      })
      
      clearTimeout(analyseTimeout)
      
      if (!analyseRes.ok) {
        let errorMessage = 'Analysis failed.'
        try {
          const analyseData = await analyseRes.json()
          errorMessage = analyseData.error || errorMessage
        } catch (e) {
          errorMessage = `Analysis failed (HTTP ${analyseRes.status}): ${analyseRes.statusText}`
        }
        
        if (analyseRes.status === 503 || analyseRes.status === 504) {
          errorMessage = 'Analysis service is temporarily unavailable. Please try again in a few moments.'
        } else if (analyseRes.status === 413) {
          errorMessage = 'The input is too large. Please shorten your CV or job description.'
        } else if (analyseRes.status === 429) {
          errorMessage = 'Too many requests. Please wait a moment before trying again.'
        }
        
        throw new Error(errorMessage)
      }
      
      const analyseData = await analyseRes.json()
      
      // Validate response structure
      if (!analyseData || typeof analyseData.atsScore === 'undefined') {
        throw new Error('Invalid response from server. Please try again.')
      }
      
      console.log('Analysis complete. Score:', analyseData.atsScore)
      setResults(analyseData)
      
    } catch (err) {
      console.error('Submission error:', err)
      
      // Network errors
      if (err.name === 'AbortError') {
        setError('Request timeout. The server is taking too long to respond. Please try again with shorter text.')
      } else if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
        setError('Cannot connect to the server. Make sure the backend is running on port 5000:\n\n' +
                '1. Open a terminal in the backend folder\n' +
                '2. Run: node server.js or npm start\n' +
                '3. Wait for "Server running on port 5000" message\n' +
                '4. Refresh this page and try again')
      } else if (err.message.toLowerCase().includes('pdf') || err.message.toLowerCase().includes('docx')) {
        setError(`File Error: ${err.message}\n\nTip: Use "Paste Text" mode instead of file upload for reliable parsing.`)
      } else {
        setError(err.message || 'An unexpected error occurred. Please try again.')
      }
    } finally {
      setLoading(false)
      setIsUploading(false)
    }
  }

  const getFileIcon = () => {
    if (!cvFile) return <IoCloudUpload className="icon-upload" />
    if (cvFile.type === 'application/pdf') return <MdDescription className="icon-pdf" />
    return <MdDescription className="icon-docx" />
  }

  return (
    <div className="upload-form">
      <div className="form-section">
        <h2>Your CV</h2>
        <div className="toggle-row">
          <button
            type="button"
            className={inputMode === 'file' ? 'toggle active' : 'toggle'}
            onClick={() => {
              setInputMode('file')
              setFileValidationError(null)
            }}
          >
            Upload File
          </button>
          <button
            type="button"
            className={inputMode === 'text' ? 'toggle active' : 'toggle'}
            onClick={() => setInputMode('text')}
          >
            Paste Text
          </button>
        </div>

        {inputMode === 'file' ? (
          <div className="file-upload-area">
            <div
              className={`file-drop${cvFile ? ' has-file' : ''}${fileValidationError ? ' error' : ''}`}
              onClick={() => !isUploading && fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleFileDrop}
              tabIndex={0}
              role="button"
              aria-label="Upload CV file"
              onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !isUploading) fileInputRef.current?.click() }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx"
                onChange={handleFileChange}
                id="cv-upload"
                style={{ display: 'none' }}
                disabled={isUploading}
              />
              {cvFile && !fileValidationError && !isUploading && (
                <button
                  className="file-remove-btn"
                  type="button"
                  aria-label="Remove selected file"
                  onClick={removeFile}
                  disabled={isUploading}
                >
                  <IoClose />
                </button>
              )}
              <div className="file-drop-content">
                {getFileIcon()}
                <span className="file-drop-text">
                  {cvFile && !fileValidationError ? (
                    <>
                      {cvFile.name}
                      <small>({(cvFile.size / 1024).toFixed(1)} KB)</small>
                    </>
                  ) : (
                    <>
                      Click or drag PDF/DOCX here
                      <small>Max 10MB</small>
                    </>
                  )}
                </span>
              </div>
            </div>
            {fileValidationError && (
              <div className="file-validation-error">
                {fileValidationError}
              </div>
            )}
            <div className="file-tip">
              Tip: If file upload fails, use "Paste Text" mode instead
            </div>
          </div>
        ) : (
          <textarea
            placeholder="Paste your CV text here... (minimum 100 characters)"
            value={cvText}
            onChange={(e) => setCvText(e.target.value)}
            rows={10}
            disabled={isUploading}
          />
        )}
      </div>

      <div className="form-section">
        <h2>Job Description</h2>
        <textarea
          placeholder="Paste the job description here... (minimum 50 characters)"
          value={jobDescription}
          onChange={(e) => setJobDescription(e.target.value)}
          rows={10}
          disabled={isUploading}
        />
        {jobDescription && jobDescription.trim().length < MIN_JOB_DESC_LENGTH && jobDescription.trim().length > 0 && (
          <div className="field-warning">
            Add more text to the job description (minimum {MIN_JOB_DESC_LENGTH} characters)
          </div>
        )}
      </div>

      <button 
        className="analyse-btn" 
        onClick={handleSubmit}
        disabled={isUploading}
      >
        {isUploading ? 'Processing...' : 'Analyse My CV'}
      </button>
    </div>
  )
}