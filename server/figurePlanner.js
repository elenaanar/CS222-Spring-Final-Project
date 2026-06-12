function log(tag, msg) {
  console.log(`[figures:${tag}] ${msg}`);
}

const PLAN_PROMPT = `You are a research proposal figure planner. Suggest meaningful figures that strengthen a research proposal WITHOUT inventing experimental results.

You receive: project state, proposalLatex, optional evaluationReport, optional reviewerCritiques.

Allowed figure types:
- "methodology_diagram"   — multi-step method or pipeline
- "experiment_workflow"   — participant/data collection process
- "evaluation_pipeline"   — model/evaluation/baseline flow
- "timeline"              — milestones and schedule
- "literature_map"        — relationships between prior works and gap
- "idea_flow"             — gap → hypothesis → method → contribution chain

FORBIDDEN: accuracy graphs, result tables, performance benchmarks, anything implying completed experiments.

Prioritise suggestions that address reviewer or evaluation-report complaints about:
"missing figure", "unclear workflow", "hard to follow", "method is unclear", "evaluation unclear".

Use only "Proposed", "Planned", "Conceptual", "Overview of" language in captions. Never "Results show", "Observed", "Measured".

Return strict JSON (no markdown fences):
{
  "suggestions": [
    {
      "id": "short-kebab-id",
      "type": "methodology_diagram | experiment_workflow | evaluation_pipeline | timeline | literature_map | idea_flow",
      "title": "Descriptive title",
      "reason": "Why this figure would help (1-2 sentences)",
      "targetSection": "Exact section name from the proposal",
      "components": ["component 1", "component 2", "..."],
      "captionDraft": "Caption using proposed/planned/conceptual language",
      "confidence": 1
    }
  ]
}

Return 2–5 suggestions. Rank by confidence (5 = most impactful). Do not suggest the same type twice unless one addresses a specific critique.`;

const GENERATE_PROMPT = `You are a LaTeX TikZ figure generator for research proposals.

You receive: a figure suggestion (type, title, components, captionDraft, targetSection), project state, and proposalLatex.

Generate a complete, compilable LaTeX figure block. Rules:
- Use \\begin{figure}[h] ... \\end{figure}
- Use TikZ inside the figure
- Do NOT include \\documentclass, \\usepackage, or preamble — only the figure block
- Use "proposed / planned / conceptual" language in caption and node labels
- Never imply completed experiments or real results
- Label: \\label{fig:<id>}
- The figure must compile standalone inside a document that has: \\usepackage{tikz} and \\usetikzlibrary{arrows.meta, positioning, shapes.geometric}

Layout guidelines:
- methodology_diagram / experiment_workflow / evaluation_pipeline → vertical flowchart (below of)
- timeline → horizontal chain (right of), equal-width boxes
- literature_map → hub-and-spoke: central topic node + surrounding paper/concept nodes
- idea_flow → left-to-right chain (right of)

Keep node labels short (≤4 words). Use components list as node content.

Return strict JSON (no markdown fences):
{
  "figureLatex": "complete LaTeX figure block as a single string",
  "caption": "final caption text",
  "targetSection": "section name",
  "insertionHint": "e.g. Insert after the method description paragraph"
}`;

function isApiReady() {
  return Boolean(process.env.LLM_API_KEY && process.env.LLM_API_URL);
}

function provider() {
  return (process.env.LLM_API_URL || '').toLowerCase().includes('generativelanguage.googleapis.com') ? 'gemini' : 'openai';
}

function clean(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function parseJsonContent(content) {
  const text = clean(content);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) { try { return JSON.parse(fenced[1]); } catch { /* fall through */ } }
  try { return JSON.parse(text); } catch { /* fall through */ }
  const s = text.indexOf('{'); const e = text.lastIndexOf('}');
  if (s !== -1 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch { /* fall through */ } }
  throw new Error('Could not parse LLM response as JSON');
}

async function callLlmJson(systemPrompt, payload) {
  const model = clean(process.env.LLM_MODEL);
  if (!model) throw new Error('LLM_MODEL is required.');
  const t0 = Date.now();

  if (provider() === 'gemini') {
    const base = (clean(process.env.LLM_API_URL) || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    const res = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.LLM_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(payload, null, 2) }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `Gemini API ${res.status}`);
    const content = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n');
    log('llm', `← ${Date.now() - t0}ms`);
    return parseJsonContent(content);
  }

  const req = async (m) => {
    const res = await fetch(process.env.LLM_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.LLM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, temperature: 0.2, max_tokens: 3000, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: JSON.stringify(payload, null, 2) }] })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `API ${res.status}`);
    return typeof data?.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content : JSON.stringify(data);
  };

  let content;
  try { content = await req(model); }
  catch (err) {
    const fb = clean(process.env.LLM_FALLBACK_MODEL) || 'meta-llama/llama-3.1-8b-instruct:free';
    if (/credits|balance|quota/i.test(err.message) && fb !== model) { content = await req(fb); }
    else throw err;
  }
  log('llm', `← ${Date.now() - t0}ms`);
  return parseJsonContent(content);
}

// ─── Local fallbacks ──────────────────────────────────────────────────────────

function localFallbackPlan(project, proposalLatex, reviewerCritiques) {
  const latex = String(proposalLatex || '');
  const method = String(project?.method || '');
  const timeline = String(project?.timeline || '');
  const evaluation = String(project?.evaluation || '');
  const references = String(project?.references || '');

  const critText = (reviewerCritiques || []).map(c => (c.analysis || '') + ' ' + (c.issue || '')).join(' ').toLowerCase();
  const wantsFlow = /unclear.*method|hard to follow|missing.*diagram|missing.*figure|method.*unclear/.test(critText);
  const wantsEval = /evaluation.*unclear|unclear.*eval|missing.*eval.*diagram/.test(critText);

  const suggestions = [];

  if (method.length > 100 || wantsFlow) {
    const steps = method.split(/[.,;]/).map(s => s.trim()).filter(s => s.length > 10).slice(0, 6);
    suggestions.push({
      id: 'methodology-diagram',
      type: 'methodology_diagram',
      title: 'Proposed Methodology Workflow',
      reason: 'The method section describes a multi-step process. A diagram would make the pipeline easier to follow.',
      targetSection: 'Method',
      components: steps.length >= 2 ? steps : ['Data Collection', 'Preprocessing', 'Model Training', 'Evaluation'],
      captionDraft: 'Overview of the proposed methodology and processing pipeline.',
      confidence: wantsFlow ? 5 : 4
    });
  }

  if (evaluation.length > 80 || wantsEval) {
    suggestions.push({
      id: 'evaluation-pipeline',
      type: 'evaluation_pipeline',
      title: 'Proposed Evaluation Pipeline',
      reason: 'The evaluation plan involves multiple stages. A diagram clarifies what is being measured and how.',
      targetSection: 'Evaluation Plan',
      components: ['Baseline Models', 'Proposed System', 'Evaluation Metrics', 'Statistical Analysis', 'Comparison'],
      captionDraft: 'Planned evaluation pipeline comparing the proposed system against baselines.',
      confidence: wantsEval ? 5 : 3
    });
  }

  if (timeline.length > 50) {
    const phases = timeline.split(/[.,;]/).map(s => s.trim()).filter(s => s.length > 8).slice(0, 5);
    suggestions.push({
      id: 'project-timeline',
      type: 'timeline',
      title: 'Project Timeline',
      reason: 'The milestones section outlines distinct research phases that benefit from a visual timeline.',
      targetSection: 'Expected Results and Research Milestones',
      components: phases.length >= 2 ? phases : ['Literature Review', 'System Design', 'Implementation', 'Evaluation', 'Writing'],
      captionDraft: 'Planned project timeline showing key research phases and milestones.',
      confidence: 3
    });
  }

  if (references.length > 80) {
    suggestions.push({
      id: 'literature-map',
      type: 'literature_map',
      title: 'Literature Relationship Map',
      reason: 'The references section cites multiple prior works. A relationship map shows how they connect to the research gap.',
      targetSection: 'Motivation and Research Gap',
      components: ['Prior Work A', 'Prior Work B', 'Prior Work C', 'Identified Gap', 'Proposed Contribution'],
      captionDraft: 'Conceptual map of how prior works relate to the identified research gap.',
      confidence: 2
    });
  }

  suggestions.push({
    id: 'idea-flow',
    type: 'idea_flow',
    title: 'Research Idea Flow',
    reason: 'Showing the logical chain from gap to hypothesis to method to expected contribution helps reviewers follow the research logic.',
    targetSection: 'Project Goal',
    components: ['Research Gap', 'Core Hypothesis', 'Proposed Method', 'Expected Contribution'],
    captionDraft: 'Conceptual flow from the identified research gap to the proposed contribution.',
    confidence: 3
  });

  return suggestions.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}

function tikzFlowchart(components, id, caption) {
  const nodes = components.map((c, i) =>
    `\\node[box] (n${i}) ${i > 0 ? `[below of=n${i - 1}]` : ''} {${c}};`
  ).join('\n');
  const arrows = components.slice(0, -1).map((_, i) => `\\draw[arrow] (n${i}) -- (n${i + 1});`).join('\n');
  return `\\begin{figure}[h]
\\centering
\\begin{tikzpicture}[
  node distance=1.5cm,
  box/.style={draw, rounded corners, align=center, minimum width=5.5cm, minimum height=0.85cm, fill=blue!5, font=\\small},
  arrow/.style={->, thick, >=Stealth}
]
${nodes}
${arrows}
\\end{tikzpicture}
\\caption{${caption}}
\\label{fig:${id}}
\\end{figure}`;
}

function tikzTimeline(components, id, caption) {
  const sep = Math.max(2.5, Math.min(3.5, 12 / components.length));
  const nodes = components.map((c, i) =>
    `\\node[box] (n${i}) ${i > 0 ? `[right of=n${i - 1}]` : ''} {${c}};`
  ).join('\n');
  const arrows = components.slice(0, -1).map((_, i) => `\\draw[arrow] (n${i}) -- (n${i + 1});`).join('\n');
  return `\\begin{figure}[h]
\\centering
\\begin{tikzpicture}[
  node distance=${sep}cm,
  box/.style={draw, rounded corners, align=center, minimum width=2.8cm, minimum height=0.85cm, fill=green!5, font=\\small},
  arrow/.style={->, thick, >=Stealth}
]
${nodes}
${arrows}
\\end{tikzpicture}
\\caption{${caption}}
\\label{fig:${id}}
\\end{figure}`;
}

function tikzLiteratureMap(components, id, caption) {
  const leaves = components.slice(0, 6);
  const angles = leaves.length <= 4
    ? [135, 45, 225, 315]
    : [90, 30, 330, 270, 210, 150];
  const nodeLines = leaves.map((c, i) =>
    `\\node[leaf] (n${i}) at (${angles[i] ?? i * 60}:2.8cm) {${c}};`
  ).join('\n');
  const arrows = leaves.map((_, i) => `\\draw[rel] (center) -- (n${i});`).join('\n');
  return `\\begin{figure}[h]
\\centering
\\begin{tikzpicture}
  \\node[draw, circle, fill=blue!10, minimum size=2cm, align=center, font=\\small] (center) {Research\\\\Gap};
  \\tikzset{leaf/.style={draw, rounded corners, align=center, minimum width=2.5cm, minimum height=0.75cm, fill=gray!5, font=\\small}}
  \\tikzset{rel/.style={<->, dashed, thick}}
${nodeLines}
${arrows}
\\end{tikzpicture}
\\caption{${caption}}
\\label{fig:${id}}
\\end{figure}`;
}

function tikzIdeaFlow(components, id, caption) {
  const sep = Math.max(2.8, Math.min(4, 14 / components.length));
  const nodes = components.map((c, i) =>
    `\\node[box] (n${i}) ${i > 0 ? `[right of=n${i - 1}]` : ''} {${c}};`
  ).join('\n');
  const arrows = components.slice(0, -1).map((_, i) => `\\draw[arrow] (n${i}) -- (n${i + 1});`).join('\n');
  return `\\begin{figure}[h]
\\centering
\\begin{tikzpicture}[
  node distance=${sep}cm,
  box/.style={draw, rounded corners, align=center, minimum width=3cm, minimum height=0.85cm, fill=purple!5, font=\\small},
  arrow/.style={->, thick, >=Stealth}
]
${nodes}
${arrows}
\\end{tikzpicture}
\\caption{${caption}}
\\label{fig:${id}}
\\end{figure}`;
}

function localFallbackGenerate(suggestion) {
  const components = (suggestion.components || []).slice(0, 8);
  const id = (suggestion.id || 'figure').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const caption = suggestion.captionDraft || 'Proposed workflow.';
  const section = suggestion.targetSection || 'Method';

  let figureLatex;
  switch (suggestion.type) {
    case 'timeline':
      figureLatex = tikzTimeline(components, id, caption); break;
    case 'literature_map':
      figureLatex = tikzLiteratureMap(components, id, caption); break;
    case 'idea_flow':
      figureLatex = tikzIdeaFlow(components, id, caption); break;
    default:
      figureLatex = tikzFlowchart(components, id, caption);
  }

  return {
    figureLatex,
    caption,
    targetSection: section,
    insertionHint: `Insert after the description in the ${section} section.`
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export async function planFigures({ project, proposalLatex, evaluationReport, reviewerCritiques }) {
  log('plan', `api=${isApiReady()} | latex=${(proposalLatex || '').length}chars | critiques=${(reviewerCritiques || []).length}`);

  if (!isApiReady()) {
    log('plan', 'local fallback');
    return { suggestions: localFallbackPlan(project, proposalLatex, reviewerCritiques), mode: 'local-fallback' };
  }

  const latex = (proposalLatex || '').length > 6000
    ? proposalLatex.slice(0, 6000) + '\n...[truncated]'
    : proposalLatex;

  const result = await callLlmJson(PLAN_PROMPT, {
    project: { topic: project?.topic, problem: project?.problem, method: project?.method, timeline: project?.timeline, evaluation: project?.evaluation, references: project?.references },
    proposalLatex: latex,
    evaluationReport: (evaluationReport || '').slice(0, 1500),
    reviewerCritiques: (reviewerCritiques || []).slice(0, 8).map(c => ({ issue: c.issue, analysis: c.analysis, targetField: c.targetField, severity: c.severity }))
  });

  const suggestions = Array.isArray(result.suggestions) ? result.suggestions : [];
  log('plan', `done | ${suggestions.length} suggestions`);
  return { suggestions, mode: 'api' };
}

export async function generateFigure({ project, proposalLatex, suggestion }) {
  log('generate', `type=${suggestion?.type} | api=${isApiReady()}`);

  if (!isApiReady()) {
    log('generate', 'local fallback');
    return { ...localFallbackGenerate(suggestion), mode: 'local-fallback' };
  }

  const latex = (proposalLatex || '').length > 5000
    ? proposalLatex.slice(0, 5000) + '\n...[truncated]'
    : proposalLatex;

  const result = await callLlmJson(GENERATE_PROMPT, {
    suggestion,
    project: { topic: project?.topic, method: project?.method },
    proposalLatex: latex
  });

  log('generate', 'done');
  return {
    figureLatex: String(result.figureLatex || ''),
    caption: String(result.caption || suggestion?.captionDraft || ''),
    targetSection: String(result.targetSection || suggestion?.targetSection || 'Method'),
    insertionHint: String(result.insertionHint || ''),
    mode: 'api'
  };
}
