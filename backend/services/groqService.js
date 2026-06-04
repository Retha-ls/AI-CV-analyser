/**
 * groqService.js — Production CV Analysis Service v4
 *
 * Key fixes over v3:
 *  ✓ Keyword expansion restricted to skills/tools/qualifications only — no noise
 *  ✓ Keyword matching uses concept-level search, not literal substring
 *  ✓ Experience scoring counts projects + freelance work, not just employment
 *  ✓ Scoring prompt is explicit about student/early-career candidates
 *  ✓ Sanity checks expanded and more aggressive
 *  ✓ matchKeywords uses both expanded forms AND model verdict reconciliation
 */

import Groq   from 'groq-sdk';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

// ─── Custom Error Classes ──────────────────────────────────────────────────────
class GroqServiceError extends Error {
  constructor(message, code, retryable = false) {
    super(message);
    this.name      = 'GroqServiceError';
    this.code      = code;
    this.retryable = retryable;
  }
}
class ParseError      extends GroqServiceError { constructor(m) { super(m, 'PARSE_ERROR',      false); } }
class ModelError      extends GroqServiceError { constructor(m) { super(m, 'MODEL_ERROR',      true);  } }
class ValidationError extends GroqServiceError { constructor(m) { super(m, 'VALIDATION_ERROR', false); } }

// ─── Configuration ─────────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const WEIGHTS = Object.freeze({
  keywords:   0.40,
  experience: 0.30,
  education:  0.20,
  summary:    0.10,
});

const CONFIG = Object.freeze({
  MODEL:                    'llama-3.3-70b-versatile',
  FAST_MODEL:               'llama-3.1-8b-instant',
  MAX_ATTEMPTS:             3,
  CV_MIN_CHARS:             100,
  CV_MAX_CHARS:             50_000,
  JD_MAX_CHARS:             10_000,
  MIN_RESPONSE_LENGTH:      50,
  MAX_TOKENS_EXTRACT:       2_000,
  MAX_TOKENS_SCORE:         3_000,
  MAX_TOKENS_EXPAND:        800,
  TEMPERATURE:              0.1,
  CACHE_TTL_MS:             60 * 60 * 1000,
  CACHE_MAX_SIZE:           500,
  CB_FAILURE_THRESHOLD:     5,
  CB_RESET_TIMEOUT_MS:      30_000,
  FEEDBACK_MAX_CHARS:       500,
  VERDICT_MAX_CHARS:        1_500,
  SUGGESTION_MAX_CHARS:     400,
  KEYWORD_EXPAND_CACHE_TTL: 24 * 60 * 60 * 1000,
});

// ─── LRU Cache ─────────────────────────────────────────────────────────────────
class LRUCache {
  #cache = new Map();
  constructor(maxSize, ttlMs) { this.maxSize = maxSize; this.ttlMs = ttlMs; }

  get(key) {
    if (!this.#cache.has(key)) return null;
    const entry = this.#cache.get(key);
    if (Date.now() - entry.timestamp > this.ttlMs) { this.#cache.delete(key); return null; }
    this.#cache.delete(key);
    this.#cache.set(key, entry);
    return entry.result;
  }

  set(key, result) {
    if (this.#cache.has(key)) this.#cache.delete(key);
    if (this.#cache.size >= this.maxSize) this.#cache.delete(this.#cache.keys().next().value);
    this.#cache.set(key, { result, timestamp: Date.now() });
  }

  delete(key) { this.#cache.delete(key); }
  get size()   { return this.#cache.size; }
  clear()      { this.#cache.clear(); }
}

const analysisCache      = new LRUCache(CONFIG.CACHE_MAX_SIZE, CONFIG.CACHE_TTL_MS);
const keywordExpandCache = new LRUCache(1_000, CONFIG.KEYWORD_EXPAND_CACHE_TTL);

// ─── Circuit Breaker ───────────────────────────────────────────────────────────
class CircuitBreaker {
  #failures = 0; #lastFailureAt = null; #state = 'CLOSED';
  constructor(threshold, resetTimeoutMs) { this.threshold = threshold; this.resetTimeoutMs = resetTimeoutMs; }

  isOpen() {
    if (this.#state === 'OPEN') {
      if (Date.now() - this.#lastFailureAt > this.resetTimeoutMs) {
        this.#state = 'HALF_OPEN';
        console.log('🔌 Circuit breaker → HALF_OPEN');
        return false;
      }
      return true;
    }
    return false;
  }

  onSuccess() {
    if (this.#state !== 'CLOSED') console.log('✅ Circuit breaker → CLOSED');
    this.#failures = 0; this.#state = 'CLOSED';
  }

  onFailure() {
    this.#failures++; this.#lastFailureAt = Date.now();
    if (this.#failures >= this.threshold) {
      console.error(`🔴 Circuit breaker → OPEN (${this.#failures} failures)`);
      this.#state = 'OPEN';
    }
  }

  get state()    { return this.#state; }
  get failures() { return this.#failures; }
}

const circuitBreaker   = new CircuitBreaker(CONFIG.CB_FAILURE_THRESHOLD, CONFIG.CB_RESET_TIMEOUT_MS);
const inFlightRequests = new Map();

// ─── Helpers ───────────────────────────────────────────────────────────────────
const clamp = (val, lo, hi) => Math.min(hi, Math.max(lo, isFinite(val) ? val : lo));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getCacheKey(cvText, jobDescription) {
  return crypto.createHash('sha256').update(`${cvText}|${jobDescription}`).digest('hex');
}

function sanitiseText(text) {
  return text
    .replace(/\0/g, '')
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/\r\n|\r/g, '\n')
    .replace(/[ \t]{3,}/g, '  ')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

// ─── Tool Schemas ──────────────────────────────────────────────────────────────

const CV_EXTRACTION_TOOL = {
  type: 'function',
  function: {
    name: 'submit_cv_structure',
    description: 'Submit structured data extracted from the CV.',
    parameters: {
      type: 'object',
      required: ['personalInfo', 'summary', 'experience', 'projects', 'education', 'skills', 'certifications', 'languages', 'cvQuality'],
      properties: {
        personalInfo: {
          type: 'object',
          properties: {
            name:      { type: 'string' },
            email:     { type: 'string' },
            phone:     { type: 'string' },
            location:  { type: 'string' },
            linkedin:  { type: 'string' },
            portfolio: { type: 'string' },
          },
        },
        summary: {
          type: 'object',
          required: ['text', 'wordCount', 'isTailored'],
          properties: {
            text:       { type: 'string' },
            wordCount:  { type: 'integer' },
            isTailored: { type: 'boolean' },
          },
        },
        experience: {
          type: 'array',
          description: 'Paid jobs and internships only — NOT personal projects.',
          items: {
            type: 'object',
            required: ['title', 'company', 'startYear', 'endYear', 'isCurrent', 'responsibilities', 'hasMetrics', 'yearsInRole'],
            properties: {
              title:            { type: 'string' },
              company:          { type: 'string' },
              startYear:        { type: 'integer' },
              endYear:          { type: 'integer' },
              isCurrent:        { type: 'boolean' },
              responsibilities: { type: 'array', items: { type: 'string' } },
              hasMetrics:       { type: 'boolean' },
              yearsInRole:      { type: 'number' },
            },
          },
        },
        projects: {
          type: 'array',
          description: 'Personal, academic, and freelance projects. These count toward practical experience.',
          items: {
            type: 'object',
            required: ['name', 'description', 'technologiesUsed', 'isLive', 'hasMetrics', 'domain'],
            properties: {
              name:              { type: 'string' },
              description:       { type: 'string' },
              technologiesUsed:  { type: 'array', items: { type: 'string' } },
              isLive:            { type: 'boolean', description: 'Does the CV include a live demo/URL?' },
              hasMetrics:        { type: 'boolean', description: 'Does this project include measurable outcomes?' },
              domain:            { type: 'string',  description: 'e.g. e-commerce, fintech, productivity, agri-tech' },
            },
          },
        },
        education: {
          type: 'array',
          items: {
            type: 'object',
            required: ['degree', 'institution', 'field', 'year', 'isRelevant'],
            properties: {
              degree:      { type: 'string' },
              institution: { type: 'string' },
              field:       { type: 'string' },
              year:        { type: 'integer' },
              gpa:         { type: 'string' },
              isRelevant:  { type: 'boolean' },
            },
          },
        },
        skills: {
          type: 'object',
          required: ['technical', 'soft', 'tools', 'programmingLanguages'],
          properties: {
            technical:            { type: 'array', items: { type: 'string' } },
            soft:                 { type: 'array', items: { type: 'string' } },
            tools:                { type: 'array', items: { type: 'string' } },
            programmingLanguages: { type: 'array', items: { type: 'string' } },
          },
        },
        certifications: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'issuer', 'year'],
            properties: {
              name:   { type: 'string' },
              issuer: { type: 'string' },
              year:   { type: 'integer' },
            },
          },
        },
        languages: {
          type: 'array',
          description: 'Human spoken languages, not programming languages.',
          items: {
            type: 'object',
            required: ['language', 'proficiency'],
            properties: {
              language:    { type: 'string' },
              proficiency: { type: 'string' },
            },
          },
        },
        cvQuality: {
          type: 'object',
          required: ['totalWords', 'hasSummary', 'hasQuantifiedAchievements', 'hasPortfolioOrGithub', 'sectionsMissing', 'formattingIssues'],
          properties: {
            totalWords:                { type: 'integer' },
            hasSummary:                { type: 'boolean' },
            hasQuantifiedAchievements: { type: 'boolean' },
            hasPortfolioOrGithub:      { type: 'boolean' },
            sectionsMissing:           { type: 'array', items: { type: 'string' } },
            formattingIssues:          { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
};

const KEYWORD_EXPANSION_TOOL = {
  type: 'function',
  function: {
    name: 'submit_keyword_expansion',
    description: 'Submit expanded skill/tool/qualification keywords extracted from the JD.',
    parameters: {
      type: 'object',
      required: ['keywords'],
      properties: {
        keywords: {
          type: 'array',
          items: {
            type: 'object',
            required: ['canonical', 'variants', 'category'],
            properties: {
              canonical: { type: 'string' },
              variants:  { type: 'array', items: { type: 'string' } },
              category:  {
                type: 'string',
                enum: ['technology', 'language', 'framework', 'tool', 'qualification', 'methodology', 'soft_skill'],
                description: 'What type of keyword this is.',
              },
            },
          },
        },
      },
    },
  },
};

const SCORING_TOOL = {
  type: 'function',
  function: {
    name: 'submit_cv_scoring',
    description: 'Submit the final CV scoring and analysis result.',
    parameters: {
      type: 'object',
      required: ['keywordMatch', 'sections', 'suggestions', 'recruiterVerdict', 'hiringRecommendation'],
      properties: {
        keywordMatch: {
          type: 'object',
          required: ['found', 'missing'],
          properties: {
            found:   { type: 'array', items: { type: 'string' } },
            missing: { type: 'array', items: { type: 'string' } },
          },
        },
        sections: {
          type: 'object',
          required: ['experience', 'skills', 'education', 'summary'],
          properties: {
            experience: { $ref: '#/$defs/SectionScore' },
            skills:     { $ref: '#/$defs/SectionScore' },
            education:  { $ref: '#/$defs/SectionScore' },
            summary:    { $ref: '#/$defs/SectionScore' },
          },
        },
        suggestions: {
          type: 'array',
          minItems: 3,
          maxItems: 8,
          items: {
            type: 'object',
            required: ['priority', 'title', 'description'],
            properties: {
              priority:    { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
              title:       { type: 'string' },
              description: { type: 'string' },
            },
          },
        },
        recruiterVerdict: {
          type: 'string',
          description: '3–5 sentences as a senior recruiter citing specific CV evidence.',
        },
        hiringRecommendation: {
          type: 'string',
          enum: ['strong_yes', 'yes', 'maybe', 'no', 'strong_no'],
        },
      },
      $defs: {
        SectionScore: {
          type: 'object',
          required: ['score', 'feedback', 'confidence', 'strengths', 'gaps'],
          properties: {
            score:      { type: 'integer', minimum: 0, maximum: 100 },
            feedback:   { type: 'string' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            strengths:  { type: 'array', items: { type: 'string' }, maxItems: 3 },
            gaps:       { type: 'array', items: { type: 'string' }, maxItems: 3 },
          },
        },
      },
    },
  },
};

// ─── Pass 0: Keyword Expansion ─────────────────────────────────────────────────
async function expandJDKeywords(jdText, reqId) {
  const jdHash = crypto.createHash('sha256').update(jdText).digest('hex').slice(0, 16);
  const cached = keywordExpandCache.get(jdHash);
  if (cached) {
    console.log(`[${reqId}] 🔑 Keyword expansion cache hit`);
    return cached;
  }

  console.log(`[${reqId}] 🔑 Expanding JD keywords…`);

  const prompt = `Extract ONLY skills, technologies, tools, frameworks, qualifications, and methodologies from this job description.

STRICT RULES:
- Extract ONLY: programming languages, frameworks, tools, technologies, degrees, certifications, methodologies (Agile/Scrum), and soft skills explicitly listed as requirements
- DO NOT extract: company names, location names, project names, industry nouns (e.g. "farmers", "dashboard"), generic verbs (e.g. "build", "train"), or vague concepts
- BAD examples: "farm management", "smallholder farmers", "Lesotho", "Budget Bridge", "weather data"
- GOOD examples: "React", "MySQL", "PHP", "mobile-responsive", "user authentication", "Computer Science degree", "offline-first"
- For each keyword, include common synonyms and alternate forms
- Maximum 15 keywords total

JOB DESCRIPTION:
${jdText.slice(0, 4000)}`;

  try {
    const response = await groq.chat.completions.create({
      model:       CONFIG.FAST_MODEL,
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.0,
      max_tokens:  CONFIG.MAX_TOKENS_EXPAND,
      tools:       [KEYWORD_EXPANSION_TOOL],
      tool_choice: { type: 'function', function: { name: 'submit_keyword_expansion' } },
    });

    const toolCall = response.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) throw new Error('No tool call in expansion response');

    const { keywords } = JSON.parse(toolCall.function.arguments);

    const expansionMap = new Map();
    const keywordList  = [];

    for (const { canonical, variants, category } of keywords) {
      const allForms = [canonical, ...variants].map(v => v.toLowerCase().trim());
      keywordList.push({ canonical, allForms, category });
      for (const form of allForms) expansionMap.set(form, canonical);
    }

    const result = { keywordList, expansionMap };
    keywordExpandCache.set(jdHash, result);
    console.log(`[${reqId}] 🔑 Expanded to ${keywordList.length} keywords: ${keywordList.map(k => k.canonical).join(', ')}`);
    return result;

  } catch (err) {
    console.warn(`[${reqId}] Keyword expansion failed (${err.message}), using empty list`);
    return { keywordList: [], expansionMap: new Map() };
  }
}

// ─── Pass 1: CV Structure Extraction ──────────────────────────────────────────
async function extractCVStructure(cvText, reqId, attempt) {
  console.log(`[${reqId}] 📄 Pass 1 — Extracting CV structure (attempt ${attempt})…`);

  const prompt = `You are a precise CV parser. Extract every piece of structured information from the CV below.

IMPORTANT RULES:
- Separate "experience" (paid jobs, internships) from "projects" (personal, academic, freelance)
- Projects are NOT less valuable than work experience — extract them fully
- For each project, note which technologies were used and whether it has a live URL
- Be faithful to the source — do not invent information
- If a field is absent, use empty string or empty array

CV TEXT:
${cvText}`;

  let response;
  try {
    response = await groq.chat.completions.create({
      model:       CONFIG.MODEL,
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.0,
      max_tokens:  CONFIG.MAX_TOKENS_EXTRACT,
      tools:       [CV_EXTRACTION_TOOL],
      tool_choice: { type: 'function', function: { name: 'submit_cv_structure' } },
    });
  } catch (err) {
    throw new ModelError(`CV extraction SDK error: ${err?.message ?? 'Unknown'}`);
  }

  const toolCall = response.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new ModelError('No tool call returned in CV extraction pass.');

  try {
    return JSON.parse(toolCall.function.arguments);
  } catch (err) {
    throw new ParseError(`CV extraction JSON invalid: ${err.message}`);
  }
}

// ─── Pass 2: Scoring & Suggestions ────────────────────────────────────────────
async function scoreCVAgainstJD(cvStructure, jdText, expandedKeywords, reqId, attempt) {
  console.log(`[${reqId}] 🎯 Pass 2 — Scoring CV against JD (attempt ${attempt})…`);

  const totalExpYears = cvStructure.experience
    .reduce((sum, job) => sum + (job.yearsInRole ?? 0), 0);

  const projectCount = (cvStructure.projects ?? []).length;
  const liveProjects = (cvStructure.projects ?? []).filter(p => p.isLive).length;

  const allSkillsFlat = [
    ...cvStructure.skills.technical,
    ...cvStructure.skills.tools,
    ...cvStructure.skills.programmingLanguages,
    ...(cvStructure.projects ?? []).flatMap(p => p.technologiesUsed),
  ].map(s => s.toLowerCase());

  // Pre-compute keyword hints using concept-level search
  const cvFullText = buildCVSearchText(cvStructure);
  const keywordHints = expandedKeywords.keywordList.map(({ canonical, allForms }) => {
    const found = allForms.some(form => cvFullText.includes(form));
    return `${canonical}: ${found ? '✓ FOUND' : '✗ MISSING'}`;
  }).join('\n');

  const isStudent = cvStructure.education.some(e => e.year >= new Date().getFullYear() - 1);

  const prompt = `You are a senior technical recruiter with 15 years of experience hiring software developers.

## YOUR TASK
Score this candidate's CV against the job description. Be accurate and evidence-based — neither generous nor harsh.

## CRITICAL: CANDIDATE CONTEXT
- This candidate has ${totalExpYears.toFixed(1)} years of formal work experience
- They have ${projectCount} projects (${liveProjects} with live demos)
- Is student/recent grad: ${isStudent ? 'YES — apply student-adjusted rubric' : 'NO — apply standard rubric'}
- All technologies demonstrated: ${allSkillsFlat.slice(0, 40).join(', ')}

## EXPERIENCE SCORING — READ CAREFULLY
For students and early-career candidates, projects ARE experience. Score the full depth of practical work:
  90–100 : Highly relevant work/projects, quantified results, clear technical depth, leadership shown
  70–89  : Relevant work/projects, demonstrates the required skills, some real-world delivery
  50–69  : Partial match — has some relevant skills but limited depth or relevance
  30–49  : Minimal relevant experience, mostly unrelated work or very basic projects
  0–29   : No relevant experience whatsoever

A candidate with 3 live full-stack projects and an internship should score AT LEAST 55 on experience, even with < 1 year formal employment.

## SKILLS SCORING (display only — does NOT affect atsScore)
  90–100 : 8+ required skills demonstrated (in skills list OR projects OR experience)
  70–89  : 5–7 required skills demonstrated
  50–69  : 3–4 required skills demonstrated
  0–49   : 0–2 required skills demonstrated

## EDUCATION SCORING
  90–100 : Masters/PhD in directly relevant field
  75–89  : Bachelor's in directly relevant field (CS, Software Engineering, etc.)
  55–74  : Bachelor's in related field
  35–54  : Bachelor's in unrelated field
  20–34  : Relevant certifications only, no degree
  0–19   : No education mentioned

## SUMMARY SCORING
  90–100 : Tailored to this specific role/domain, clear value proposition, mentions relevant skills
  70–89  : Relevant but somewhat generic
  50–69  : Weak, vague, or brief but present
  0–49   : Missing or completely off-target

## KEYWORD MATCHING RULES
Mark a keyword as FOUND if the skill or concept appears ANYWHERE in the CV (experience, projects, skills section):
- "Mobile-responsive" = FOUND if CV mentions "responsive design", "mobile-first", "mobile-responsive"
- "User authentication" = FOUND if CV mentions "authentication", "secure user", "login system"
- "Financial/budget tracking" = FOUND if candidate has ANY financial or budgeting project
- "Database design" = FOUND if candidate has used MySQL, PostgreSQL, or designed DB schemas
- "React" = FOUND if explicitly listed in skills — do NOT assume from other frameworks
Use the KEYWORD HINTS below as your starting point but verify against the full CV data.

## SUGGESTION QUALITY RULES
Every suggestion MUST:
1. Reference specific content from the candidate's actual CV (name their projects, companies, skills)
2. State exactly what to add, change, or rewrite
3. Be ordered by impact (critical first)

BAD: "Add missing keywords to your Skills section"
GOOD: "Add 'offline-first' or 'Progressive Web App (PWA)' to your Skills — the JD requires offline capability and your MobiPay and AfricArt projects could support this claim if you implemented service workers or local storage"

## STRUCTURED CV DATA
${JSON.stringify(cvStructure, null, 2)}

## JOB DESCRIPTION
${jdText}

## KEYWORD HINTS (verify each against CV data above before deciding)
${keywordHints || 'No pre-computed hints — use your own analysis.'}

## HIRING RECOMMENDATION
  strong_yes : Exceptional match, interview immediately
  yes        : Good match, worth interviewing
  maybe      : Partial match, real concerns exist
  no         : Poor match, significant gaps
  strong_no  : Very poor match or disqualifying issue`;

  let response;
  try {
    response = await groq.chat.completions.create({
      model:       CONFIG.MODEL,
      messages:    [{ role: 'user', content: prompt }],
      temperature: CONFIG.TEMPERATURE,
      max_tokens:  CONFIG.MAX_TOKENS_SCORE,
      tools:       [SCORING_TOOL],
      tool_choice: { type: 'function', function: { name: 'submit_cv_scoring' } },
    });
  } catch (err) {
    throw new ModelError(`Scoring SDK error: ${err?.message ?? 'Unknown'}`);
  }

  if (response.usage) {
    console.log(`[${reqId}] 🪙 Tokens — prompt: ${response.usage.prompt_tokens}, completion: ${response.usage.completion_tokens}`);
  }

  const toolCall = response.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new ModelError('No tool call returned in scoring pass.');

  try {
    return JSON.parse(toolCall.function.arguments);
  } catch (err) {
    throw new ParseError(`Scoring JSON invalid: ${err.message}`);
  }
}

// ─── Build a flat searchable text from CV structure ────────────────────────────
// Used for keyword matching — covers skills, projects, experience, education
function buildCVSearchText(cvStructure) {
  const parts = [
    JSON.stringify(cvStructure.skills),
    ...(cvStructure.projects ?? []).map(p =>
      `${p.name} ${p.description} ${p.technologiesUsed.join(' ')} ${p.domain}`
    ),
    ...cvStructure.experience.map(e =>
      `${e.title} ${e.company} ${e.responsibilities.join(' ')}`
    ),
    ...cvStructure.education.map(e => `${e.degree} ${e.field} ${e.institution}`),
    cvStructure.summary.text,
  ];
  return parts.join(' ').toLowerCase();
}

// ─── Keyword Matching ──────────────────────────────────────────────────────────
function matchKeywords(cvStructure, scoringResult, expandedKeywords) {
  // If we have expanded keywords, do concept-level matching against full CV text
  if (expandedKeywords.keywordList.length > 0) {
    const cvSearchText = buildCVSearchText(cvStructure);
    const found   = [];
    const missing = [];

    for (const { canonical, allForms } of expandedKeywords.keywordList) {
      const inCV = allForms.some(form => cvSearchText.includes(form));
      (inCV ? found : missing).push(canonical);
    }

    const total = found.length + missing.length;
    return {
      found,
      missing,
      totalKeywords:   total,
      matchPercentage: total > 0 ? Math.round((found.length / total) * 100) : 0,
    };
  }

  // Fallback: trust the model's keyword lists
  const modelFound   = scoringResult.keywordMatch?.found   ?? [];
  const modelMissing = scoringResult.keywordMatch?.missing ?? [];
  const total = modelFound.length + modelMissing.length;
  return {
    found:           modelFound,
    missing:         modelMissing,
    totalKeywords:   total,
    matchPercentage: total > 0 ? Math.round((modelFound.length / total) * 100) : 0,
  };
}

// ─── Score Sanity Check ────────────────────────────────────────────────────────
function sanityCheckScores(sections, cvStructure) {
  const totalYears   = cvStructure.experience.reduce((s, j) => s + (j.yearsInRole ?? 0), 0);
  const projectCount = (cvStructure.projects ?? []).length;
  const liveProjects = (cvStructure.projects ?? []).filter(p => p.isLive).length;

  // Experience: student with live projects should never score below 40
  if (projectCount >= 2 && liveProjects >= 1 && sections.experience.score < 40) {
    console.warn(`⚠️  Sanity: Experience score (${sections.experience.score}) too low for candidate with ${projectCount} projects (${liveProjects} live) — adjusting to 45`);
    sections.experience.score = 45;
  }

  // Experience: 5+ years should never score below 50
  if (totalYears >= 5 && sections.experience.score < 50) {
    console.warn(`⚠️  Sanity: Experience score (${sections.experience.score}) too low for ${totalYears.toFixed(1)} yrs — adjusting to 55`);
    sections.experience.score = 55;
  }

  // Education: degree present → never 0
  if (cvStructure.education.length > 0 && sections.education.score === 0) {
    console.warn(`⚠️  Sanity: Education score was 0 but degrees found — adjusting to 40`);
    sections.education.score = 40;
  }

  // Education: relevant CS/SE degree should score at least 70
  const hasRelevantDegree = cvStructure.education.some(e => e.isRelevant);
  if (hasRelevantDegree && sections.education.score < 70) {
    console.warn(`⚠️  Sanity: Relevant degree present but education score is ${sections.education.score} — adjusting to 75`);
    sections.education.score = Math.max(sections.education.score, 75);
  }

  // Summary: present with >20 words should never score below 40
  if (cvStructure.summary.wordCount > 20 && sections.summary.score < 40) {
    console.warn(`⚠️  Sanity: Summary score (${sections.summary.score}) too low for ${cvStructure.summary.wordCount}-word summary — adjusting to 45`);
    sections.summary.score = Math.max(sections.summary.score, 45);
  }

  return sections;
}

// ─── Final Result Assembly ─────────────────────────────────────────────────────
function assembleResult(cvStructure, scoringResult, keywordMatch, reqId, startTime, attempt) {
  const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);
  const sectionDefaults  = { score: 50, feedback: 'Insufficient data.', confidence: 'low', strengths: [], gaps: [] };

  const sections = {};
  for (const key of ['experience', 'skills', 'education', 'summary']) {
    const raw = scoringResult.sections?.[key] ?? {};
    sections[key] = {
      score:      clamp(Number(raw.score ?? sectionDefaults.score), 0, 100),
      feedback:   typeof raw.feedback === 'string' && raw.feedback.trim()
        ? raw.feedback.slice(0, CONFIG.FEEDBACK_MAX_CHARS)
        : sectionDefaults.feedback,
      confidence: VALID_CONFIDENCE.has(raw.confidence) ? raw.confidence : 'low',
      strengths:  Array.isArray(raw.strengths) ? raw.strengths.slice(0, 3) : [],
      gaps:       Array.isArray(raw.gaps)      ? raw.gaps.slice(0, 3)      : [],
    };
  }

  sanityCheckScores(sections, cvStructure);

  const atsScore = clamp(
    Math.round(
      keywordMatch.matchPercentage  * WEIGHTS.keywords   +
      sections.experience.score     * WEIGHTS.experience +
      sections.education.score      * WEIGHTS.education  +
      sections.summary.score        * WEIGHTS.summary,
    ),
    0, 100,
  );

  // Suggestions — model returns {priority, title, description} objects
  const rawSuggestions = Array.isArray(scoringResult.suggestions) ? scoringResult.suggestions : [];
  const suggestions = rawSuggestions
    .filter(s => s && typeof s === 'object' && s.title && s.description)
    .map(s => ({
      priority:    s.priority    || 'medium',
      title:       String(s.title).slice(0, 120),
      description: String(s.description).slice(0, CONFIG.SUGGESTION_MAX_CHARS),
    }))
    .slice(0, 8);

  if (suggestions.length < 3) {
    supplementSuggestions(suggestions, cvStructure, keywordMatch, sections, atsScore);
  }

  const projectCount = (cvStructure.projects ?? []).length;
  const allSkills    = [
    ...cvStructure.skills.technical,
    ...cvStructure.skills.tools,
    ...cvStructure.skills.programmingLanguages,
  ];

  return {
    atsScore,
    keywordMatch,
    sections,
    suggestions,
    recruiterVerdict: (typeof scoringResult.recruiterVerdict === 'string' && scoringResult.recruiterVerdict.trim())
      ? scoringResult.recruiterVerdict.slice(0, CONFIG.VERDICT_MAX_CHARS)
      : 'Analysis complete. Review section scores and suggestions above.',
    hiringRecommendation: scoringResult.hiringRecommendation ?? 'maybe',
    cvInsights: {
      totalExperienceYears:      cvStructure.experience.reduce((s, j) => s + (j.yearsInRole ?? 0), 0).toFixed(1),
      projectCount,
      liveProjectCount:          (cvStructure.projects ?? []).filter(p => p.isLive).length,
      skillCount:                allSkills.length,
      hasQuantifiedAchievements: cvStructure.cvQuality.hasQuantifiedAchievements,
      hasPortfolioOrGithub:      cvStructure.cvQuality.hasPortfolioOrGithub,
      sectionsMissing:           cvStructure.cvQuality.sectionsMissing,
      formattingIssues:          cvStructure.cvQuality.formattingIssues,
      certificationCount:        cvStructure.certifications.length,
    },
    analysisMetadata: {
      requestId:  reqId,
      model:      CONFIG.MODEL,
      attempt,
      durationMs: Date.now() - startTime,
      fromCache:  false,
      cacheSize:  analysisCache.size,
    },
  };
}

// ─── Suggestion supplement (safety net if model returns < 3) ──────────────────
function supplementSuggestions(suggestions, cvStructure, keywordMatch, sections, atsScore) {
  const add = (priority, title, description) => {
    if (suggestions.length < 8) suggestions.push({ priority, title, description });
  };

  if (keywordMatch.missing.length > 0) {
    const top = keywordMatch.missing.slice(0, 4).join(', ');
    add('high', '🔑 Add Missing Keywords',
      `These required terms are absent from your CV: ${top}. Add them to your Skills section or weave them into relevant project/experience descriptions.`);
  }

  if (!cvStructure.cvQuality.hasQuantifiedAchievements) {
    add('high', '📊 Add Measurable Results',
      'None of your bullets include numbers. Add metrics where possible: "Reduced prep time by 70%", "Led a 4-person team", "Served X active users".');
  }

  if (!cvStructure.cvQuality.hasSummary) {
    add('high', '✍️ Add a Professional Summary',
      'A tailored 2–3 sentence summary at the top significantly improves ATS scores and gives recruiters a quick reason to keep reading.');
  }

  if (sections.experience.score < 55) {
    add('medium', '💼 Strengthen Experience Descriptions',
      'Rewrite responsibilities as achievements: Action verb + What you built + Result/Impact. Example: "Built responsive e-commerce platform → served 200+ local vendors".');
  }

  if (atsScore >= 75 && suggestions.length < 3) {
    add('low', '✨ Strong Match — Prepare for Interview',
      `Your CV scores ${atsScore}%. Tailor your cover letter to this specific role and prepare STAR-format answers for the key requirements.`);
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────
export async function analyseCV(cvText, jobDescription, requestId = null) {
  const reqId = requestId || crypto.randomUUID();

  if (!cvText?.trim())         throw new ValidationError('CV text is empty.');
  if (!jobDescription?.trim()) throw new ValidationError('Job description is empty.');
  if (cvText.length < CONFIG.CV_MIN_CHARS) throw new ValidationError(`CV too short (${cvText.length} chars).`);
  if (cvText.length > CONFIG.CV_MAX_CHARS) throw new ValidationError(`CV exceeds ${CONFIG.CV_MAX_CHARS.toLocaleString()} characters.`);

  const cleanCV = sanitiseText(cvText);
  const cleanJD = sanitiseText(jobDescription.slice(0, CONFIG.JD_MAX_CHARS));

  const cacheKey = getCacheKey(cleanCV, cleanJD);
  const cached   = analysisCache.get(cacheKey);
  if (cached) {
    console.log(`[${reqId}] ✅ Cache hit`);
    return { ...cached, analysisMetadata: { ...cached.analysisMetadata, fromCache: true } };
  }

  if (inFlightRequests.has(cacheKey)) {
    console.log(`[${reqId}] 🔗 Joining in-flight request`);
    return inFlightRequests.get(cacheKey);
  }

  if (circuitBreaker.isOpen()) {
    console.warn(`[${reqId}] ⛔ Circuit breaker OPEN`);
    return buildFallback(0, 'Service temporarily unavailable. Please try again in 30 seconds.');
  }

  const promise = _runAnalysis(cleanCV, cleanJD, cacheKey, reqId);
  inFlightRequests.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inFlightRequests.delete(cacheKey);
  }
}

// ─── Core analysis loop ────────────────────────────────────────────────────────
async function _runAnalysis(cvText, jobDescription, cacheKey, reqId) {
  const startTime = Date.now();

  const expandedKeywords = await expandJDKeywords(jobDescription, reqId);

  for (let attempt = 1; attempt <= CONFIG.MAX_ATTEMPTS; attempt++) {
    try {
      const cvStructure   = await extractCVStructure(cvText, reqId, attempt);
      const scoringResult = await scoreCVAgainstJD(cvStructure, jobDescription, expandedKeywords, reqId, attempt);
      const keywordMatch  = matchKeywords(cvStructure, scoringResult, expandedKeywords);
      const result        = assembleResult(cvStructure, scoringResult, keywordMatch, reqId, startTime, attempt);

      circuitBreaker.onSuccess();
      logAnalysisDetails(result, reqId);
      analysisCache.set(cacheKey, result);
      return result;

    } catch (err) {
      const label = err instanceof GroqServiceError ? err.code : 'UNKNOWN';
      console.error(`[${reqId}] Attempt ${attempt}/${CONFIG.MAX_ATTEMPTS} [${label}]: ${err.message}`);

      if (err instanceof GroqServiceError && !err.retryable) {
        circuitBreaker.onFailure();
        return buildFallback(Date.now() - startTime, err.message);
      }

      if (attempt === CONFIG.MAX_ATTEMPTS) {
        circuitBreaker.onFailure();
        return buildFallback(Date.now() - startTime);
      }

      const delay = 1000 * 2 ** (attempt - 1) + Math.random() * 300;
      console.log(`[${reqId}] Retrying in ${Math.round(delay)}ms…`);
      await sleep(delay);
    }
  }
}

// ─── Fallback result ───────────────────────────────────────────────────────────
function buildFallback(durationMs, customMessage = null) {
  const msg = customMessage ?? 'Analysis unavailable — AI service error. Please try again.';
  return {
    atsScore:     null,
    keywordMatch: { totalKeywords: 0, found: [], missing: [], matchPercentage: 0 },
    sections: {
      experience: { score: null, feedback: msg, confidence: 'low', strengths: [], gaps: [] },
      skills:     { score: null, feedback: msg, confidence: 'low', strengths: [], gaps: [] },
      education:  { score: null, feedback: msg, confidence: 'low', strengths: [], gaps: [] },
      summary:    { score: null, feedback: msg, confidence: 'low', strengths: [], gaps: [] },
    },
    suggestions:          [{ priority: 'high', title: 'Retry Analysis', description: 'The analysis service encountered an error. Please try again in a moment.' }],
    recruiterVerdict:     msg,
    hiringRecommendation: 'maybe',
    cvInsights:           null,
    analysisMetadata: {
      model: CONFIG.MODEL, attempt: CONFIG.MAX_ATTEMPTS, durationMs, fromCache: false, error: true,
    },
  };
}

// ─── Consistency test ─────────────────────────────────────────────────────────
export async function testConsistency(cvText, jobDescription, iterations = 5) {
  console.log(`\n🔬 Running ${iterations} iterations for consistency check…\n`);
  const scores   = [];
  const cleanCV  = sanitiseText(cvText);
  const cleanJD  = sanitiseText(jobDescription.slice(0, CONFIG.JD_MAX_CHARS));
  const cacheKey = getCacheKey(cleanCV, cleanJD);

  for (let i = 1; i <= iterations; i++) {
    analysisCache.delete(cacheKey);
    const result = await analyseCV(cvText, jobDescription);
    scores.push(result.atsScore ?? 0);
    console.log(`  Run ${String(i).padStart(2)}: ${result.atsScore}%`);
    if (i < iterations) await sleep(800);
  }

  const avg      = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((s, x) => s + (x - avg) ** 2, 0) / scores.length;
  const stdDev   = Math.sqrt(variance);
  const min      = Math.min(...scores);
  const max      = Math.max(...scores);
  const range    = max - min;
  const rating   = stdDev < 5 ? 'Excellent ✓' : stdDev < 10 ? 'Good ⚠' : 'Poor ✗';

  console.log('\n─────────────────────────────');
  console.log(`  Average : ${avg.toFixed(1)}%`);
  console.log(`  Std Dev : ${stdDev.toFixed(2)}%`);
  console.log(`  Range   : ${range}% (${min}–${max})`);
  console.log(`  Rating  : ${rating}`);
  console.log('─────────────────────────────\n');

  return { scores, avg, stdDev, min, max, range, rating };
}

// ─── Console breakdown logger ─────────────────────────────────────────────────
function logAnalysisDetails(result, reqId = '') {
  const prefix = reqId ? `[${reqId.slice(0, 8)}] ` : '';
  console.log(`\n${prefix}📊 ANALYSIS BREAKDOWN`);
  console.log('═'.repeat(60));

  const km = result.keywordMatch;
  console.log(`\n🔍 KEYWORD MATCH   (weight ${WEIGHTS.keywords * 100}%)`);
  console.log(`   Found   : ${km.found.length}/${km.totalKeywords} — ${km.matchPercentage}%`);
  if (km.found.length)   console.log(`   ✓  ${km.found.slice(0, 6).join(', ')}${km.found.length   > 6 ? ' …' : ''}`);
  if (km.missing.length) console.log(`   ✗  ${km.missing.slice(0, 6).join(', ')}${km.missing.length > 6 ? ' …' : ''}`);
  console.log(`   Contribution: ${Math.round(km.matchPercentage * WEIGHTS.keywords)}/40`);

  console.log(`\n📋 SECTION SCORES`);
  for (const [key, weight] of [['experience', WEIGHTS.experience], ['education', WEIGHTS.education], ['summary', WEIGHTS.summary]]) {
    const sec = result.sections[key];
    console.log(
      `   ${key.padEnd(10)} ${String(sec.score).padStart(3)}/100` +
      `  (weight ${weight * 100}%)  → ${Math.round(sec.score * weight)}/${weight * 100}` +
      `  [${sec.confidence}]`,
    );
  }

  console.log(`\n✨ FINAL ATS SCORE : ${result.atsScore}/100`);
  console.log(`   Recommendation  : ${result.hiringRecommendation}`);
  if (result.cvInsights) {
    console.log(`   Experience Yrs  : ${result.cvInsights.totalExperienceYears}`);
    console.log(`   Projects        : ${result.cvInsights.projectCount} (${result.cvInsights.liveProjectCount} live)`);
    console.log(`   Skills Listed   : ${result.cvInsights.skillCount}`);
    if (result.cvInsights.sectionsMissing?.length)  console.log(`   Missing Sections: ${result.cvInsights.sectionsMissing.join(', ')}`);
    if (result.cvInsights.formattingIssues?.length) console.log(`   Format Issues   : ${result.cvInsights.formattingIssues.join(', ')}`);
  }
  console.log('═'.repeat(60) + '\n');
}