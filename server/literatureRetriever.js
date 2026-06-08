function log(tag, msg) {
  console.log(`[literature:${tag}] ${msg}`);
}

const DEFAULT_QUERY_COUNT = 3;
const DEFAULT_MAX_PER_QUERY = 12;
const DEFAULT_TOP_PAPERS = 36;

export async function retrieveLiterature(payload = {}) {
    const topic = clean(payload.topic);

    if (!topic) {
        throw new Error('Topic is required for literature retrieval.');
    }

    const queryCount = clampNumber(payload.queryCount, 1, 5, DEFAULT_QUERY_COUNT);
    const maxPerQuery = clampNumber(payload.maxPerQuery, 10, 20, DEFAULT_MAX_PER_QUERY);
    const topPapers = clampNumber(payload.topPapers, 10, 80, DEFAULT_TOP_PAPERS);
    log('retrieveLiterature', `topic="${topic}" | enhanceWithAI=${Boolean(payload.enhanceWithAI)} | queryCount=${queryCount} | maxPerQuery=${maxPerQuery}`);

    const rewrittenQueries = await rewriteQueries(topic, queryCount, Boolean(payload.enhanceWithAI));
    log('retrieveLiterature', `queries: ${rewrittenQueries.map(q => `"${q}"`).join(' | ')}`);
    const queryResults = await Promise.all(
        rewrittenQueries.map((query) => fetchQueryPapers(query, maxPerQuery))
    );

    const rawCount = queryResults.reduce((sum, r) => sum + r.papers.length, 0);
    const deduped = dedupePapers(queryResults.flatMap((result) => result.papers));
    log('retrieveLiterature', `fetched ${rawCount} papers → ${deduped.length} unique after dedup`);

    const ranked = await rankAndSummarizePapers({ topic, rewrittenQueries, papers: deduped.slice(0, topPapers) });

    return {
        mode: isApiReady() ? 'api' : 'local-fallback',
        provider: process.env.LLM_API_URL || 'local-fallback',
        topic,
        queriesEnhanced: Boolean(payload.enhanceWithAI) && isApiReady(),
        queries: rewrittenQueries,
        papers: ranked,
        sourceStats: summarizeSources(queryResults),
        dedupeStats: {
            raw: queryResults.reduce((sum, item) => sum + item.papers.length, 0),
            unique: deduped.length
        }
    };
}

async function rewriteQueries(topic, count, enhanceWithAI = false) {
    if (!enhanceWithAI || !isApiReady()) {
        const queries = deterministicQueries(topic, count);
        log('rewriteQueries', `deterministic | ${queries.join(' | ')}`);
        return queries;
    }
    log('rewriteQueries', `→ LLM query enhancement | model=${process.env.LLM_MODEL}`);

    const prompt = {
        topic,
        constraints: [
            'Return short academic search queries (3 to 10 words each).',
            'Cover breadth and method diversity.',
            'Prioritize recent and feasible CS/NLP directions.',
            `Return exactly ${count} queries.`
        ],
        outputContract: {
            queries: ['query string']
        }
    };

    try {
        const result = await callLlmJson(
            'You rewrite broad research interests into high-quality academic literature search queries. Return strict JSON.',
            prompt
        );
        const queries = Array.isArray(result.queries) ? result.queries.map(clean).filter(Boolean) : [];
        const deduped = [...new Set(queries)].slice(0, count);
        if (deduped.length) {
            log('rewriteQueries', `← LLM queries: ${deduped.join(' | ')}`);
            return deduped;
        }
        log('rewriteQueries', 'LLM returned empty queries, falling back to deterministic');
        return deterministicQueries(topic, count);
    } catch (error) {
        log('rewriteQueries', `LLM failed (${error.message}), using deterministic`);
        return deterministicQueries(topic, count);
    }
}

async function fetchQueryPapers(query, maxPerQuery) {
    const [semanticScholar, arxiv] = await Promise.all([
        fetchSemanticScholar(query, maxPerQuery),
        fetchArxiv(query, maxPerQuery)
    ]);

    return {
        query,
        papers: [...semanticScholar, ...arxiv]
    };
}

async function fetchSemanticScholar(query, limit) {
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
        'citationCount',
        'publicationTypes'
    ].join(',');

    const headers = {
        Accept: 'application/json',
        'User-Agent': 'CS222-Research-Workflow/1.0 (academic-literature-retrieval)'
    };
    const apiKey = clean(process.env.SEMANTIC_SCHOLAR_API_KEY);

    if (apiKey) {
        headers['x-api-key'] = apiKey;
    }

    let data = await fetchSemanticScholarJson({ base, query, limit, fields, headers });

    if (!data && !apiKey) {
        const reducedLimit = Math.min(limit, 4);
        data = await fetchSemanticScholarJson({
            base,
            query,
            limit: reducedLimit,
            fields,
            headers
        });
    }

    if (!data) {
        return [];
    }

    const papers = Array.isArray(data?.data) ? data.data : [];

    return papers
        .map((paper) => normalizePaper({
            source: 'semantic-scholar',
            query,
            paperId: paper.paperId,
            doi: paper?.externalIds?.DOI,
            title: paper.title,
            abstract: paper.abstract,
            url: paper.url,
            venue: paper.venue,
            year: paper.year,
            citationCount: paper.citationCount,
            authors: Array.isArray(paper.authors) ? paper.authors.map((author) => clean(author.name)).filter(Boolean) : []
        }))
        .filter((paper) => paper.title);
}

async function fetchSemanticScholarJson({ base, query, limit, fields, headers }) {
    const url = `${base}?query=${encodeURIComponent(query)}&limit=${limit}&fields=${encodeURIComponent(fields)}`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
        return null;
    }

    return response.json();
}

async function fetchArxiv(query, limit) {
    const endpoint = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${limit}&sortBy=relevance&sortOrder=descending`;
    const response = await fetch(endpoint, {
        headers: { Accept: 'application/atom+xml' }
    });

    if (!response.ok) {
        return [];
    }

    const xml = await response.text();
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => match[1]);

    return entries
        .map((entry) => {
            const title = clean(decodeXml(readTag(entry, 'title')));
            const summary = clean(decodeXml(readTag(entry, 'summary')));
            const id = clean(readTag(entry, 'id'));
            const year = Number(readTag(entry, 'published').slice(0, 4)) || '';
            const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>\s*<\/author>/g)]
                .map((match) => clean(decodeXml(match[1])))
                .filter(Boolean);

            return normalizePaper({
                source: 'arxiv',
                query,
                paperId: id,
                doi: '',
                title,
                abstract: summary,
                url: id,
                venue: 'arXiv',
                year,
                citationCount: 0,
                authors
            });
        })
        .filter((paper) => paper.title);
}

function dedupePapers(papers) {
    const map = new Map();

    papers.forEach((paper) => {
        const key = dedupeKey(paper);
        const current = map.get(key);

        if (!current) {
            map.set(key, { ...paper, queryHits: [paper.query] });
            return;
        }

        const merged = {
            ...current,
            abstract: pickLonger(current.abstract, paper.abstract),
            url: current.url || paper.url,
            venue: current.venue || paper.venue,
            year: current.year || paper.year,
            citationCount: Math.max(Number(current.citationCount || 0), Number(paper.citationCount || 0)),
            authors: current.authors.length ? current.authors : paper.authors,
            queryHits: [...new Set([...current.queryHits, paper.query])],
            source: current.source === paper.source ? current.source : 'mixed'
        };

        map.set(key, merged);
    });

    return [...map.values()];
}

async function rankAndSummarizePapers({ topic, rewrittenQueries, papers }) {
    if (!papers.length) return [];
    log('rankAndSummarizePapers', `${papers.length} papers | api=${isApiReady()} | model=${process.env.LLM_MODEL || 'none'}`);

    if (!isApiReady()) {
        return papers
            .sort((a, b) => Number(b.citationCount || 0) - Number(a.citationCount || 0))
            .slice(0, 24)
            .map((paper, index) => ({
                ...paper,
                relevanceScore: Math.max(45, 100 - index * 2),
                summary: fallbackSummary(paper),
                whyRelevant: `Matched query themes: ${paper.queryHits.join(' | ') || topic}.`
            }));
    }

    const prompt = {
        topic,
        queries: rewrittenQueries,
        papers: papers.map((paper) => ({
            paperKey: dedupeKey(paper),
            title: paper.title,
            abstract: truncate(paper.abstract, 900),
            venue: paper.venue,
            year: paper.year,
            citationCount: paper.citationCount,
            queryHits: paper.queryHits
        })),
        outputContract: {
            ranked: [
                {
                    paperKey: 'stable key from paperKey',
                    relevanceScore: '0-100 integer',
                    summary: '1-2 sentence summary',
                    whyRelevant: '1 sentence fit-to-topic explanation'
                }
            ]
        }
    };

    try {
        const result = await callLlmJson(
            'You rank candidate papers for a student research proposal and summarize each paper from metadata only. Return strict JSON.',
            prompt
        );

        const rankedMap = new Map(
            (Array.isArray(result.ranked) ? result.ranked : []).map((row) => [
                clean(row.paperKey),
                {
                    relevanceScore: clampNumber(row.relevanceScore, 0, 100, 60),
                    summary: clean(row.summary),
                    whyRelevant: clean(row.whyRelevant)
                }
            ])
        );

        return papers
            .map((paper) => {
                const ranked = rankedMap.get(dedupeKey(paper));

                return {
                    ...paper,
                    relevanceScore: ranked?.relevanceScore ?? Math.min(95, 35 + Number(paper.citationCount || 0) / 10),
                    summary: ranked?.summary || fallbackSummary(paper),
                    whyRelevant: ranked?.whyRelevant || `Potentially useful for ${topic} due to overlap with ${paper.queryHits.join(', ') || 'your queries'}.`
                };
            })
            .sort((a, b) => Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0))
            .slice(0, 24);
    } catch {
        return papers
            .sort((a, b) => Number(b.citationCount || 0) - Number(a.citationCount || 0))
            .slice(0, 24)
            .map((paper, index) => ({
                ...paper,
                relevanceScore: Math.max(45, 100 - index * 2),
                summary: fallbackSummary(paper),
                whyRelevant: `Matched query themes: ${paper.queryHits.join(' | ') || topic}.`
            }));
    }
}

async function callLlmJson(systemPrompt, payload) {
    const model = clean(process.env.LLM_MODEL);

    if (!model) {
        throw new Error('LLM_MODEL is required for API-backed literature processing.');
    }

    const task = payload.topic ? (payload.papers ? 'rank-papers' : 'rewrite-queries') : 'unknown';
    log('callLlmJson', `→ LLM request | model=${model} | task=${task}`);
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

    const response = await fetch(process.env.LLM_API_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${process.env.LLM_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model,
            temperature: 0.2,
            max_tokens: 4096,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: JSON.stringify(payload, null, 2) }
            ]
        })
    });
    const data = await response.json();

    if (!response.ok) {
        throw new Error(data?.error?.message || `API returned ${response.status}`);
    }

    const content = typeof data?.choices?.[0]?.message?.content === 'string'
        ? data.choices[0].message.content
        : JSON.stringify(data);

    const parsed = parseJsonContent(content);
    log('callLlmJson', `← LLM response | model=${model} | task=${task} | ${Date.now() - t0}ms | ${content?.length ?? 0} chars`);
    return parsed;
}

function summarizeSources(queryResults) {
    const all = queryResults.flatMap((item) => item.papers);
    const bySource = all.reduce(
        (stats, paper) => {
            stats[paper.source] = (stats[paper.source] || 0) + 1;
            return stats;
        },
        {}
    );

    return {
        semanticScholar: bySource['semantic-scholar'] || 0,
        arxiv: bySource.arxiv || 0
    };
}

function normalizePaper(paper) {
    return {
        source: clean(paper.source) || 'unknown',
        query: clean(paper.query),
        paperId: clean(paper.paperId),
        doi: clean(paper.doi),
        title: clean(paper.title),
        abstract: clean(paper.abstract),
        url: clean(paper.url),
        venue: clean(paper.venue),
        year: paper.year || '',
        citationCount: Number(paper.citationCount || 0),
        authors: Array.isArray(paper.authors) ? paper.authors.map(clean).filter(Boolean).slice(0, 8) : []
    };
}

function dedupeKey(paper) {
    if (paper.paperId) return `pid:${paper.paperId.toLowerCase()}`;
    if (paper.doi) return `doi:${paper.doi.toLowerCase()}`;
    return `title:${normalizeTitle(paper.title)}`;
}

function normalizeTitle(title) {
    return clean(title)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function deterministicQueries(topic, count) {
    const base = clean(topic);
    const candidates = [
        base,
        `${base} survey`,
        `${base} review`,
        `${base} limitations`,
        `${base} evaluation`,
        `${base} benchmark`,
        `${base} recent advances`
    ];

    return [...new Set(candidates.map(clean).filter(Boolean))].slice(0, count);
}

function fallbackSummary(paper) {
    const abstract = clean(paper.abstract);
    if (!abstract) return 'Metadata-only record. Open the paper for full content.';
    return truncate(abstract, 240);
}

function pickLonger(a, b) {
    return clean(a).length >= clean(b).length ? clean(a) : clean(b);
}

function readTag(entry, tag) {
    const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const match = entry.match(regex);
    return match ? match[1].trim() : '';
}

function decodeXml(value) {
    return String(value || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function truncate(value, max) {
    const text = clean(value);
    if (text.length <= max) return text;
    return `${text.slice(0, max - 1).trimEnd()}…`;
}

function parseJsonContent(content) {
    const text = clean(content);
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced?.[1] || text;

    try {
        return JSON.parse(candidate);
    } catch {
        return {};
    }
}

function clampNumber(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(min, Math.min(max, Math.round(numeric)));
}

function provider() {
    const raw = clean(process.env.LLM_PROVIDER).toLowerCase();
    if (raw === 'gemini') return 'gemini';
    return 'openai-compatible';
}

function isApiReady() {
    return Boolean(clean(process.env.LLM_API_KEY) && clean(process.env.LLM_API_URL));
}

function clean(value) {
    return String(value || '').trim();
}