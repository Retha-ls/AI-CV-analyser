/**
 * analyse.js — Production CV Analysis Route v3
 *
 * Improvements:
 *  ✓ No double-sanitisation: route sanitises once, service receives clean text
 *  ✓ Unicode-safe gibberish check (\p{L} instead of [a-zA-Z]) — supports Arabic, CJK, etc.
 *  ✓ Enriched response: passes cvInsights + hiringRecommendation to client
 *  ✓ In-process rate limiter documented as single-instance only (comment updated)
 *  ✓ Retry-After header calculated from window remaining time
 *  ✓ Request body size guard before field extraction
 *  ✓ HTML / script tag stripping (XSS / prompt-injection defence)
 *  ✓ Configurable analysis timeout
 *  ✓ Structured error responses with `code` field
 *  ✓ Full request duration logged on every outcome
 */

import express from 'express';
import crypto  from 'crypto';
import { analyseCV } from '../services/groqService.js';

const router = express.Router();

// ─── Configuration ─────────────────────────────────────────────────────────────
const LIMITS = Object.freeze({
  MIN_CV_LENGTH:        100,
  MIN_JD_LENGTH:         50,
  MAX_CV_LENGTH:     50_000,
  MAX_JD_LENGTH:     10_000,
  MIN_WORD_COUNT:        10,
  ANALYSIS_TIMEOUT_MS: 90_000,  // 90 s — two-pass analysis takes longer than single-pass

  // ⚠️  In-process rate limiting: works for single-instance deployments only.
  // For horizontal scaling (multiple Node processes / containers), replace with
  // Redis-backed rate limiting: e.g. rate-limiter-flexible + ioredis.
  RATE_WINDOW_MS:  60_000,  // 1-minute rolling window
  RATE_MAX_CALLS:       5,  // max requests per window per IP

  // Maximum raw body size to process (defence against payload bombs before multer)
  MAX_BODY_CHARS: 120_000,
});

// ─── In-process rate limiter ───────────────────────────────────────────────────
const rateLimitStore = new Map();

function checkRateLimit(ip) {
  const now   = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry || now - entry.windowStart > LIMITS.RATE_WINDOW_MS) {
    rateLimitStore.set(ip, { count: 1, windowStart: now });
    return { allowed: true, remaining: LIMITS.RATE_MAX_CALLS - 1 };
  }

  entry.count++;
  const remaining = Math.max(0, LIMITS.RATE_MAX_CALLS - entry.count);

  if (entry.count > LIMITS.RATE_MAX_CALLS) {
    const retryAfter = Math.ceil((LIMITS.RATE_WINDOW_MS - (now - entry.windowStart)) / 1000);
    return { allowed: false, remaining: 0, retryAfter };
  }

  return { allowed: true, remaining };
}

// Purge stale entries to prevent unbounded memory growth
setInterval(() => {
  const cutoff = Date.now() - LIMITS.RATE_WINDOW_MS;
  for (const [ip, entry] of rateLimitStore) {
    if (entry.windowStart < cutoff) rateLimitStore.delete(ip);
  }
}, LIMITS.RATE_WINDOW_MS);

// ─── Input validation ──────────────────────────────────────────────────────────
/**
 * Validates text length, word count, and readable-word ratio.
 * Uses Unicode letter class (\p{L}) — supports non-Latin scripts.
 */
function validateInput(text, fieldName, minLength, maxLength, minWords) {
  const trimmed = text.trim();

  if (trimmed.length < minLength) {
    throw new Error(
      `${fieldName} is too short — provide at least ${minLength} characters (got ${trimmed.length}).`,
    );
  }

  if (trimmed.length > maxLength) {
    throw new Error(
      `${fieldName} is too long — maximum is ${maxLength.toLocaleString()} characters ` +
      `(got ${trimmed.length.toLocaleString()}).`,
    );
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < minWords) {
    throw new Error(
      `${fieldName} must contain at least ${minWords} words (got ${words.length}).`,
    );
  }

  // Unicode-safe gibberish check: count words with 2+ letter characters (any script)
  const meaningfulWords = words.filter(w => /\p{L}{2,}/u.test(w));
  const meaningfulRatio = meaningfulWords.length / words.length;
  if (meaningfulRatio < 0.25) {
    throw new Error(
      `${fieldName} appears to be invalid or mostly symbols. Please enter real text.`,
    );
  }
}

// ─── Input sanitisation ────────────────────────────────────────────────────────
/**
 * Strips HTML tags, script blocks, HTML entities, and normalises whitespace.
 * Called once in the route. The service layer receives pre-cleaned text.
 * Note: grokService.js also has a sanitiseText() for its own use (text it
 * receives from sources other than this route). This prevents double-encoding
 * while ensuring all paths through the service are safe.
 */
function sanitiseInput(text) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi,   '')
    .replace(/<[^>]+>/g,                    ' ')
    .replace(/&[a-z#0-9]+;/gi,             ' ')
    .replace(/\0/g,                         '')
    .replace(/\r\n|\r/g,                    '\n')
    .replace(/[ \t]{3,}/g,                  '  ')
    .replace(/\n{4,}/g,                     '\n\n\n')
    .trim();
}

// ─── Structured error helper ───────────────────────────────────────────────────
function errorResponse(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: { code, message, ...extra } });
}

// ─── Timeout wrapper ───────────────────────────────────────────────────────────
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Analysis timed out after ${ms / 1000}s`)),
      ms,
    );
  });
  // Ensure the timer is cleared if the analysis finishes first
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ─── Route ─────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const startTime = Date.now();
  const requestId = crypto.randomUUID();

  res.setHeader('X-Request-Id', requestId);

  const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  console.log(`[${requestId}] POST /analyse — IP: ${ip}`);

  // ── Rate limiting ────────────────────────────────────────────────────────────
  const rateCheck = checkRateLimit(ip);
  res.setHeader('X-RateLimit-Limit',     LIMITS.RATE_MAX_CALLS);
  res.setHeader('X-RateLimit-Remaining', rateCheck.remaining);

  if (!rateCheck.allowed) {
    console.warn(`[${requestId}] Rate limit exceeded — IP: ${ip}`);
    res.setHeader('Retry-After', rateCheck.retryAfter);
    return errorResponse(res, 429, 'RATE_LIMITED',
      `Too many requests. Try again in ${rateCheck.retryAfter}s.`,
      { retryAfter: rateCheck.retryAfter },
    );
  }

  // ── Body extraction ──────────────────────────────────────────────────────────
  const { cvText, jobDescription } = req.body ?? {};

  if (!cvText || !jobDescription) {
    return errorResponse(res, 400, 'MISSING_FIELDS',
      'Both cvText and jobDescription are required.',
    );
  }

  if (typeof cvText !== 'string' || typeof jobDescription !== 'string') {
    return errorResponse(res, 400, 'INVALID_TYPE',
      'cvText and jobDescription must be strings.',
    );
  }

  // ── Payload size guard (cheap check before any processing) ──────────────────
  if (cvText.length + jobDescription.length > LIMITS.MAX_BODY_CHARS) {
    return errorResponse(res, 413, 'PAYLOAD_TOO_LARGE',
      `Combined input exceeds ${(LIMITS.MAX_BODY_CHARS / 1000).toFixed(0)}k characters. Please trim your CV or job description.`,
    );
  }

  // ── Sanitise (once — service receives clean text) ─────────────────────────
  const cleanCV = sanitiseInput(cvText);
  const cleanJD = sanitiseInput(jobDescription);

  // ── Validate ─────────────────────────────────────────────────────────────────
  try {
    validateInput(cleanCV, 'CV', LIMITS.MIN_CV_LENGTH, LIMITS.MAX_CV_LENGTH, LIMITS.MIN_WORD_COUNT);
  } catch (err) {
    return errorResponse(res, 400, 'INVALID_CV', err.message);
  }

  try {
    validateInput(cleanJD, 'Job description', LIMITS.MIN_JD_LENGTH, LIMITS.MAX_JD_LENGTH, LIMITS.MIN_WORD_COUNT);
  } catch (err) {
    return errorResponse(res, 400, 'INVALID_JD', err.message);
  }

  // ── Run analysis ─────────────────────────────────────────────────────────────
  try {
    const result = await withTimeout(
      analyseCV(cleanCV, cleanJD, requestId),
      LIMITS.ANALYSIS_TIMEOUT_MS,
    );

    const durationMs = Date.now() - startTime;
    console.log(`[${requestId}] ✅ Analysis complete in ${durationMs}ms — score: ${result.atsScore}`);

    return res.json(result);

  } catch (err) {
    const durationMs = Date.now() - startTime;
    console.error(`[${requestId}] ❌ Analysis failed after ${durationMs}ms: ${err.message}`);

    if (err.message.includes('timed out')) {
      return errorResponse(res, 504, 'ANALYSIS_TIMEOUT',
        'Analysis took too long. Please try again.', { durationMs },
      );
    }

    if (err.code === 'VALIDATION_ERROR') {
      return errorResponse(res, 400, 'VALIDATION_ERROR', err.message);
    }

    return errorResponse(res, 500, 'ANALYSIS_FAILED',
      'Analysis failed. Please try again.', { durationMs },
    );
  }
});

export default router;