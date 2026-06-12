function log(tag, msg) {
    console.log(`[continuation-suggester:${tag}] ${msg}`);
}

export async function detectResearchGaps(payload = {}) {
    const topic = clean(payload.topic);
    const selectedPapers = normalizePapers(payload.papers || []).slice(0, 20);

    log('detectResearchGaps', `topic="${topic}" | selectedPapers=${selectedPapers.length} | apiReady=${isApiReady()}`);

    if (!topic) {
        throw new Error('Topic is required for continuation suggestions.');
    }

    if (selectedPapers.length < 1) {
        throw new Error('At least 1 selected paper is required for continuation suggestions.');
    }

    log('detectResearchGaps', 'step 1/2 → extractPaperEvidence');
    const paperAnalyses = await extractPaperEvidence(topic, selectedPapers);
    log('detectResearchGaps', `paper analyses: ${paperAnalyses.length}`);

    log('detectResearchGaps', 'step 2/2 → suggestContinuations');
    const continuations = await suggestContinuations(topic, paperAnalyses, selectedPapers);
    const rankedGaps = continuations.map(continuationToGapShape);
    log('detectResearchGaps', `done | continuations=${rankedGaps.length}`);

    return {
        mode: isApiReady() ? 'api' : 'local-fallback',
        provider: process.env.LLM_API_URL || 'local-fallback',
        topic,
        paperCount: selectedPapers.length,
        paperAnalyses,
        explorationChecks: [],
        rankedGaps,
        runMessage: `Analyzed ${selectedPapers.length} selected paper(s) and produced ${rankedGaps.length} continuation suggestion(s).`
    };
}

async function extractPaperEvidence(topic, papers) {
    if (!papers.length) return [];

    if (!isApiReady()) {
        log('extractPaperEvidence', 'API not ready → using fallback evidence');
        return fallbackPaperEvidence(topic, papers);
    }

    const prompt = {
        topic,
        papers: papers.map((paper) => ({
            paperKey: paperStableId(paper),
            title: paper.title,
            abstract: truncate(paper.abstract, 2200),
            venue: paper.venue,
            year: paper.year
        })),
        outputContract: {
            paperAnalyses: [
                {
                    paperKey: 'same paperKey',
                    title: 'paper title',
                    mainProblem: 'main research problem from title+abstract',
                    method: 'method used',
                    datasetDomain: 'dataset/domain/population',
                    evaluationMetrics: 'metrics reported',
                    limitations: 'explicit limitations stated by the authors',
                    futureWork: 'future work explicitly stated by the authors',
                    extractionConfidence: 0
                }
            ]
        }
    };

    try {
        log('extractPaperEvidence', `calling LLM to extract evidence from ${papers.length} papers`);
        const result = await callLlmJson(
            'Extract structured evidence from title and abstract only. Focus on explicit author statements about limitations and future work. Do not infer claims not supported by metadata. Return strict JSON.',
            prompt
        );

        const rows = Array.isArray(result.paperAnalyses) ? result.paperAnalyses : [];
        const parsed = rows
            .map((row) => ({
                paperKey: clean(row.paperKey),
                title: clean(row.title),
                mainProblem: clean(row.mainProblem),
                method: clean(row.method),
                datasetDomain: clean(row.datasetDomain),
                evaluationMetrics: clean(row.evaluationMetrics),
                limitations: clean(row.limitations),
                futureWork: clean(row.futureWork),
                extractionConfidence: clampNumber(row.extractionConfidence, 0, 100, 65)
            }))
            .filter((row) => row.paperKey || row.title);

        return parsed.length ? parsed : fallbackPaperEvidence(topic, papers);
    } catch {
        return fallbackPaperEvidence(topic, papers);
    }
}

async function suggestContinuations(topic, paperAnalyses, selectedPapers) {
    if (!paperAnalyses.length) return fallbackContinuations(topic, selectedPapers);

    if (!isApiReady()) {
        log('suggestContinuations', 'API not ready → using fallback continuations');
        return fallbackContinuations(topic, selectedPapers);
    }

    const prompt = {
        topic,
        paperAnalyses: paperAnalyses.map((pa) => ({
            paperKey: pa.paperKey,
            title: pa.title,
            limitations: pa.limitations,
            futureWork: pa.futureWork,
            method: pa.method,
            datasetDomain: pa.datasetDomain,
            evaluationMetrics: pa.evaluationMetrics
        })),
        instructions: [
            'Generate continuation suggestions based ONLY on what these specific papers say.',
            'Look for: explicit author limitations, stated future work, narrow dataset/domain, weak evaluation, method gaps, missing applications.',
            'Do NOT claim these are globally novel. Use language like "the authors noted" or "this paper left open".',
            'Each suggestion must be traceable to evidence in the provided papers.',
            'Generate 3 to 6 suggestions across different types.'
        ],
        outputContract: {
            suggestions: [
                {
                    id: 'short-kebab-id',
                    title: 'Concise continuation title (under 12 words)',
                    type: 'limitation | future_work | weakness | extension | application | evaluation',
                    description: 'Specific continuation direction. Start with "The authors noted..." or "This paper left open..."',
                    basedOnPapers: ['paper title'],
                    possibleResearchQuestion: 'One concrete research question this continuation could answer',
                    possibleMethod: 'Brief method sketch (1-2 sentences)',
                    feasibility: 75
                }
            ]
        }
    };

    try {
        log('suggestContinuations', `calling LLM with ${paperAnalyses.length} paper analyses`);
        const result = await callLlmJson(
            'Generate paper-based continuation suggestions from author-stated limitations and future work. Do not claim global novelty. Return strict JSON.',
            prompt
        );

        const rows = Array.isArray(result.suggestions) ? result.suggestions : [];
        const parsed = rows
            .map((row, index) => normalizeContinuationRow(row, index))
            .filter((row) => row.title && row.description);

        return parsed.length ? parsed : fallbackContinuations(topic, selectedPapers);
    } catch {
        return fallbackContinuations(topic, selectedPapers);
    }
}

function normalizeContinuationRow(row, index) {
    const validTypes = new Set(['limitation', 'future_work', 'weakness', 'extension', 'application', 'evaluation']);
    const type = validTypes.has(clean(row.type)) ? clean(row.type) : 'limitation';
    return {
        id: clean(row.id) || `cont-${index + 1}`,
        title: clean(row.title),
        type,
        description: clean(row.description),
        basedOnPapers: Array.isArray(row.basedOnPapers) ? row.basedOnPapers.map(clean).filter(Boolean) : [],
        possibleResearchQuestion: clean(row.possibleResearchQuestion),
        possibleMethod: clean(row.possibleMethod),
        feasibility: clampNumber(row.feasibility, 0, 100, 65)
    };
}

function continuationToGapShape(c) {
    return {
        id: c.id,
        category: c.type,
        title: c.title,
        description: c.description,
        rationale: 'Possible continuation based on selected papers.',
        researchQuestion: c.possibleResearchQuestion,
        overallScore: c.feasibility,
        confidenceLabel: 'based on selected papers',
        confidenceScore: c.feasibility,
        novelty: c.feasibility,
        feasibility: c.feasibility,
        availableData: 70,
        relevance: 80,
        proposalPotential: c.feasibility,
        type: c.type,
        basedOnPapers: c.basedOnPapers,
        possibleResearchQuestion: c.possibleResearchQuestion,
        possibleMethod: c.possibleMethod,
        supportingPaperKeys: c.basedOnPapers,
        evidenceReasoning: c.description
    };
}

function fallbackContinuations(topic, papers) {
    const paperTitles = papers.slice(0, 4).map((p) => p.title).filter(Boolean);

    return [
        {
            id: 'cont-limitation-1',
            title: `Address author-stated limitations in ${topic}`,
            type: 'limitation',
            description: 'The selected papers report scope limitations — narrow datasets, specific domains, or constrained evaluation conditions — that a follow-up study could directly address.',
            basedOnPapers: paperTitles,
            possibleResearchQuestion: `How can the limitations noted by the authors of the selected studies on ${topic} be addressed in a more comprehensive evaluation?`,
            possibleMethod: 'Design an extended study that directly addresses the dataset, domain, or evaluation limitations identified by the authors.',
            feasibility: 72
        },
        {
            id: 'cont-future-work-1',
            title: `Pursue author-suggested future work in ${topic}`,
            type: 'future_work',
            description: 'The selected papers suggest future directions the authors did not pursue, including stronger baselines, broader datasets, or practical deployment studies.',
            basedOnPapers: paperTitles,
            possibleResearchQuestion: `Which future directions explicitly stated in the selected papers on ${topic} are most tractable and impactful?`,
            possibleMethod: 'Implement and evaluate one or more future directions explicitly mentioned by the authors in the selected papers.',
            feasibility: 77
        },
        {
            id: 'cont-evaluation-1',
            title: `Strengthen evaluation beyond benchmark conditions`,
            type: 'evaluation',
            description: 'Evaluation in the selected papers relies on controlled benchmarks; real-world conditions, user studies, or robustness checks are largely absent.',
            basedOnPapers: paperTitles,
            possibleResearchQuestion: `How does the performance reported in the selected ${topic} papers hold up under real-world, noisy, or out-of-distribution conditions?`,
            possibleMethod: 'Conduct robustness evaluation, user study, or deployment pilot on the methods described in the selected papers.',
            feasibility: 74
        },
        {
            id: 'cont-extension-1',
            title: `Extend methods to underexplored domains or populations`,
            type: 'extension',
            description: 'The methods in the selected papers are validated in limited domains; extending them to related settings could reveal generalization strengths and gaps.',
            basedOnPapers: paperTitles,
            possibleResearchQuestion: `How do the methods from the selected ${topic} papers generalize to different domains, populations, or data types not tested by the authors?`,
            possibleMethod: 'Apply the methods from the selected papers to one or more new domains and analyze where they succeed and fail.',
            feasibility: 68
        }
    ];
}

function fallbackPaperEvidence(topic, papers) {
    return papers.map((paper) => ({
        paperKey: paperStableId(paper),
        title: paper.title,
        mainProblem: truncate(clean(paper.summary) || clean(paper.abstract) || `Problem related to ${topic}.`, 170),
        method: inferMethod(paper),
        datasetDomain: inferDatasetDomain(paper, topic),
        evaluationMetrics: inferMetrics(paper),
        limitations: inferLimitations(paper),
        futureWork: inferFutureWork(paper),
        extractionConfidence: 55
    }));
}

function inferMethod(paper) {
    const text = `${clean(paper.summary)} ${clean(paper.abstract)}`.toLowerCase();
    if (/benchmark|compare|ablation/.test(text)) return 'Comparative benchmark method';
    if (/dataset|corpus/.test(text)) return 'Dataset-focused method';
    if (/transformer|neural|model/.test(text)) return 'Model-centric method';
    return 'Method not explicit in metadata.';
}

function inferDatasetDomain(paper, topic) {
    const text = `${clean(paper.summary)} ${clean(paper.abstract)} ${clean(paper.venue)}`.toLowerCase();
    if (/music|audio/.test(text)) return 'Music/audio domain';
    if (/language|text|nlp/.test(text)) return 'Language/text domain';
    if (/vision|image/.test(text)) return 'Vision domain';
    return `Domain associated with ${topic}`;
}

function inferMetrics(paper) {
    const text = `${clean(paper.summary)} ${clean(paper.abstract)}`.toLowerCase();
    const metrics = [];
    if (/f1|precision|recall/.test(text)) metrics.push('F1/Precision/Recall');
    if (/accuracy/.test(text)) metrics.push('Accuracy');
    if (/auc|roc/.test(text)) metrics.push('AUC/ROC');
    if (/bleu|rouge/.test(text)) metrics.push('BLEU/ROUGE');
    return metrics.length ? metrics.join(', ') : 'Metrics not explicit in metadata.';
}

function inferLimitations(paper) {
    const text = `${clean(paper.summary)} ${clean(paper.abstract)}`;
    if (!text) return 'No explicit limitation found in metadata.';
    return 'Likely limitations inferred from abstract: limited scope, benchmark dependency, or weak external validation.';
}

function inferFutureWork(paper) {
    const text = `${clean(paper.summary)} ${clean(paper.abstract)}`;
    if (!text) return 'Future work not explicit in metadata.';
    return 'Potential future work includes stronger generalization tests, richer datasets, and practical deployment evaluation.';
}

async function callLlmJson(systemPrompt, payload) {
    const model = clean(process.env.LLM_MODEL);
    if (!model) {
        throw new Error('LLM_MODEL is required for continuation suggestions.');
    }

    log('callLlmJson', `→ LLM request | model=${model} | provider=${provider()}`);
    const t0 = Date.now();

    if (provider() === 'gemini') {
        const baseUrl = clean(process.env.LLM_API_URL) || 'https://generativelanguage.googleapis.com/v1beta';
        const endpoint = `${baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(model)}:generateContent`;
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': process.env.LLM_API_KEY
            },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: systemPrompt }] },
                contents: [{ role: 'user', parts: [{ text: JSON.stringify(payload, null, 2) }] }],
                generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
            })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data?.error?.message || `Gemini API returned ${response.status}`);
        const content = data?.candidates?.[0]?.content?.parts?.map((part) => part.text).filter(Boolean).join('\n');
        const parsed = parseJsonContent(content);
        log('callLlmJson', `← LLM response | ${Date.now() - t0}ms`);
        return parsed;
    }

    const makeRequest = async (modelId) => {
        const response = await fetch(process.env.LLM_API_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.LLM_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: modelId,
                temperature: 0.2,
                max_tokens: 4096,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: JSON.stringify(payload, null, 2) }
                ]
            })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error?.message || `API returned ${response.status}`);
        return typeof data?.choices?.[0]?.message?.content === 'string'
            ? data.choices[0].message.content
            : JSON.stringify(data);
    };

    let content;
    try {
        content = await makeRequest(model);
    } catch (error) {
        const fallbackModel = clean(process.env.LLM_FALLBACK_MODEL) || 'meta-llama/llama-3.1-8b-instruct:free';
        if (/requires more credits|can only afford|insufficient credits|balance|quota/i.test(error.message) && fallbackModel !== model) {
            log('callLlmJson', `credit limit hit for ${model} → retrying with fallback ${fallbackModel}`);
            content = await makeRequest(fallbackModel);
        } else {
            throw error;
        }
    }

    const parsed = parseJsonContent(content);
    log('callLlmJson', `← LLM response | ${Date.now() - t0}ms`);
    return parsed;
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

    return {};
}

function normalizePapers(papers) {
    return Array.isArray(papers)
        ? papers
            .map((paper) => ({
                paperId: clean(paper.paperId),
                doi: clean(paper.doi),
                title: clean(paper.title),
                abstract: truncate(clean(paper.abstract), 2800),
                summary: truncate(clean(paper.summary), 1400),
                venue: clean(paper.venue),
                year: paper.year || '',
                source: clean(paper.source),
                authors: Array.isArray(paper.authors) ? paper.authors.map(clean).filter(Boolean).slice(0, 12) : [],
                queryHits: Array.isArray(paper.queryHits) ? paper.queryHits.map(clean).filter(Boolean) : [],
                relevanceScore: Number(paper.relevanceScore || 0),
                citationCount: Number(paper.citationCount || 0)
            }))
            .filter((paper) => paper.title)
        : [];
}

function paperStableId(paper) {
    if (paper?.paperId) return `pid:${paper.paperId}`;
    if (paper?.doi) return `doi:${paper.doi}`;
    return `title:${clean(paper?.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
}

function truncate(value, max) {
    const text = clean(value);
    if (text.length <= max) return text;
    return `${text.slice(0, max - 1).trimEnd()}...`;
}

function clampNumber(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(min, Math.min(max, Math.round(numeric)));
}

function provider() {
    return clean(process.env.LLM_PROVIDER).toLowerCase() === 'gemini' ? 'gemini' : 'openai-compatible';
}

function isApiReady() {
    return Boolean(clean(process.env.LLM_API_KEY) && clean(process.env.LLM_API_URL));
}

function clean(value) {
    return String(value || '').trim();
}
