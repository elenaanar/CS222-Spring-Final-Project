function log(tag, msg) {
  console.log(`[citations:${tag}] ${msg}`);
}

const SYSTEM_PROMPT = `You are an academic citation reviewer. Analyze a research proposal and classify every claim that needs a citation.

You receive:
- proposalLatex: the full LaTeX source
- citationBank: user-verified evidence entries, each with an id, citationKey, title, evidenceType, evidenceText, and supports array

For each important factual claim, classify it as one of:
- "supported"            — evidence in the citationBank directly backs this claim
- "needs_citation"       — a prior-work/empirical claim with no \\cite{} present nearby
- "unsupported"          — strong factual assertion, no supporting evidence in the bank at all
- "assumption"           — a reasonable assumption stated without evidence (acceptable)
- "hypothesis"           — a stated hypothesis of the proposed work (no citation needed)
- "proposed_contribution"— what this work will contribute (no citation needed)

Watch especially for phrases like "prior work shows", "studies have shown", "research demonstrates",
"it is well known", "existing literature indicates", "has been proven", "widely established" —
these are almost always "needs_citation" if no \\cite{...} appears nearby.

For "supported" claims, list the matching evidence IDs from citationBank.
For "needs_citation" / "unsupported", provide a suggestedRewrite rephrasing as assumption/hypothesis.

Return strict JSON (no markdown fences):
{
  "coverageScore": <0–100 integer>,
  "findings": [
    {
      "claim": "<exact short quote ≤150 chars from the proposal>",
      "classification": "supported|needs_citation|unsupported|assumption|hypothesis|proposed_contribution",
      "supportingEvidenceIds": ["<id>"],
      "explanation": "<one sentence>",
      "suggestedRewrite": "<only for needs_citation/unsupported>"
    }
  ]
}

Focus on the 12 most important findings. Prioritise flagging needs_citation/unsupported first.`;

function isApiReady() {
  return Boolean(process.env.LLM_API_KEY && process.env.LLM_API_URL);
}

function provider() {
  const url = (process.env.LLM_API_URL || '').toLowerCase();
  return url.includes('generativelanguage.googleapis.com') ? 'gemini' : 'openai';
}

function clean(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function parseJsonContent(content) {
  const text = clean(content);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try { return JSON.parse(fenced[1]); } catch { /* fall through */ }
  }
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
  }
  throw new Error('Could not parse LLM response as JSON');
}

async function callLlmJson(systemPrompt, payload) {
  const model = clean(process.env.LLM_MODEL);
  if (!model) throw new Error('LLM_MODEL is required for citation review.');

  log('callLlmJson', `→ LLM | model=${model} | provider=${provider()}`);
  const t0 = Date.now();

  if (provider() === 'gemini') {
    const baseUrl = (clean(process.env.LLM_API_URL) || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    const endpoint = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.LLM_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(payload, null, 2) }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || `Gemini API ${response.status}`);
    const content = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n');
    const parsed = parseJsonContent(content);
    log('callLlmJson', `← LLM | ${Date.now() - t0}ms`);
    return parsed;
  }

  const makeRequest = async (modelId) => {
    const response = await fetch(process.env.LLM_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.LLM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        temperature: 0.1,
        max_tokens: 3000,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(payload, null, 2) }
        ]
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || `API ${response.status}`);
    return typeof data?.choices?.[0]?.message?.content === 'string'
      ? data.choices[0].message.content
      : JSON.stringify(data);
  };

  let content;
  try {
    content = await makeRequest(model);
  } catch (error) {
    const fallback = clean(process.env.LLM_FALLBACK_MODEL) || 'meta-llama/llama-3.1-8b-instruct:free';
    if (/credits|balance|quota/i.test(error.message) && fallback !== model) {
      log('callLlmJson', `credit limit → retrying with ${fallback}`);
      content = await makeRequest(fallback);
    } else {
      throw error;
    }
  }

  const parsed = parseJsonContent(content);
  log('callLlmJson', `← LLM | ${Date.now() - t0}ms`);
  return parsed;
}

function localFallback(proposalLatex, citationBank) {
  const patterns = [
    /prior work (?:shows?|has shown|demonstrates?|suggest)/gi,
    /studies have shown/gi,
    /research demonstrates?/gi,
    /it is well[- ]known/gi,
    /existing literature (?:shows?|suggests?|indicates?)/gi,
    /has been (?:proven|shown|demonstrated)/gi,
    /widely (?:accepted|established|recognized)/gi,
    /many researchers? have/gi
  ];

  const sentences = proposalLatex
    .replace(/\\[a-zA-Z]+(\{[^}]*\})?/g, ' ')
    .replace(/[{}%$]/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 30 && s.length < 300);

  const findings = [];
  const seenClaims = new Set();

  for (const sentence of sentences) {
    for (const pat of patterns) {
      pat.lastIndex = 0;
      if (pat.test(sentence)) {
        const claim = sentence.slice(0, 150);
        if (!seenClaims.has(claim)) {
          seenClaims.add(claim);
          findings.push({
            claim,
            classification: 'needs_citation',
            supportingEvidenceIds: [],
            explanation: 'Claim about prior work without a citation.',
            suggestedRewrite: 'Rephrase as: "We hypothesize that..." or "This work assumes that..."'
          });
        }
        break;
      }
    }
    if (findings.length >= 8) break;
  }

  for (const entry of (citationBank || []).slice(0, 4)) {
    findings.push({
      claim: entry.evidenceText.slice(0, 150),
      classification: 'supported',
      supportingEvidenceIds: [entry.id],
      explanation: `Supported by: ${entry.title}`,
      suggestedRewrite: undefined
    });
  }

  const total = findings.length;
  const supported = findings.filter(f => f.classification === 'supported').length;
  const score = total > 0 ? Math.round((supported / total) * 100) : 0;
  return { coverageScore: score, findings };
}

export async function reviewCitations({ proposalLatex, citationBank }) {
  log('reviewCitations', `latex=${proposalLatex?.length ?? 0} chars | bank=${(citationBank || []).length} entries | api=${isApiReady()}`);

  if (!isApiReady()) {
    log('reviewCitations', 'API not ready → local fallback');
    return { ...localFallback(proposalLatex, citationBank), mode: 'local-fallback' };
  }

  const bankSummary = (citationBank || []).map(e => ({
    id: e.id,
    citationKey: e.citationKey || '',
    title: e.title,
    evidenceType: e.evidenceType,
    evidenceText: e.evidenceText,
    supports: e.supports || []
  }));

  const latexSnippet = (proposalLatex || '').length > 7000
    ? proposalLatex.slice(0, 7000) + '\n...[truncated]'
    : proposalLatex;

  const result = await callLlmJson(SYSTEM_PROMPT, {
    task: 'citation-review',
    proposalLatex: latexSnippet,
    citationBank: bankSummary
  });

  log('reviewCitations', `done | score=${result.coverageScore} | findings=${result.findings?.length ?? 0}`);
  return {
    coverageScore: Number(result.coverageScore) || 0,
    findings: Array.isArray(result.findings) ? result.findings : [],
    mode: 'api'
  };
}
