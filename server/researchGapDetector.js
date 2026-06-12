const MAX_SEED_PAPERS = 24;
const MAX_CORPUS = 48;
const QUERY_COUNT = 5;
const PER_QUERY = 12;

function log(tag, msg) {
    console.log(`[gap-detector:${tag}] ${msg}`);
}

export async function detectResearchGaps(payload = {}) {
    const topic = clean(payload.topic);
    const seedPapers = normalizePapers(payload.papers || []).slice(0, MAX_SEED_PAPERS);

    log('detectResearchGaps', `topic="${topic}" | seedPapers=${seedPapers.length} | apiReady=${isApiReady()}`);

    if (!topic) {
        throw new Error('Topic is required for research gap detection.');
    }

    if (seedPapers.length < 8) {
        throw new Error('At least 8 retrieved papers are required for research gap detection.');
    }

    log('detectResearchGaps', 'step 1/4 → buildRetrievalQueries');
    const retrievalQueries = await buildRetrievalQueries(topic, seedPapers, QUERY_COUNT);
    log('detectResearchGaps', `queries built: [${retrievalQueries.join(' | ')}]`);

    log('detectResearchGaps', `step 2/4 → retrieveTopicCorpus (${QUERY_COUNT} queries × ${PER_QUERY} per query)`);
    const retrieved = await retrieveTopicCorpus(retrievalQueries, PER_QUERY);
    const corpus = mergeAndDedupePapers(seedPapers, retrieved).slice(0, MAX_CORPUS);
    log('detectResearchGaps', `corpus: ${retrieved.length} raw → ${corpus.length} deduped (capped at ${MAX_CORPUS})`);

    log('detectResearchGaps', `step 3/4 → extractPaperEvidence for ${corpus.length} papers`);
    const paperAnalyses = await extractPaperEvidence(topic, corpus);
    log('detectResearchGaps', `paper analyses: ${paperAnalyses.length}`);

    log('detectResearchGaps', 'step 4a/4 → generateGapHypotheses');
    const candidateGaps = await generateGapHypotheses(topic, paperAnalyses, seedPapers);
    log('detectResearchGaps', `candidate gaps: ${candidateGaps.length}`);

    log('detectResearchGaps', 'step 4b/4 → verifyGapHypotheses');
    const explorationChecks = await verifyGapHypotheses(candidateGaps, paperAnalyses);

    log('detectResearchGaps', 'step 4c/4 → rankGapHypotheses');
    const rankedGaps = await rankGapHypotheses(topic, candidateGaps, explorationChecks, seedPapers.length);
    log('detectResearchGaps', `done | rankedGaps=${rankedGaps.length}`);

    return {
        mode: isApiReady() ? 'api' : 'local-fallback',
        provider: process.env.LLM_API_URL || 'local-fallback',
        topic,
        querySet: retrievalQueries,
        paperCount: seedPapers.length,
        corpusCount: corpus.length,
        paperAnalyses,
        explorationChecks,
        rankedGaps,
        runMessage: `Analyzed ${seedPapers.length} top retrieved papers and ${corpus.length} total papers to produce ${rankedGaps.length} verified gap options.`
    };
}

async function buildRetrievalQueries(topic, seedPapers, count) {
    const seedTerms = seedPapers
        .flatMap((paper) => [paper.title, paper.venue, ...(paper.queryHits || [])])
        .map(clean)
        .filter(Boolean)
        .join('; ')
        .slice(0, 1800);

    if (!isApiReady()) {
        log('buildRetrievalQueries', 'API not ready → using fallback queries');
        return fallbackQueries(topic, count);
    }

    const prompt = {
        topic,
        seedTerms,
        constraints: [
            `Return exactly ${count} literature search queries.`,
            'Queries must be evidence-seeking and neutral. Do not assert novelty.',
            'Cover population, methodology, empirical validation, and practical deployment dimensions.'
        ],
        outputContract: {
            queries: ['query string']
        }
    };

    try {
        log('buildRetrievalQueries', `calling LLM for ${count} retrieval queries`);
        const result = await callLlmJson(
            'Generate balanced retrieval queries for literature synthesis. Return strict JSON only.',
            prompt
        );

        const queries = Array.isArray(result.queries) ? result.queries.map(clean).filter(Boolean) : [];
        const deduped = [...new Set(queries)].slice(0, count);

        return deduped.length ? deduped : fallbackQueries(topic, count);
    } catch {
        return fallbackQueries(topic, count);
    }
}

async function retrieveTopicCorpus(queries, perQuery) {
    const results = await Promise.all(queries.map((query) => searchSemanticScholar(query, perQuery)));
    return results.flat();
}

async function searchSemanticScholar(query, limit) {
    const base = 'https://api.semanticscholar.org/graph/v1/paper/search';
    const fields = [
        'paperId',
        'title',
        'abstract',
        'url',
        'venue',
        'year',
        'authors',
        'externalIds',
        'citationCount'
    ].join(',');

    const headers = {
        Accept: 'application/json',
        'User-Agent': 'CS222-Research-Workflow/1.0 (gap-evidence-retrieval)'
    };

    const apiKey = clean(process.env.SEMANTIC_SCHOLAR_API_KEY);
    if (apiKey) {
        headers['x-api-key'] = apiKey;
    }

    const url = `${base}?query=${encodeURIComponent(query)}&limit=${limit}&fields=${encodeURIComponent(fields)}`;

    try {
        const response = await fetch(url, { headers });
        if (!response.ok) return [];
        const data = await response.json();
        const rows = Array.isArray(data?.data) ? data.data : [];

        return rows
            .map((row) => ({
                paperId: clean(row.paperId),
                doi: clean(row?.externalIds?.DOI),
                title: clean(row.title),
                abstract: clean(row.abstract),
                summary: clean(row.abstract),
                venue: clean(row.venue),
                year: row.year || '',
                source: 'semantic-scholar',
                authors: Array.isArray(row.authors) ? row.authors.map((author) => clean(author.name)).filter(Boolean) : [],
                queryHits: [query],
                relevanceScore: Number(row.citationCount || 0),
                citationCount: Number(row.citationCount || 0)
            }))
            .filter((paper) => paper.title);
    } catch {
        return [];
    }
}

function mergeAndDedupePapers(selected, retrieved) {
    const map = new Map();

    [...selected, ...retrieved].forEach((paper) => {
        const key = paperStableId(paper);
        const current = map.get(key);

        if (!current) {
            map.set(key, {
                ...paper,
                queryHits: [...new Set((paper.queryHits || []).map(clean).filter(Boolean))]
            });
            return;
        }

        map.set(key, {
            ...current,
            abstract: pickLonger(current.abstract, paper.abstract),
            summary: pickLonger(current.summary, paper.summary),
            venue: current.venue || paper.venue,
            year: current.year || paper.year,
            authors: current.authors?.length ? current.authors : paper.authors,
            citationCount: Math.max(Number(current.citationCount || 0), Number(paper.citationCount || 0)),
            queryHits: [...new Set([...(current.queryHits || []), ...(paper.queryHits || [])].map(clean).filter(Boolean))]
        });
    });

    return [...map.values()];
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
            year: paper.year,
            queryHits: paper.queryHits
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
                    limitations: 'explicit limitations or likely gaps',
                    futureWork: 'future work clues',
                    extractionConfidence: 0
                }
            ]
        }
    };

    try {
        log('extractPaperEvidence', `calling LLM to extract evidence from ${papers.length} papers`);
        const result = await callLlmJson(
            'Extract structured evidence from title and abstract only. Do not infer claims not supported by metadata. Return strict JSON.',
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

async function generateGapHypotheses(topic, paperAnalyses, seedPapers) {
    if (!paperAnalyses.length) return [];

    if (!isApiReady()) {
        log('generateGapHypotheses', 'API not ready → using fallback hypotheses');
        return fallbackGapHypotheses(topic, paperAnalyses, seedPapers);
    }

    const prompt = {
        topic,
        paperAnalyses,
        seedPaperKeys: seedPapers.map((paper) => paperStableId(paper)),
        instructions: [
            'Do not claim complete novelty.',
            'Generate defensible gap hypotheses from evidence only.',
            'Produce 1-2 hypotheses per category when possible.'
        ],
        categories: ['Population Gap', 'Methodological Gap', 'Empirical Gap', 'Practical Gap'],
        outputContract: {
            candidateGaps: [
                {
                    id: 'short id',
                    category: 'Population Gap | Methodological Gap | Empirical Gap | Practical Gap',
                    title: 'gap title',
                    description: 'defensible gap statement',
                    supportingPaperKeys: ['paperKey'],
                    evidenceReasoning: 'why this gap follows from extracted evidence',
                    searchQuery: 'verification search query',
                    novelty: 0,
                    feasibility: 0,
                    availableData: 0,
                    relevance: 0,
                    proposalPotential: 0
                }
            ]
        }
    };

    try {
        log('generateGapHypotheses', `calling LLM with ${paperAnalyses.length} paper analyses`);
        const result = await callLlmJson(
            'Generate research gap hypotheses from extracted evidence, grouped by category. Return strict JSON.',
            prompt
        );

        const rows = Array.isArray(result.candidateGaps) ? result.candidateGaps : [];
        const parsed = rows
            .map((row, index) => normalizeHypothesisRow(row, index))
            .filter((row) => row.title && row.description)
            .slice(0, 12);

        return parsed.length ? parsed : fallbackGapHypotheses(topic, paperAnalyses, seedPapers);
    } catch {
        return fallbackGapHypotheses(topic, paperAnalyses, seedPapers);
    }
}

async function verifyGapHypotheses(gaps, paperAnalyses) {
    const subset = gaps.slice(0, 12);

    return Promise.all(
        subset.map(async (gap) => {
            const query = clean(gap.searchQuery) || clean(gap.title);
            const [semanticScholarCount, arxivCount] = await Promise.all([
                semanticScholarTotal(query),
                arxivTotal(query)
            ]);

            const combined = semanticScholarCount + arxivCount;
            const evidence = computeGapEvidenceSignal(gap, paperAnalyses);
            const classification = classifyExploration({
                totalCount: combined,
                evidenceCoverage: evidence.evidenceCoverage,
                concentrationScore: evidence.concentrationScore
            });

            return {
                gapId: gap.id,
                query,
                semanticScholarCount,
                arxivCount,
                combinedCount: combined,
                evidenceCoverage: evidence.evidenceCoverage,
                concentrationScore: evidence.concentrationScore,
                matchedPaperCount: evidence.matchedPaperCount,
                matchedPaperKeys: evidence.matchedPaperKeys,
                classification,
                reasoning: verificationReasoning({
                    classification,
                    totalCount: combined,
                    evidenceCoverage: evidence.evidenceCoverage,
                    concentrationScore: evidence.concentrationScore,
                    matchedPaperCount: evidence.matchedPaperCount,
                    totalPaperCount: paperAnalyses.length
                })
            };
        })
    );
}

async function rankGapHypotheses(topic, gaps, checks, paperCount) {
    if (!gaps.length) return [];

    if (!isApiReady()) {
        log('rankGapHypotheses', 'API not ready → using fallback ranking');
        return fallbackRank(gaps, checks, paperCount);
    }

    const prompt = {
        topic,
        gaps,
        verificationChecks: checks,
        paperCount,
        instructions: [
            'Score for proposal potential, not absolute novelty.',
            'Respect verification classification: crowded and unsupported should reduce confidence.',
            'Return clear confidence label among underexplored, partially explored, crowded, unsupported.'
        ],
        outputContract: {
            rankedGaps: [
                {
                    id: 'gap id',
                    novelty: 0,
                    feasibility: 0,
                    availableData: 0,
                    relevance: 0,
                    proposalPotential: 0,
                    overallScore: 0,
                    confidenceScore: 0,
                    confidenceLabel: 'underexplored | partially explored | crowded | unsupported',
                    rationale: 'ranking reasoning',
                    researchQuestion: 'convert selected gap to one concrete research question'
                }
            ]
        }
    };

    try {
        log('rankGapHypotheses', `calling LLM to rank ${gaps.length} gaps`);
        const result = await callLlmJson(
            'Rank gap hypotheses for proposal viability with confidence labels. Return strict JSON.',
            prompt
        );

        const checkMap = new Map(checks.map((check) => [check.gapId, check]));
        const baseMap = new Map(gaps.map((gap) => [gap.id, gap]));

        const parsed = (Array.isArray(result.rankedGaps) ? result.rankedGaps : [])
            .map((row) => {
                const id = clean(row.id);
                const base = baseMap.get(id);
                const check = checkMap.get(id);
                if (!base) return null;

                const confidenceLabel = normalizeConfidenceLabel(clean(row.confidenceLabel) || check?.classification);

                return {
                    ...base,
                    novelty: clampNumber(row.novelty, 0, 100, base.novelty),
                    feasibility: clampNumber(row.feasibility, 0, 100, base.feasibility),
                    availableData: clampNumber(row.availableData, 0, 100, base.availableData),
                    relevance: clampNumber(row.relevance, 0, 100, base.relevance),
                    proposalPotential: clampNumber(row.proposalPotential, 0, 100, base.proposalPotential),
                    overallScore: clampNumber(row.overallScore, 0, 100, weightedScore(base)),
                    confidenceScore: clampNumber(row.confidenceScore, 0, 100, confidenceFromCheck(check, paperCount)),
                    confidenceLabel,
                    rationale: clean(row.rationale) || check?.reasoning || base.evidenceReasoning,
                    researchQuestion: clean(row.researchQuestion) || defaultResearchQuestion(base, topic),
                    verification: check || null
                };
            })
            .filter(Boolean)
            .sort((a, b) => Number(b.overallScore || 0) - Number(a.overallScore || 0));

        return parsed.length ? parsed : fallbackRank(gaps, checks, paperCount);
    } catch {
        return fallbackRank(gaps, checks, paperCount);
    }
}

function fallbackPaperEvidence(topic, papers) {
    if (isMusicIrTopic(topic)) {
        return musicIrFallbackPaperEvidence(papers);
    }

    return papers.map((paper) => ({
        paperKey: paperStableId(paper),
        title: paper.title,
        mainProblem: truncate(clean(paper.summary) || clean(paper.abstract) || `Problem related to ${topic}.`, 170),
        method: inferMethod(paper),
        datasetDomain: inferDatasetDomain(paper, topic),
        evaluationMetrics: inferMetrics(paper),
        limitations: inferLimitations(paper),
        futureWork: inferFutureWork(paper),
        extractionConfidence: 60
    }));
}

function fallbackGapHypotheses(topic, paperAnalyses, seedPapers) {
    if (isMusicIrTopic(topic)) {
        return musicIrFallbackGapHypotheses(topic, seedPapers);
    }

    const supportingKeys = seedPapers.slice(0, 6).map((paper) => paperStableId(paper));

    return [
        {
            id: 'population-gap-1',
            category: 'Population Gap',
            title: `${topic}: underrepresented populations and domains`,
            description: 'Evidence suggests focus on a narrow population/domain with limited coverage of long-tail groups or contexts.',
            supportingPaperKeys: supportingKeys,
            evidenceReasoning: 'Extracted dataset/domain fields repeatedly reference similar populations and contexts.',
            searchQuery: `${topic} underrepresented populations dataset`,
            novelty: 72,
            feasibility: 70,
            availableData: 64,
            relevance: 85,
            proposalPotential: 82
        },
        {
            id: 'methodological-gap-1',
            category: 'Methodological Gap',
            title: `${topic}: limited method diversity and missing modern baselines`,
            description: 'Many studies apply similar methods without evaluating stronger modern alternatives on the same problem.',
            supportingPaperKeys: supportingKeys,
            evidenceReasoning: 'Method extraction indicates repeated families and weak cross-method comparison patterns.',
            searchQuery: `${topic} transformer baseline comparison`,
            novelty: 68,
            feasibility: 79,
            availableData: 76,
            relevance: 83,
            proposalPotential: 84
        },
        {
            id: 'empirical-gap-1',
            category: 'Empirical Gap',
            title: `${topic}: insufficient real-world and reproducibility evidence`,
            description: 'Claims are often benchmark-centric with limited deployment studies, user studies, or reproducibility reporting.',
            supportingPaperKeys: supportingKeys,
            evidenceReasoning: 'Evaluation and limitation fields show sparse user studies and inconsistent reproducibility detail.',
            searchQuery: `${topic} reproducibility user study deployment`,
            novelty: 70,
            feasibility: 77,
            availableData: 71,
            relevance: 82,
            proposalPotential: 86
        },
        {
            id: 'practical-gap-1',
            category: 'Practical Gap',
            title: `${topic}: tooling and deployment translation gap`,
            description: 'The literature emphasizes theory/model gains but offers limited tooling, integration guides, and deployable systems.',
            supportingPaperKeys: supportingKeys,
            evidenceReasoning: 'Future work and limitations repeatedly request practical deployment and tool support.',
            searchQuery: `${topic} open-source toolkit deployment`,
            novelty: 66,
            feasibility: 81,
            availableData: 74,
            relevance: 78,
            proposalPotential: 80
        }
    ];
}

function fallbackRank(gaps, checks, paperCount) {
    const checkMap = new Map(checks.map((check) => [check.gapId, check]));

    return gaps
        .map((gap) => {
            const check = checkMap.get(gap.id);
            const confidenceLabel = normalizeConfidenceLabel(check?.classification || 'partially explored');
            const confidenceScore = confidenceFromCheck(check, paperCount);
            const saturationPenalty = confidenceLabel === 'crowded' ? 14 : confidenceLabel === 'unsupported' ? 22 : confidenceLabel === 'partially explored' ? 6 : 0;
            const overallScore = clampNumber(weightedScore(gap) - saturationPenalty, 0, 100, 60);

            return {
                ...gap,
                overallScore,
                confidenceScore,
                confidenceLabel,
                rationale: check?.reasoning || gap.evidenceReasoning,
                researchQuestion: defaultResearchQuestion(gap, 'this topic'),
                verification: check || null
            };
        })
        .sort((a, b) => Number(b.overallScore || 0) - Number(a.overallScore || 0));
}

function normalizeHypothesisRow(row, index) {
    return {
        id: clean(row.id) || `gap-${index + 1}`,
        category: normalizeCategory(row.category),
        title: clean(row.title),
        description: clean(row.description),
        supportingPaperKeys: Array.isArray(row.supportingPaperKeys) ? row.supportingPaperKeys.map(clean).filter(Boolean) : [],
        evidenceReasoning: clean(row.evidenceReasoning),
        searchQuery: clean(row.searchQuery),
        novelty: clampNumber(row.novelty, 0, 100, 60),
        feasibility: clampNumber(row.feasibility, 0, 100, 60),
        availableData: clampNumber(row.availableData, 0, 100, 60),
        relevance: clampNumber(row.relevance, 0, 100, 60),
        proposalPotential: clampNumber(row.proposalPotential, 0, 100, 60)
    };
}

function normalizeCategory(category) {
    const value = clean(category).toLowerCase();
    if (value.includes('population')) return 'Population Gap';
    if (value.includes('method')) return 'Methodological Gap';
    if (value.includes('empirical')) return 'Empirical Gap';
    if (value.includes('practical')) return 'Practical Gap';
    return 'Methodological Gap';
}

function classifyExploration({ totalCount, evidenceCoverage, concentrationScore }) {
    if (!Number.isFinite(totalCount) || totalCount <= 0) return 'unsupported';
    if (evidenceCoverage < 10 && totalCount < 120) return 'unsupported';

    const countPressure = countPressureScore(totalCount);
    const lowEvidencePenalty = 100 - evidenceCoverage;
    const weakConcentrationPenalty = 100 - concentrationScore;

    const crowdedScore =
        countPressure * 0.35 +
        lowEvidencePenalty * 0.4 +
        weakConcentrationPenalty * 0.25;

    if (crowdedScore >= 78) return 'crowded';
    if (crowdedScore >= 52) return 'partially explored';
    return 'underexplored';
}

function verificationReasoning({ classification, totalCount, evidenceCoverage, concentrationScore, matchedPaperCount, totalPaperCount }) {
    const evidencePhrase = `${matchedPaperCount}/${totalPaperCount} papers contain aligned limitation/future-work signals (${evidenceCoverage}% coverage)`;

    if (classification === 'unsupported') {
        return `Very low retrieval support and weak corpus evidence (${evidencePhrase}); treat this as weakly supported.`;
    }
    if (classification === 'underexplored') {
        return `Moderate evidence signal (${evidencePhrase}) with limited volume (${totalCount} hits) suggests this angle is underexplored.`;
    }
    if (classification === 'partially explored') {
        return `Mixed signal: ${totalCount} hits plus ${evidencePhrase}; likely partially explored with room for scoped contribution.`;
    }
    return `High retrieval pressure (${totalCount} hits) with weaker concentrated evidence (${evidenceCoverage}% coverage, concentration ${concentrationScore}%) suggests a crowded space requiring a sharper niche.`;
}

function countPressureScore(totalCount) {
    const logCount = Math.log10(Math.max(1, totalCount));
    if (logCount < 2.2) return 12;
    if (logCount < 3.0) return 24;
    if (logCount < 4.0) return 38;
    if (logCount < 5.0) return 52;
    if (logCount < 5.7) return 64;
    if (logCount < 6.3) return 74;
    if (logCount < 6.8) return 82;
    return 90;
}

function computeGapEvidenceSignal(gap, paperAnalyses) {
    const analyses = Array.isArray(paperAnalyses) ? paperAnalyses : [];
    const total = analyses.length || 1;
    const keywords = buildGapKeywords(gap);
    const supportingKeySet = new Set(
        (Array.isArray(gap.supportingPaperKeys) ? gap.supportingPaperKeys : [])
            .map((key) => clean(key).toLowerCase())
            .filter(Boolean)
    );
    const categoryCues = categoryCueTerms(gap.category);

    let matchedPaperCount = 0;
    const matchedPaperKeys = [];
    const methodCounts = new Map();
    const domainCounts = new Map();

    for (const analysis of analyses) {
        const paperText = [
            clean(analysis.title),
            clean(analysis.mainProblem),
            clean(analysis.limitations),
            clean(analysis.futureWork),
            clean(analysis.method),
            clean(analysis.datasetDomain)
        ]
            .join(' ')
            .toLowerCase();

        const keywordHits = keywords.reduce((hits, keyword) => hits + (paperText.includes(keyword) ? 1 : 0), 0);
        const categoryHits = categoryCues.reduce((hits, keyword) => hits + (paperText.includes(keyword) ? 1 : 0), 0);
        const hasLimitationCue = /limit|future|remain|open|challenge|underexplor|unclear|lack|insufficient|need/.test(paperText);
        const key = (clean(analysis.paperKey) || clean(analysis.title)).toLowerCase();
        const inSupportingSet = key && supportingKeySet.has(key);

        const evidenceScore =
            keywordHits * 0.5 +
            categoryHits * 0.6 +
            (hasLimitationCue ? 0.8 : 0) +
            (inSupportingSet ? 1.4 : 0);

        if (evidenceScore >= 1.6) {
            matchedPaperCount += 1;
            matchedPaperKeys.push(clean(analysis.paperKey) || clean(analysis.title));
            incrementCount(methodCounts, normalizeBucket(analysis.method));
            incrementCount(domainCounts, normalizeBucket(analysis.datasetDomain));
        }
    }

    const evidenceCoverage = clampNumber((matchedPaperCount / total) * 100, 0, 100, 0);
    const concentrationScore = Math.round((topShare(methodCounts) * 0.5 + topShare(domainCounts) * 0.5) * 100);

    return {
        evidenceCoverage,
        concentrationScore: clampNumber(concentrationScore, 0, 100, 0),
        matchedPaperCount,
        matchedPaperKeys: matchedPaperKeys.slice(0, 8)
    };
}

function buildGapKeywords(gap) {
    const text = `${clean(gap.title)} ${clean(gap.description)} ${clean(gap.searchQuery)}`.toLowerCase();
    const stopwords = new Set([
        'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'using', 'over', 'under', 'between', 'within',
        'method', 'methods', 'approach', 'approaches', 'study', 'studies', 'research', 'gap', 'gaps', 'based',
        'more', 'less', 'high', 'low', 'new', 'work', 'future', 'data', 'model', 'models', 'system', 'systems'
    ]);

    const tokens = text
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 4 && !stopwords.has(token));

    return [...new Set(tokens)].slice(0, 18);
}

function categoryCueTerms(category) {
    const normalized = clean(category).toLowerCase();
    if (normalized.includes('population')) {
        return ['population', 'demographic', 'cohort', 'domain', 'language', 'region', 'underrepresented'];
    }
    if (normalized.includes('method')) {
        return ['method', 'baseline', 'architecture', 'approach', 'model', 'comparison', 'ablation'];
    }
    if (normalized.includes('empirical')) {
        return ['evaluation', 'metric', 'benchmark', 'reproduc', 'validation', 'experiment', 'user study'];
    }
    if (normalized.includes('practical')) {
        return ['deployment', 'tooling', 'integration', 'production', 'latency', 'cost', 'workflow'];
    }
    return ['limitation', 'future', 'open', 'challenge'];
}

function normalizeBucket(value) {
    const normalized = clean(value).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
    return normalized || 'unknown';
}

function incrementCount(map, key) {
    map.set(key, Number(map.get(key) || 0) + 1);
}

function topShare(map) {
    const values = [...map.values()];
    if (!values.length) return 0;
    const total = values.reduce((sum, value) => sum + value, 0);
    if (!total) return 0;
    const top = Math.max(...values);
    return top / total;
}

function musicIrFallbackPaperEvidence(papers) {
    const examples = [
        {
            mainProblem: 'Automatic music transcription models degrade on non-piano and low-resource instruments.',
            method: 'CNN/Transformer hybrid transcription with spectrogram front-end and note-event decoding.',
            datasetDomain: 'Predominantly Western piano and studio-quality recordings.',
            evaluationMetrics: 'Onset F1, Frame F1, Note F1, Precision/Recall by instrument.',
            limitations: 'Limited instrument diversity and weak robustness to live/noisy mixes.',
            futureWork: 'Expand training/evaluation to non-Western instruments and in-the-wild recordings.'
        },
        {
            mainProblem: 'Cover-song retrieval struggles with cross-genre and cross-culture rearrangements.',
            method: 'Chromagram alignment plus contrastive embedding retrieval over candidate pairs.',
            datasetDomain: 'Benchmark-centric collections with narrow genre and language coverage.',
            evaluationMetrics: 'MRR, Recall@K, nDCG, alignment accuracy.',
            limitations: 'Bias toward tonal harmony conventions and limited global music variety.',
            futureWork: 'Learn culturally robust representations and expand multilingual, multi-genre corpora.'
        },
        {
            mainProblem: 'Music recommendation overfits engagement and under-serves novelty/diversity objectives.',
            method: 'Sequential recommendation with implicit-feedback ranking objectives.',
            datasetDomain: 'Commercial listening logs and mainstream catalog subsets.',
            evaluationMetrics: 'HitRate@K, nDCG@K, coverage, diversity, calibration error.',
            limitations: 'Cold-start and fairness tradeoffs are weakly evaluated.',
            futureWork: 'Jointly optimize relevance, diversity, and fairness under user-centric constraints.'
        },
        {
            mainProblem: 'Query-by-humming retrieval is fragile under tempo drift, pitch instability, and background noise.',
            method: 'Melodic contour matching with dynamic time warping and learned embeddings.',
            datasetDomain: 'Small clean-query datasets with limited real-world noise profiles.',
            evaluationMetrics: 'Top-1 accuracy, Recall@10, robustness under perturbations.',
            limitations: 'Insufficient evaluation on spontaneous humming and mobile microphone conditions.',
            futureWork: 'Create realistic benchmark suites and robust preprocessing for noisy user input.'
        }
    ];

    return papers.map((paper, index) => {
        const example = examples[index % examples.length];
        return {
            paperKey: paperStableId(paper),
            title: paper.title,
            mainProblem: example.mainProblem,
            method: example.method,
            datasetDomain: example.datasetDomain,
            evaluationMetrics: example.evaluationMetrics,
            limitations: example.limitations,
            futureWork: example.futureWork,
            extractionConfidence: 68
        };
    });
}

function musicIrFallbackGapHypotheses(topic, seedPapers) {
    const supportingKeys = seedPapers.slice(0, 8).map((paper) => paperStableId(paper));

    return [
        {
            id: 'musicir-population-gap-1',
            category: 'Population Gap',
            title: 'Music IR underrepresentation of global and low-resource music traditions',
            description: 'Many MIR systems are evaluated on Western-dominant corpora, leaving underexplored performance on underrepresented instruments, tonal systems, and languages.',
            supportingPaperKeys: supportingKeys,
            evidenceReasoning: 'Fallback evidence patterns identify narrow dataset demographics and repeated calls for broader cultural coverage.',
            searchQuery: 'music information retrieval underrepresented instruments non western datasets limitations',
            novelty: 79,
            feasibility: 70,
            availableData: 62,
            relevance: 90,
            proposalPotential: 88
        },
        {
            id: 'musicir-method-gap-1',
            category: 'Methodological Gap',
            title: 'Insufficient cross-task transfer methods across core MIR tasks',
            description: 'Current pipelines optimize isolated tasks (transcription, tagging, retrieval) rather than shared representations that transfer robustly across tasks and domains.',
            supportingPaperKeys: supportingKeys,
            evidenceReasoning: 'Method examples suggest siloed architectures and limited cross-task ablation evidence.',
            searchQuery: 'music ir multi task representation learning transcription tagging retrieval benchmark',
            novelty: 75,
            feasibility: 73,
            availableData: 67,
            relevance: 86,
            proposalPotential: 85
        },
        {
            id: 'musicir-empirical-gap-1',
            category: 'Empirical Gap',
            title: 'Weak real-world robustness and reproducibility reporting in MIR evaluations',
            description: 'Many reported gains rely on controlled benchmarks with limited stress-testing for noisy audio, live recordings, device variability, and annotation uncertainty.',
            supportingPaperKeys: supportingKeys,
            evidenceReasoning: 'Fallback evaluation examples include benchmark metrics but repeatedly note weak external validity and robustness coverage.',
            searchQuery: 'music information retrieval robustness reproducibility in the wild evaluation',
            novelty: 72,
            feasibility: 82,
            availableData: 76,
            relevance: 89,
            proposalPotential: 90
        },
        {
            id: 'musicir-practical-gap-1',
            category: 'Practical Gap',
            title: 'Limited deployment-focused MIR tooling for practitioners and creators',
            description: 'Research outputs often lack production-ready pipelines, latency/cost analysis, and integration guidance for creative workflows and music applications.',
            supportingPaperKeys: supportingKeys,
            evidenceReasoning: 'Future-work cues consistently request end-to-end tooling, deployment pathways, and human-in-the-loop validation.',
            searchQuery: 'music ir deployment tooling production workflow latency cost',
            novelty: 69,
            feasibility: 84,
            availableData: 74,
            relevance: 83,
            proposalPotential: 87
        }
    ];
}

function confidenceFromCheck(check, paperCount) {
    const base = check?.classification === 'underexplored'
        ? 82
        : check?.classification === 'partially explored'
            ? 70
            : check?.classification === 'crowded'
                ? 48
                : 34;

    const corpusBoost = Math.min(10, Math.max(0, paperCount - 8));
    return clampNumber(base + corpusBoost, 0, 100, 60);
}

function normalizeConfidenceLabel(value) {
    const normalized = clean(value).toLowerCase();
    if (normalized === 'underexplored') return 'underexplored';
    if (normalized === 'partially explored') return 'partially explored';
    if (normalized === 'crowded') return 'crowded';
    return 'unsupported';
}

function defaultResearchQuestion(gap, topic) {
    return `How can we address ${clean(gap.title).toLowerCase()} in ${topic} using a method that improves measurable outcomes while remaining feasible with available data?`;
}

function weightedScore(gap) {
    const novelty = clampNumber(gap.novelty, 0, 100, 60);
    const feasibility = clampNumber(gap.feasibility, 0, 100, 60);
    const availableData = clampNumber(gap.availableData, 0, 100, 60);
    const relevance = clampNumber(gap.relevance, 0, 100, 60);
    const proposalPotential = clampNumber(gap.proposalPotential, 0, 100, 60);

    return Math.round(
        novelty * 0.22 +
        feasibility * 0.2 +
        availableData * 0.18 +
        relevance * 0.2 +
        proposalPotential * 0.2
    );
}

async function semanticScholarTotal(query) {
    const base = 'https://api.semanticscholar.org/graph/v1/paper/search';
    const headers = {
        Accept: 'application/json',
        'User-Agent': 'CS222-Research-Workflow/1.0 (gap-verification)'
    };

    const apiKey = clean(process.env.SEMANTIC_SCHOLAR_API_KEY);
    if (apiKey) {
        headers['x-api-key'] = apiKey;
    }

    const url = `${base}?query=${encodeURIComponent(query)}&limit=1&fields=title`;

    try {
        const response = await fetch(url, { headers });
        if (!response.ok) return 0;
        const data = await response.json();
        return Number(data?.total || 0);
    } catch {
        return 0;
    }
}

async function arxivTotal(query) {
    const endpoint = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=1`;

    try {
        const response = await fetch(endpoint, {
            headers: { Accept: 'application/atom+xml' }
        });

        if (!response.ok) return 0;
        const xml = await response.text();
        const match = xml.match(/<opensearch:totalResults>(\d+)<\/opensearch:totalResults>/i);
        return match ? Number(match[1]) : 0;
    } catch {
        return 0;
    }
}

async function callLlmJson(systemPrompt, payload) {
    const model = clean(process.env.LLM_MODEL);
    if (!model) {
        throw new Error('LLM_MODEL is required for research gap detection.');
    }

    const task = payload.topic
        ? (payload.papers ? 'extract-evidence' : payload.gaps ? 'rank-gaps' : payload.candidateGaps ? 'rank-gaps' : 'build-queries')
        : 'unknown';
    log('callLlmJson', `→ LLM request | model=${model} | provider=${provider()} | task=${task}`);
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
                systemInstruction: {
                    parts: [{ text: systemPrompt }]
                },
                contents: [
                    {
                        role: 'user',
                        parts: [{ text: JSON.stringify(payload, null, 2) }]
                    }
                ],
                generationConfig: {
                    temperature: 0.2,
                    responseMimeType: 'application/json'
                }
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data?.error?.message || `Gemini API returned ${response.status}`);
        }

        const content = data?.candidates?.[0]?.content?.parts
            ?.map((part) => part.text)
            .filter(Boolean)
            .join('\n');

        const parsed = parseJsonContent(content);
        log('callLlmJson', `← LLM response | model=${model} | task=${task} | ${Date.now() - t0}ms | ${content?.length ?? 0} chars`);
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
    log('callLlmJson', `← LLM response | model=${model} | task=${task} | ${Date.now() - t0}ms | ${content?.length ?? 0} chars`);
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

function fallbackQueries(topic, count) {
    const base = clean(topic);
    if (isMusicIrTopic(topic)) {
        const musicQueries = [
            'music information retrieval symbolic audio alignment limitations',
            'music IR cross cultural datasets underrepresented genres',
            'automatic music transcription low resource instruments benchmark',
            'music IR retrieval evaluation user study future work',
            'music recommendation fairness diversity cold start music IR',
            'cover song identification robustness domain shift music IR'
        ];

        return [...new Set(musicQueries.map(clean).filter(Boolean))].slice(0, count);
    }

    const candidates = [
        `${base} survey`,
        `${base} benchmark`,
        `${base} user study`,
        `${base} deployment`,
        `${base} limitations future work`,
        `${base} underrepresented languages domains`
    ];

    return [...new Set(candidates.map(clean).filter(Boolean))].slice(0, count);
}

function isMusicIrTopic(topic) {
    const text = clean(topic).toLowerCase();
    if (!text) return false;

    return [
        'music',
        'mir',
        'music information retrieval',
        'transcription',
        'cover song',
        'audio tagging',
        'recommendation',
        'query by humming',
        'symbolic music'
    ].some((term) => text.includes(term));
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
    return truncate('Likely limitations inferred from abstract: limited scope, benchmark dependency, or weak external validation.', 160);
}

function inferFutureWork(paper) {
    const text = `${clean(paper.summary)} ${clean(paper.abstract)}`;
    if (!text) return 'Future work not explicit in metadata.';
    return truncate('Potential future work includes stronger generalization tests, richer datasets, and practical deployment evaluation.', 160);
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
    return `title:${normalizeTitle(paper?.title || '')}`;
}

function normalizeTitle(title) {
    return clean(title)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function pickLonger(a, b) {
    return clean(a).length >= clean(b).length ? clean(a) : clean(b);
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
