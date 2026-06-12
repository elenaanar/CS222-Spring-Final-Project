function log(tag, msg) {
  console.log(`[proposal:${tag}] ${msg}`);
}

const DEFAULT_REQUIREMENTS = `Proposal must include:
- Project title
- Abstract
- Motivation and gap
- Project goal
- Method or agent workflow
- Figure or diagram with caption
- Expected results
- Research milestones with timeline estimates
- Evaluation plan
- Risks and mitigation
- Resources or budget
- References, assumptions, or source notes`;

const EMPTY_PROJECT_FOR_SERVER = {
  title: '',
  topic: '',
  problem: '',
  method: '',
  timeline: '',
  evaluation: '',
  resources: '',
  references: '',
  requirements: DEFAULT_REQUIREMENTS
};

const SYSTEM_PROMPT = `You are a research proposal writer. Your job is to turn a rough research direction into a complete, specific, academically credible research proposal in LaTeX.

The project fields you receive are ROUGH INPUTS — direction-setting notes, not final prose. Your job is to expand them into fully developed, specific content using your knowledge of the research area. Do NOT copy the field values verbatim into the proposal. Instead:
- Make claims specific to the actual topic and domain (methods, datasets, metrics, prior work)
- Replace vague phrases like "known technical limitations" with the actual limitations in this field
- Replace generic methods like "build a model" with a concrete technical approach appropriate to the topic
- Fill gaps using your knowledge of the research area, marking anything speculative as an assumption

Return strict JSON with this shape:
{
  "proposalLatex": "complete, compile-ready LaTeX source for proposal.tex",
  "complianceMatrix": [
    {
      "requirement": "requirement text",
      "status": "Covered | Needs work",
      "evidence": "short evidence",
      "fix": "short next action"
    }
  ],
  "evaluationReport": "plain text or Markdown report with missing items, weak claims, timeline risks, and revision priorities",
  "questions": ["short clarifying question"]
}

Rules:
- CRITICAL: The proposal must be about the user's stated research topic from roughInputs. It must NOT describe or reference the proposal-generation software, workflow app, or any tool used to create it.
- Do not include phrases like "proposal agent", "proposal generator", "workflow app", "classroom demo", "compliance matrix", or "API-backed generator" anywhere in the proposal body.
- The proposal must read like a real academic research proposal with specific claims, not a template skeleton.
- The proposal artifact must be LaTeX, not Markdown.
- Return a complete LaTeX document with \\documentclass[11pt]{article}, 1-inch margins, title, sections, and bibliography/source notes.
- Use compile-safe LaTeX. Avoid minted, shell-escape, external images, custom fonts, or packages that require extra system tools.
- Do not use \\includegraphics or reference external image files. Build figures directly in LaTeX with text boxes, minipages, tabular layouts, lists, or simple arrows.
- Keep the proposed research plan credible, appropriately scoped, and supported by milestones, resources, risks, and evaluation criteria.
- Mark unsupported claims as assumptions rather than inventing citations.
- Include at least one LaTeX-native figure, diagram, workflow chart, or architecture sketch with a caption.
- If literatureContext.selectedPapers are provided, reference only those papers for claims they actually support. Do not invent citation details or author names.
- If literatureContext.continuationIdeas are provided, use them to frame the motivation and gap sections. Use cautious language: "this work builds on limitations noted in prior work" rather than "no prior work exists" or "this is the first."
- Avoid absolute novelty claims. Use language like "this proposal addresses a direction suggested by prior work" or "we explore an extension identified in the literature."`;

const QUESTION_SYSTEM_PROMPT = `You are running an interactive proposal-agent workflow.

Return strict JSON:
{
  "project": {
    "title": "",
    "problem": "",
    "method": "",
    "timeline": "",
    "evaluation": "",
    "resources": "",
    "references": ""
  },
  "fieldSuggestions": [
    {
      "field": "title | problem | method | timeline | evaluation | resources | references",
      "label": "human-readable label",
      "value": "specific suggested content",
      "confidence": "High | Medium | Low",
      "reason": "why this suggestion fits the rough idea"
    }
  ],
  "decisions": [
    {
      "id": "short-stable-id",
      "title": "decision title",
      "field": "problem | method | timeline | evaluation | resources | references",
      "question": "context-aware decision prompt",
      "options": [
        {
          "label": "short option label",
          "value": "content to write into the project state",
          "rationale": "when this option is a good fit"
        }
      ]
    }
  ],
  "questions": [
    {
      "field": "problem | method | evaluation | timeline | resources | references",
      "question": "one concise question",
      "reason": "why this answer matters",
      "priority": "High | Medium | Low"
    }
  ],
  "updates": ["short state update"]
}

First infer concrete proposal data from the rough idea. Give the user suggested data and selectable options before asking open-ended questions. Ask open-ended questions only for information that cannot be reasonably inferred.`;

const REVIEW_CRITIQUE_PROMPT = `You are a strict Reviewer Agent for a CS research proposal.

Return strict JSON:
{
  "reviewSummary": "short paragraph",
  "critiques": [
    {
      "id": "stable short id",
      "dimension": "novelty | scope | method realism | evaluation | baselines | contribution claims | rubric",
      "issue": "specific concern",
      "analysis": "counter-argument with evidence from proposal text",
      "severity": 1,
      "targetField": "problem | method | evaluation | timeline | resources | references | title",
      "suggestedFix": "concrete actionable fix"
    }
  ]
}

Rules:
- Include these required checks: novelty, scope breadth, method realism, evaluation strength, missing baselines, and overstated contributions.
- Also include rubric alignment concerns where relevant.
- Severity is 1-5 where 5 is a glaring issue.
- Counter-argue weak claims; do not be polite filler.
- Suggest fixes, but do not force final decisions.
- Return only JSON.`;

const REVIEW_REVISE_PROMPT = `You are a revision agent that updates proposal project state based on reviewer critiques and user choices.

Return strict JSON:
{
  "project": {
    "title": "",
    "problem": "",
    "method": "",
    "timeline": "",
    "evaluation": "",
    "resources": "",
    "references": ""
  },
  "appliedChanges": ["short change note"]
}

Rules:
- Apply only selected critiques and user instruction.
- Keep scope realistic and claims defensible.
- Preserve existing useful content; edit surgically.
- Return only JSON.`;

export async function startAgentSession(payload) {
  const project = normalizePayload(payload);
  const checklist = extractChecklist(project.requirements || DEFAULT_REQUIREMENTS);
  log('startAgentSession', `topic="${project.title || project.topic}" | api=${Boolean(process.env.LLM_API_KEY && process.env.LLM_API_URL)}`);

  if (process.env.LLM_API_KEY && process.env.LLM_API_URL) {
    try {
      const result = await refineProjectWithApi({
        task: 'start',
        project,
        checklist,
        activeQuestion: null,
        answer: ''
      });

      log('startAgentSession', `LLM ok → ${result.fieldSuggestions.length} suggestions, ${result.decisions.length} decisions`);
      return {
        ...result,
        project: keepOnlyAcceptedStartFields(project, result.project),
        checklist,
        inputSummary: summarizeProjectInput(result.project),
        runMessage: `Initialized topic and prepared ${result.fieldSuggestions.length} suggested field(s) and ${result.decisions.length} decision card(s).`
      };
    } catch (error) {
      log('startAgentSession', `LLM failed, using fallback: ${error.message}`);
      return buildStartFallback(project, checklist, error);
    }
  }

  log('startAgentSession', 'no API key — using deterministic fallback');
  return buildStartFallback(project, checklist);
}

export async function answerAgentQuestion(payload) {
  const project = normalizePayload(payload.project || payload);
  const checklist = extractChecklist(project.requirements || payload.requirements || DEFAULT_REQUIREMENTS);
  const activeQuestion = normalizeQuestion(payload.question);
  const answer = clean(payload.answer);
  log('answerAgentQuestion', `integrating answer for field="${activeQuestion?.field}" answer="${answer.slice(0, 60)}..."`);

  if (process.env.LLM_API_KEY && process.env.LLM_API_URL) {
    try {
      const result = await refineProjectWithApi({
        task: 'integrate-answer',
        project,
        checklist,
        activeQuestion,
        answer
      });

      return {
        ...result,
        checklist,
        inputSummary: summarizeProjectInput(result.project),
        runMessage: result.updates.join(' ') || 'Integrated answer with model reasoning.'
      };
    } catch (error) {
      return buildAnswerFallback(project, checklist, activeQuestion, answer, error);
    }
  }

  return buildAnswerFallback(project, checklist, activeQuestion, answer);
}

export async function generateProposal(payload) {
  const project = normalizePayload(payload);
  const requirements = project.requirements || DEFAULT_REQUIREMENTS;
  const checklist = extractChecklist(requirements);
  log('generateProposal', `title="${project.title}" | api=${Boolean(process.env.LLM_API_KEY && process.env.LLM_API_URL)}`);

  if (process.env.LLM_API_KEY && process.env.LLM_API_URL) {
    try {
      const result = await generateWithApi(project, checklist);
      log('generateProposal', `LLM ok → latex=${result.proposalLatex?.length} chars, matrix=${result.complianceMatrix?.length} rows`);
      return result;
    } catch (error) {
      log('generateProposal', `LLM failed, using local fallback: ${error.message}`);
      return generateLocally(project, checklist);
    }
  }

  log('generateProposal', 'no API key — using deterministic fallback');
  return generateLocally(project, checklist);
}

const EVAL_REPORT_SYSTEM_PROMPT = `You are a research proposal quality reviewer. You will receive an existing LaTeX proposal and the project inputs used to generate it. Your job is to assess the proposal quality and return ONLY the evaluation fields — do NOT rewrite or reproduce the LaTeX.

Return strict JSON with this exact shape:
{
  "evaluationReport": "Markdown report: summary, weak claims, gaps, timeline risks, revision priorities",
  "complianceMatrix": [
    { "requirement": "requirement text", "status": "Covered | Needs work", "evidence": "brief evidence from the proposal", "fix": "brief next action" }
  ],
  "questions": ["short clarifying question"]
}

Rules:
- evaluationReport must be Markdown (headers, bullets). Include: Summary, Weak Claims, Missing Sections, Revision Priorities.
- complianceMatrix must cover every item in the provided checklist.
- questions should be 0–5 remaining clarifying questions about the project.
- Do NOT return proposalLatex. Do NOT reproduce any LaTeX.`;

export async function generateEvalReport(payload) {
  const project = normalizePayload(payload.project || payload);
  const proposalLatex = clean(payload.proposalLatex) || '';
  const checklist = extractChecklist(project.requirements || DEFAULT_REQUIREMENTS);
  log('generateEvalReport', `title="${project.title}" | latex=${proposalLatex.length} chars | api=${Boolean(process.env.LLM_API_KEY && process.env.LLM_API_URL)}`);

  if (process.env.LLM_API_KEY && process.env.LLM_API_URL) {
    try {
      const model = clean(process.env.LLM_MODEL) || 'gpt-4o-mini';
      const promptPayload = {
        task: 'eval-report',
        project: {
          title: project.title,
          topic: project.topic,
          problem: project.problem,
          method: project.method,
          timeline: project.timeline,
          evaluation: project.evaluation
        },
        proposalLatex: truncateForModel(proposalLatex, 8000),
        checklist
      };
      const content = await callModel({ systemPrompt: EVAL_REPORT_SYSTEM_PROMPT, payload: promptPayload, model, temperature: 0.1 });
      const parsed = parseJsonContent(content);
      const evalReport = clean(parsed.evaluationReport) || '# Evaluation Report\n\nNo report returned.';
      const matrix = Array.isArray(parsed.complianceMatrix) && parsed.complianceMatrix.length
        ? parsed.complianceMatrix.map((row) => ({
          requirement: clean(row.requirement),
          status: clean(row.status) || 'Needs work',
          evidence: clean(row.evidence),
          fix: clean(row.fix)
        }))
        : [];
      const questions = Array.isArray(parsed.questions) ? parsed.questions.map(clean).filter(Boolean).slice(0, 5) : [];
      return { mode: 'api', provider: process.env.LLM_API_URL, evaluationReport: evalReport, complianceMatrix: matrix, questions };
    } catch (error) {
      log('generateEvalReport', `LLM failed, using local fallback: ${error.message}`);
    }
  }

  // Local fallback — deterministic assessment
  const localResult = generateLocally(project, checklist);
  return { mode: 'local-fallback', provider: 'template', evaluationReport: localResult.evaluationReport, complianceMatrix: localResult.complianceMatrix, questions: localResult.questions };
}

export async function critiqueProposal(payload) {
  log('critiqueProposal', `title="${payload.project?.title || payload.topic}" | api=${Boolean(process.env.LLM_API_KEY && process.env.LLM_API_URL)}`);
  const project = normalizePayload(payload.project || payload);
  const checklist = extractChecklist(project.requirements || DEFAULT_REQUIREMENTS);
  const proposalLatex = clean(payload.proposalLatex);
  const evaluationReport = clean(payload.evaluationReport);
  const priorCritiques = Array.isArray(payload.priorCritiques) ? payload.priorCritiques : [];

  if (process.env.LLM_API_KEY && process.env.LLM_API_URL) {
    try {
      return await critiqueWithApi({ project, checklist, proposalLatex, evaluationReport, priorCritiques });
    } catch {
      return critiqueLocally({ project, checklist, proposalLatex, evaluationReport, priorCritiques });
    }
  }

  return critiqueLocally({ project, checklist, proposalLatex, evaluationReport, priorCritiques });
}

export async function reviseProposalFromCritique(payload) {
  log('reviseProposalFromCritique', `${payload.selectedCritiques?.length || 0} critiques selected, userInstruction="${(payload.userInstruction || '').slice(0, 60)}"`);
  const project = normalizePayload(payload.project || payload);
  const selectedCritiques = Array.isArray(payload.selectedCritiques) ? payload.selectedCritiques : [];
  const userInstruction = clean(payload.userInstruction);

  if (process.env.LLM_API_KEY && process.env.LLM_API_URL) {
    try {
      return await reviseWithApi({ project, selectedCritiques, userInstruction });
    } catch {
      return reviseLocally({ project, selectedCritiques, userInstruction });
    }
  }

  return reviseLocally({ project, selectedCritiques, userInstruction });
}

async function critiqueWithApi({ project, checklist, proposalLatex, evaluationReport, priorCritiques }) {
  const model = clean(process.env.LLM_MODEL);
  if (!model) {
    throw new Error('LLM_MODEL is required when LLM_API_KEY and LLM_API_URL are configured.');
  }

  const payload = {
    project,
    checklist,
    proposalLatex: truncateForModel(proposalLatex, 12000),
    evaluationReport: truncateForModel(evaluationReport, 6000),
    priorCritiqueCount: priorCritiques.length,
    requiredChecks: [
      'Is the question actually novel?',
      'Is the scope too broad?',
      'Is the method realistic?',
      'Is the evaluation convincing?',
      'Are there missing baselines?',
      'Are the expected contributions overstated?'
    ]
  };

  const content = await callModel({
    systemPrompt: REVIEW_CRITIQUE_PROMPT,
    payload,
    model,
    temperature: 0.2
  });

  const parsed = parseJsonContent(content);
  const critiques = normalizeReviewCritiques(parsed.critiques);

  return {
    mode: 'api',
    provider: process.env.LLM_API_URL,
    reviewSummary: clean(parsed.reviewSummary) || 'Reviewer identified risks and revision opportunities.',
    critiques,
    transcript: {
      prompt: payload,
      rawResponse: content
    }
  };
}

function critiqueLocally({ project, checklist, priorCritiques }) {
  const critiques = buildLocalReviewCritiques(project, checklist, priorCritiques);

  return {
    mode: 'local-fallback',
    provider: 'template',
    reviewSummary: 'Local reviewer found proposal-strengthening opportunities across novelty, scope, method, evaluation, and contribution claims.',
    critiques,
    transcript: {
      prompt: { project, checklist, priorCritiquesCount: priorCritiques.length },
      rawResponse: 'Generated by local fallback reviewer.'
    }
  };
}

async function reviseWithApi({ project, selectedCritiques, userInstruction }) {
  const model = clean(process.env.LLM_MODEL);
  if (!model) {
    throw new Error('LLM_MODEL is required when LLM_API_KEY and LLM_API_URL are configured.');
  }

  const payload = {
    project,
    selectedCritiques,
    userInstruction
  };

  const content = await callModel({
    systemPrompt: REVIEW_REVISE_PROMPT,
    payload,
    model,
    temperature: 0.2
  });

  const parsed = parseJsonContent(content);
  const revisedProject = mergeProject(project, normalizePayload(parsed.project || {}));
  const appliedChanges = Array.isArray(parsed.appliedChanges) ? parsed.appliedChanges.map(clean).filter(Boolean) : [];

  return {
    mode: 'api',
    provider: process.env.LLM_API_URL,
    project: { ...revisedProject, literatureContext: project.literatureContext },
    appliedChanges: appliedChanges.length ? appliedChanges : ['Applied selected reviewer critiques.'],
    runMessage: 'Applied selected critique fixes to project state.',
    transcript: {
      prompt: payload,
      rawResponse: content
    }
  };
}

function reviseLocally({ project, selectedCritiques, userInstruction }) {
  const nextProject = { ...project };
  const appliedChanges = [];

  selectedCritiques.forEach((critique) => {
    const targetField = normalizeRevisionField(critique.targetField);
    const suggestion = clean(critique.suggestedFix);
    if (!targetField || !suggestion) return;

    nextProject[targetField] = mergeField(nextProject[targetField], suggestion);
    appliedChanges.push(`Updated ${targetField}: ${suggestion}`);
  });

  if (userInstruction) {
    nextProject.method = mergeField(nextProject.method, userInstruction);
    appliedChanges.push('Integrated user revision note into method.');
  }

  return {
    mode: 'local-fallback',
    provider: 'template',
    project: { ...nextProject, literatureContext: project.literatureContext },
    appliedChanges: appliedChanges.length ? appliedChanges : ['No critique selected. Project state unchanged.'],
    runMessage: 'Applied local revision pass from selected critique items.'
  };
}

function normalizeReviewCritiques(critiques) {
  if (!Array.isArray(critiques)) {
    return [];
  }

  return critiques
    .map((item, index) => ({
      id: clean(item.id) || `critique-${index + 1}`,
      question: clean(item.question) || reviewQuestionFromDimension(item.dimension),
      title: clean(item.issue) || clean(item.title) || 'Reviewer concern',
      analysis: clean(item.analysis) || 'The reviewer found this part under-justified.',
      severity: clampNumber(item.severity, 1, 5, 3),
      targetField: normalizeRevisionField(item.targetField),
      suggestedFix: clean(item.suggestedFix) || 'Revise this section with a more concrete and testable claim.',
      dimension: clean(item.dimension) || 'rubric'
    }))
    .filter((item) => item.question || item.title)
    .sort((a, b) => Number(b.severity || 0) - Number(a.severity || 0));
}

function reviewQuestionFromDimension(value) {
  const dimension = clean(value).toLowerCase();
  if (dimension.includes('novel')) return 'Is the question actually novel?';
  if (dimension.includes('scope')) return 'Is the scope too broad?';
  if (dimension.includes('method')) return 'Is the method realistic?';
  if (dimension.includes('evaluation')) return 'Is the evaluation convincing?';
  if (dimension.includes('baseline')) return 'Are there missing baselines?';
  if (dimension.includes('contribution')) return 'Are the expected contributions overstated?';
  return 'What is the strongest remaining weakness in this proposal?';
}

function normalizeRevisionField(field) {
  const value = clean(field).toLowerCase();
  const allowed = new Set(['title', 'problem', 'method', 'timeline', 'evaluation', 'resources', 'references']);
  return allowed.has(value) ? value : 'method';
}

function buildLocalReviewCritiques(project, checklist, priorCritiques) {
  const critiques = [];
  const seen = new Set((Array.isArray(priorCritiques) ? priorCritiques : []).map((item) => clean(item.id)));

  const noveltyMissing = clean(project.references).length < 60;
  critiques.push({
    id: 'novelty-check',
    question: 'Is the question actually novel?',
    title: noveltyMissing ? 'Novelty is weakly supported by prior work' : 'Novelty claim needs sharper contrast',
    analysis: noveltyMissing
      ? 'The proposal does not clearly establish what prior work exists and where the gap is.'
      : 'Novelty appears plausible but should be stated against explicit baseline approaches.',
    severity: noveltyMissing ? 5 : 3,
    targetField: 'references',
    suggestedFix: 'Add 2-3 concrete prior-work comparisons and one sentence stating the precise novelty delta.',
    dimension: 'novelty'
  });

  const scopeBroad = clean(project.problem).length > 300 || /all|across all|comprehensive|entire/.test(clean(project.problem).toLowerCase());
  critiques.push({
    id: 'scope-check',
    question: 'Is the scope too broad?',
    title: scopeBroad ? 'Scope is too broad for the timeline' : 'Scope is acceptable but could be tighter',
    analysis: scopeBroad
      ? 'Current framing attempts too many subproblems for one proposal cycle.'
      : 'Scope is mostly reasonable but boundaries and exclusions should be explicit.',
    severity: scopeBroad ? 4 : 2,
    targetField: 'problem',
    suggestedFix: 'Narrow to one main task, one target setting, and one primary success criterion.',
    dimension: 'scope'
  });

  const methodWeak = clean(project.method).length < 120;
  critiques.push({
    id: 'method-check',
    question: 'Is the method realistic?',
    title: methodWeak ? 'Method is underspecified' : 'Method is plausible but operational details are thin',
    analysis: methodWeak
      ? 'The method does not define a concrete stage-by-stage execution plan.'
      : 'Method could better describe constraints, fallback behavior, and stopping criteria.',
    severity: methodWeak ? 4 : 3,
    targetField: 'method',
    suggestedFix: 'Specify critique->change loop steps, artifacts produced per step, and stop conditions for user satisfaction.',
    dimension: 'method realism'
  });

  const evalWeak = clean(project.evaluation).length < 130;
  critiques.push({
    id: 'evaluation-check',
    question: 'Is the evaluation convincing?',
    title: evalWeak ? 'Evaluation lacks measurable acceptance criteria' : 'Evaluation needs stronger evidence thresholds',
    analysis: evalWeak
      ? 'Evaluation plan does not state concrete metrics or thresholds.'
      : 'Evaluation has metrics, but before/after expectations and failure criteria are vague.',
    severity: evalWeak ? 5 : 3,
    targetField: 'evaluation',
    suggestedFix: 'Add rubric-based before/after metrics, baseline comparisons, and explicit pass/fail thresholds.',
    dimension: 'evaluation'
  });

  const baselineMissing = !/baseline|comparison|prior/i.test(`${project.evaluation} ${project.references}`);
  critiques.push({
    id: 'baseline-check',
    question: 'Are there missing baselines?',
    title: baselineMissing ? 'Baseline comparisons are missing' : 'Baselines exist but should be expanded',
    analysis: baselineMissing
      ? 'No clear baseline is defined for judging improvement.'
      : 'Baselines are present but should include a stronger external comparator.',
    severity: baselineMissing ? 4 : 2,
    targetField: 'evaluation',
    suggestedFix: 'Define at least one deterministic baseline and one prior workflow baseline.',
    dimension: 'baselines'
  });

  const overstated = /always|guarantee|perfect|state of the art|fully/.test(`${project.problem} ${project.evaluation}`.toLowerCase());
  critiques.push({
    id: 'contribution-check',
    question: 'Are the expected contributions overstated?',
    title: overstated ? 'Contribution claims are overstated' : 'Contribution claims are mostly plausible',
    analysis: overstated
      ? 'Claims exceed what current method and evaluation can support.'
      : 'Claims are plausible but should explicitly note assumptions and limits.',
    severity: overstated ? 4 : 2,
    targetField: 'problem',
    suggestedFix: 'Rephrase contributions as scoped, testable outcomes and add explicit limitations.',
    dimension: 'contribution claims'
  });

  const rubricCoverage = checklist.filter((item) => findRequirementEvidence(item, project)).length;
  if (rubricCoverage < Math.max(3, checklist.length - 3)) {
    critiques.push({
      id: 'rubric-check',
      question: 'Does the draft fully satisfy rubric expectations?',
      title: 'Rubric coverage is incomplete',
      analysis: `Only ${rubricCoverage}/${checklist.length} requirement hints appear covered in the current project state.`,
      severity: 4,
      targetField: 'method',
      suggestedFix: 'Add a rubric checklist subsection in evaluation that verifies each required component before final export.',
      dimension: 'rubric'
    });
  }

  const normalized = normalizeReviewCritiques(critiques).filter((item) => !seen.has(item.id));
  return normalized.length ? normalized : normalizeReviewCritiques(critiques);
}

function truncateForModel(value, max) {
  const text = clean(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}...`;
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function buildStartFallback(project, checklist, apiError) {
  const questions = buildQuestionObjects(project);
  const fieldSuggestions = buildFieldSuggestions(project);
  const decisions = buildDecisionCards(project);
  const failureNote = apiError ? ` API fallback trigger: ${clean(apiError.message || String(apiError))}.` : '';

  return {
    mode: 'local-fallback',
    provider: 'template',
    project,
    checklist,
    suggestedProject: projectFromSuggestions(project, fieldSuggestions),
    fieldSuggestions,
    decisions,
    questions,
    inputSummary: summarizeProjectInput(project),
    updates: [`Initialized topic: ${project.title}.`],
    runMessage: `Initialized topic and prepared ${fieldSuggestions.length} fallback suggestion(s).${failureNote}`,
    transcript: {
      prompt: { task: 'start', project, checklist },
      rawResponse: apiError
        ? `API call failed and local fallback was used. ${clean(apiError.message || String(apiError))}`
        : 'Generated by local fallback because LLM_API_KEY or LLM_API_URL is not configured.'
    }
  };
}

function buildAnswerFallback(project, checklist, activeQuestion, answer, apiError) {
  const integration = integrateAnswerLocally(project, answer, activeQuestion);
  const questions = buildQuestionObjects(integration.project);
  const failureNote = apiError ? ` API fallback trigger: ${clean(apiError.message || String(apiError))}.` : '';

  return {
    mode: 'local-fallback',
    provider: 'template',
    project: integration.project,
    checklist,
    suggestedProject: projectFromSuggestions(integration.project, buildFieldSuggestions(integration.project)),
    fieldSuggestions: buildFieldSuggestions(integration.project),
    decisions: buildDecisionCards(integration.project),
    questions,
    inputSummary: summarizeProjectInput(integration.project),
    updates: integration.updates,
    runMessage: `${integration.updates.join(' ')} ${questions.length} follow-up question(s) remain.${failureNote}`.trim(),
    transcript: {
      prompt: { task: 'integrate-answer', project, activeQuestion, answer, checklist },
      rawResponse: apiError
        ? `API call failed and local fallback was used. ${clean(apiError.message || String(apiError))}`
        : 'Integrated by local fallback because LLM_API_KEY or LLM_API_URL is not configured.'
    }
  };
}

async function refineProjectWithApi(payload) {
  const model = clean(process.env.LLM_MODEL);

  if (!model) {
    throw new Error('LLM_MODEL is required when LLM_API_KEY and LLM_API_URL are configured.');
  }

  const content = await callModel({
    systemPrompt: QUESTION_SYSTEM_PROMPT,
    payload,
    model,
    temperature: 0.2
  });
  const parsed = parseJsonContent(content);
  const nextProject = mergeProject(payload.project, normalizePayload(parsed.project || {}));
  const fieldSuggestions = normalizeFieldSuggestions(parsed.fieldSuggestions, nextProject);
  const decisions = normalizeDecisions(parsed.decisions, nextProject);
  const questions = normalizeQuestions(parsed.questions, nextProject);

  return {
    mode: 'api',
    provider: process.env.LLM_API_URL,
    project: nextProject,
    suggestedProject: nextProject,
    fieldSuggestions,
    decisions,
    questions,
    updates: Array.isArray(parsed.updates) ? parsed.updates.map(clean).filter(Boolean) : ['Updated project state.'],
    transcript: {
      prompt: payload,
      rawResponse: content
    }
  };
}

const BANNED_PHRASES = [
  'proposal agent', 'proposal generator', 'workflow app', 'classroom demo',
  'this app', 'api-backed generator', 'the app', 'our app'
];

async function generateWithApi(project, checklist) {
  const model = clean(process.env.LLM_MODEL);

  if (!model) {
    throw new Error('LLM_MODEL is required when LLM_API_KEY and LLM_API_URL are configured.');
  }

  const litCtx = project.literatureContext || { selectedPapers: [], continuationIdeas: [], evidenceNotes: [] };

  const promptPayload = {
    roughInputs: {
      title: project.title,
      topic: project.topic,
      problem: project.problem,
      method: project.method,
      timeline: project.timeline,
      evaluation: project.evaluation,
      resources: project.resources,
      references: project.references
    },
    literatureContext: {
      selectedPapers: (litCtx.selectedPapers || []).slice(0, 10).map((p) => ({
        title: p.title,
        authors: p.authors,
        year: p.year,
        venue: p.venue,
        url: p.url,
        summary: p.summary || p.abstract
      })),
      continuationIdeas: (litCtx.continuationIdeas || []).slice(0, 5).map((idea) => ({
        title: idea.title,
        description: idea.description,
        possibleResearchQuestion: idea.possibleResearchQuestion || idea.researchQuestion,
        possibleMethod: idea.possibleMethod || '',
        basedOnPapers: idea.basedOnPapers || idea.supportingPaperKeys || []
      })),
      evidenceNotes: (litCtx.evidenceNotes || []).slice(0, 5)
    },
    checklist,
    instructions: 'The roughInputs fields are direction-setting notes. Expand them into a complete, specific, academically detailed research proposal about the stated research topic. Use your knowledge of the topic to add concrete methods, datasets, metrics, and prior work context. Do not copy the field values verbatim. The proposal must be about the research topic, not about any software tool.',
    outputContract: {
      proposalLatex: 'Complete compile-ready LaTeX source for proposal.tex — specific claims, real methods, concrete evaluation',
      complianceMatrix: 'Array of requirement coverage rows',
      evaluationReport: 'Plain text or Markdown self-evaluation',
      questions: 'Remaining clarifying questions'
    }
  };

  const content = await callModel({
    systemPrompt: SYSTEM_PROMPT,
    payload: promptPayload,
    model,
    temperature: 0.2
  });
  const parsed = parseJsonContent(content);
  const result = coerceResult(parsed, project, checklist);

  const latexLower = result.proposalLatex.toLowerCase();
  const foundBanned = BANNED_PHRASES.find((phrase) => latexLower.includes(phrase));

  if (foundBanned) {
    log('generateWithApi', `Banned phrase "${foundBanned}" detected — regenerating with corrective prompt`);
    const correctivePayload = {
      ...promptPayload,
      correctiveInstruction: `The previous draft incorrectly described a software tool instead of the research topic. Rewrite the entire proposal so it is ONLY about the research topic "${project.title || project.topic}". Do not mention any proposal software, agent app, or generation workflow anywhere.`
    };
    const correctedContent = await callModel({
      systemPrompt: SYSTEM_PROMPT,
      payload: correctivePayload,
      model,
      temperature: 0.1
    });
    const correctedParsed = parseJsonContent(correctedContent);
    return {
      mode: 'api',
      provider: process.env.LLM_API_URL,
      ...coerceResult(correctedParsed, project, checklist),
      transcript: { prompt: correctivePayload, rawResponse: correctedContent }
    };
  }

  return {
    mode: 'api',
    provider: process.env.LLM_API_URL,
    ...result,
    transcript: { prompt: promptPayload, rawResponse: content }
  };
}

async function callModel({ systemPrompt, payload, model, temperature }) {
  const provider = getProvider();
  const task = payload.task || (payload.project ? 'proposal' : 'unknown');
  log('callModel', `→ LLM request | model=${model} | provider=${provider} | task=${task}`);
  const t0 = Date.now();

  const result = provider === 'gemini'
    ? await callGemini({ systemPrompt, payload, model, temperature })
    : await callOpenAiCompatible({ systemPrompt, payload, model, temperature });

  log('callModel', `← LLM response | model=${model} | task=${task} | ${Date.now() - t0}ms | ${result?.length ?? 0} chars`);
  return result;
}

async function callGemini({ systemPrompt, payload, model, temperature }) {
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
        temperature,
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

  if (!content) {
    throw new Error('Gemini API returned no text content.');
  }

  return content;
}

function isCreditError(message) {
  return /requires more credits|can only afford|insufficient credits|balance|quota/i.test(message);
}

async function callOpenAiCompatible({ systemPrompt, payload, model, temperature }) {
  const makeRequest = async (modelId) => {
    const response = await fetch(process.env.LLM_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.LLM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: modelId,
        temperature,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
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
    return readModelContent(data);
  };

  try {
    return await makeRequest(model);
  } catch (error) {
    const fallbackModel = clean(process.env.LLM_FALLBACK_MODEL) || 'meta-llama/llama-3.1-8b-instruct:free';
    if (isCreditError(error.message) && fallbackModel !== model) {
      log('callOpenAiCompatible', `credit limit hit for ${model} → retrying with fallback ${fallbackModel}`);
      return await makeRequest(fallbackModel);
    }
    throw error;
  }
}

function generateLocally(project, checklist) {
  const questions = buildQuestions(project);
  const proposalLatex = buildLocalProposalLatex(project);
  const complianceMatrix = checklist.map((requirement) => {
    const evidence = findRequirementEvidence(requirement, project);

    return {
      requirement,
      status: evidence ? 'Covered' : 'Needs work',
      evidence: evidence || 'No strong evidence in the current project state.',
      fix: evidence ? 'Keep this section specific.' : `Add concrete detail for: ${requirement}.`
    };
  });

  const needsWork = complianceMatrix.filter((row) => row.status === 'Needs work');
  const evaluationReport = `# Evaluation Report

## Summary
- Mode: local deterministic fallback.
- Covered requirements: ${complianceMatrix.length - needsWork.length}/${complianceMatrix.length}.
- Remaining questions: ${questions.length}.

## Weak Claims And Risks
${needsWork.length ? needsWork.map((row) => `- ${row.requirement}: ${row.fix}`).join('\n') : '- No missing checklist items detected by the fallback checker.'}

## Revision Priorities
${questions.length ? questions.map((question) => `- ${question}`).join('\n') : '- Draft is ready for API-backed review or human revision.'}
`;

  return {
    mode: 'local-fallback',
    provider: 'template',
    proposalLatex,
    complianceMatrix,
    evaluationReport,
    questions,
    transcript: {
      prompt: { project, checklist },
      rawResponse: 'Generated by local fallback because LLM_API_KEY or LLM_API_URL is not configured.'
    }
  };
}

function buildLocalProposalLatex(project) {
  const title = project.title || project.topic || 'Research Proposal';
  const topic = project.topic || project.title || 'this research area';
  const problem = project.problem || `The specific problem within ${topic} has not yet been fully specified. This section should describe the gap, limitation, or challenge that motivates the proposed work.`;
  const method = project.method || `The proposed approach for ${topic} should be described here, including the key technical steps, tools, datasets, and any agent or automated workflow components.`;
  const evaluation = project.evaluation || `Evaluation should demonstrate that the proposed approach for ${topic} improves on existing baselines or addresses the identified gap, using appropriate metrics and test conditions.`;
  const timeline = project.timeline || 'Phase 1: literature review and problem scoping. Phase 2: method design and baseline selection. Phase 3: prototype or study implementation. Phase 4: evaluation and analysis. Phase 5: final write-up and revision.';
  const resources = project.resources || `Relevant datasets, tools, compute resources, and prior work for ${topic}.`;
  const references = project.references || 'Prior work citations and assumptions are to be completed during proposal refinement.';

  return String.raw`\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage[hidelinks]{hyperref}
\usepackage{enumitem}
\setlist{nosep}
\title{${escapeLatex(title)}}
\author{}
\date{}

\begin{document}
\maketitle

\begin{abstract}
This proposal addresses ${escapeLatex(topic)}. The following draft was generated from the current project state and should be refined with additional detail, citations, and evaluation specifics. Sections marked as assumptions require supporting evidence before submission.
\end{abstract}

\section{Motivation and Research Gap}
${latexParagraph(problem)}

\section{Project Goal}
This project aims to make a concrete contribution to ${escapeLatex(topic)} by addressing the identified gap through a well-scoped research plan with explicit milestones and evaluation criteria.

\section{Method}
${latexParagraph(method)}

\section{Expected Results and Research Milestones}
${latexParagraph(timeline)}

\section{Evaluation Plan}
${latexParagraph(evaluation)}

\section{Risks and Mitigation}
\begin{itemize}
\item Scope is too broad: narrow the research question to a single measurable contribution.
\item Data or resources are unavailable: identify alternatives early and document assumptions.
\item Claims are unsupported: mark as assumptions and add citations before submission.
\end{itemize}

\section{Resources}
${latexParagraph(resources)}

\section{References and Assumptions}
${latexParagraph(references)}

\end{document}
`;
}

function buildQuestions(project) {
  return buildQuestionObjects(project).map((question) => question.question);
}

function buildQuestionObjects(project) {
  const questions = [];
  const add = (field, question, reason, priority = 'High') => {
    questions.push({
      id: `${field}-${questions.length + 1}`,
      field,
      question,
      reason,
      priority
    });
  };

  if (!isSpecific(project.problem, 80)) {
    add(
      'problem',
      'What concrete problem does this proposal solve, and who experiences it?',
      'The proposal needs a specific motivation and user or stakeholder.'
    );
  }

  if (!isSpecific(project.method, 80)) {
    add(
      'method',
      'What exact workflow or technical method will the project implement?',
      'The method should describe stages, inputs, outputs, and the API-backed loop.'
    );
  }

  if (!isSpecific(project.evaluation, 60)) {
    add(
      'evaluation',
      'What measurable checks will prove the revised proposal is better than the first draft?',
      'The evaluation plan needs concrete tests or metrics.'
    );
  }

  if (!isSpecific(project.timeline, 40)) {
    add(
      'timeline',
      'What research milestones and timeline estimates make this proposal credible?',
      'The proposal needs scoped milestones, feasibility evidence, and realistic risks.'
    );
  }

  if (!isSpecific(project.resources, 30)) {
    add(
      'resources',
      'What tools, APIs, files, or fallback mode will make this reproducible?',
      'The proposal needs implementation resources and API-key handling.',
      'Medium'
    );
  }

  if (!isSpecific(project.references, 30)) {
    add(
      'references',
      'What sources or assumptions should ground the claims?',
      'Unsupported claims should be marked as assumptions or tied to source notes.',
      'Medium'
    );
  }

  if (!questions.length) {
    add(
      'next-step',
      'The project state looks draftable. Should I generate the proposal now?',
      'No required missing field remains in the basic checker.',
      'Low'
    );
  }

  return questions.slice(0, 5);
}

function integrateAnswerLocally(project, answer, question) {
  const targetField = question?.field && question.field !== 'next-step' ? question.field : firstMissingField(project);
  const nextProject = { ...project };
  const updates = [];

  if (targetField && Object.hasOwn(nextProject, targetField)) {
    nextProject[targetField] = mergeField(nextProject[targetField], answer);
    updates.push(`Updated ${targetField}.`);
  } else {
    nextProject.method = mergeField(nextProject.method, answer);
    updates.push('Updated method.');
  }

  return { project: nextProject, updates };
}

function buildFieldSuggestions(project) {
  const topic = project.title || project.topic || 'the research area';
  const suggestions = [
    {
      field: 'title',
      label: 'Project Title',
      value: project.title || titleCase(topic),
      confidence: 'High',
      reason: 'Use the rough idea as the working title so the proposal has a stable anchor.'
    },
    {
      field: 'problem',
      label: 'Problem Framing',
      value:
        project.problem ||
        `Existing work on ${topic} leaves an identifiable gap that this proposal aims to address. The specific limitation or unmet need should be stated with supporting evidence from the literature.`,
      confidence: project.problem ? 'High' : 'Low',
      reason: 'A proposal needs a concrete, evidence-backed motivation before method details are useful.'
    },
    {
      field: 'method',
      label: 'Research Method',
      value:
        project.method ||
        `The proposed approach will address the identified gap in ${topic} through a combination of data collection or curation, model or system design, and quantitative evaluation against relevant baselines.`,
      confidence: project.method ? 'High' : 'Low',
      reason: 'The method should specify inputs, outputs, key design choices, and how they connect to the research question.'
    },
    {
      field: 'evaluation',
      label: 'Evaluation Plan',
      value:
        project.evaluation ||
        `The proposed approach will be evaluated on appropriate metrics for ${topic}, compared against established baselines, and analyzed for failure cases and limitations.`,
      confidence: project.evaluation ? 'High' : 'Low',
      reason: 'Evaluation criteria should directly measure progress on the stated problem.'
    },
    {
      field: 'timeline',
      label: 'Research Milestones',
      value:
        project.timeline ||
        'Phase 1: literature review and problem scoping. Phase 2: method design and baseline selection. Phase 3: prototype or study implementation. Phase 4: evaluation and analysis. Phase 5: final write-up and revision.',
      confidence: project.timeline ? 'High' : 'Medium',
      reason: 'Research milestones help reviewers judge feasibility, expected outcomes, and scope.'
    },
    {
      field: 'resources',
      label: 'Resources',
      value: project.resources || `Relevant datasets, compute resources, tools, and prior work needed to execute the proposed research on ${topic}.`,
      confidence: project.resources ? 'High' : 'Low',
      reason: 'Naming specific resources makes the proposal more credible and helps identify risks early.'
    },
    {
      field: 'references',
      label: 'Sources / Assumptions',
      value: project.references || 'Key prior work citations and explicit assumptions for any claims that lack supporting evidence.',
      confidence: project.references ? 'High' : 'Low',
      reason: 'Source notes prevent the proposal from relying on unsupported claims.'
    }
  ];

  return suggestions.filter((item) => clean(item.value));
}

function buildDecisionCards(project) {
  const topic = project.title || project.topic || 'this research area';

  return [
    {
      id: 'problem-framing',
      title: 'Choose The Problem Framing',
      field: 'problem',
      question: 'Which problem framing should the proposal emphasize?',
      options: [
        {
          label: 'Gap in existing work',
          value: `Prior work on ${topic} has made progress but leaves an identifiable gap — a population, condition, modality, or scenario that has not been adequately studied or addressed.`,
          rationale: 'Best when the proposal is motivated by what the literature is missing.'
        },
        {
          label: 'Technical limitation',
          value: `Existing methods for ${topic} have known technical limitations — in accuracy, scalability, generalizability, or robustness — that a new approach could address with a concrete improvement.`,
          rationale: 'Best when the proposal argues that current techniques are insufficient.'
        },
        {
          label: 'Underexplored application',
          value: `The techniques relevant to ${topic} are established in adjacent domains but have not been seriously applied or evaluated in this specific context, leaving practical questions unanswered.`,
          rationale: 'Best when the novelty is in applying known methods to a new setting.'
        }
      ]
    },
    {
      id: 'method-style',
      title: 'Choose The Research Method',
      field: 'method',
      question: 'What research method should the proposal use?',
      options: [
        {
          label: 'Build and evaluate a system',
          value: `Design and implement a system or model for ${topic}, then evaluate it against baselines on a defined benchmark or dataset using quantitative metrics.`,
          rationale: 'Best when the contribution is a working technical artifact.'
        },
        {
          label: 'Empirical study',
          value: `Conduct a controlled empirical study on ${topic} — collecting or curating data, applying existing methods, and analyzing results to answer a specific research question.`,
          rationale: 'Best when the contribution is insight or a benchmark rather than a new model.'
        },
        {
          label: 'Survey and comparative analysis',
          value: `Systematically survey the literature on ${topic}, identify key methods and their trade-offs, and produce a comparative analysis with a clear taxonomy or evaluation framework.`,
          rationale: 'Best when the contribution is a structured synthesis of existing work.'
        }
      ]
    },
    {
      id: 'evaluation-choice',
      title: 'Choose Evaluation Evidence',
      field: 'evaluation',
      question: 'How will the proposal demonstrate a meaningful contribution?',
      options: [
        {
          label: 'Quantitative metrics',
          value: `Evaluate the proposed approach for ${topic} using quantitative metrics (e.g., accuracy, F1, BLEU, RMSE) against established baselines on a public or collected dataset.`,
          rationale: 'Best for system-building or model-training contributions.'
        },
        {
          label: 'User or human-subject study',
          value: `Conduct a user study or human evaluation to assess the quality, usefulness, or perceived improvement of the proposed approach to ${topic} relative to a comparison condition.`,
          rationale: 'Best when the contribution is an interface, tool, or subjective quality measure.'
        },
        {
          label: 'Ablation and analysis',
          value: `Evaluate the proposed approach through ablation studies and error analysis to isolate which design choices contribute to performance and where the method falls short on ${topic}.`,
          rationale: 'Best when understanding the contribution mechanistically is as important as the overall score.'
        }
      ]
    }
  ];
}

function normalizeFieldSuggestions(suggestions, project) {
  const parsed = Array.isArray(suggestions)
    ? suggestions
      .map((item) => ({
        field: clean(item.field),
        label: clean(item.label) || labelForField(item.field),
        value: clean(item.value),
        confidence: clean(item.confidence) || 'Medium',
        reason: clean(item.reason) || 'Suggested by the model from the rough idea.'
      }))
      .filter((item) => item.field && item.value)
    : [];

  const fallback = buildFieldSuggestions(project);
  const seen = new Set(parsed.map((item) => item.field));
  const merged = [...parsed, ...fallback.filter((item) => !seen.has(item.field))];

  return merged.length ? merged : fallback;
}

function normalizeDecisions(decisions, project) {
  const parsed = Array.isArray(decisions)
    ? decisions
      .map((decision, index) => ({
        id: clean(decision.id) || `decision-${index + 1}`,
        title: clean(decision.title) || 'Decision Needed',
        field: clean(decision.field) || 'problem',
        question: clean(decision.question) || 'Which option best fits the project?',
        options: Array.isArray(decision.options)
          ? decision.options
            .map((option) => ({
              label: clean(option.label),
              value: clean(option.value),
              rationale: clean(option.rationale)
            }))
            .filter((option) => option.label && option.value)
          : []
      }))
      .filter((decision) => decision.options.length)
    : [];

  return parsed.length ? parsed : buildDecisionCards(project);
}

function projectFromSuggestions(project, suggestions) {
  const next = { ...project };

  suggestions.forEach((suggestion) => {
    if (Object.hasOwn(next, suggestion.field) && suggestion.value) {
      next[suggestion.field] = suggestion.value;
    }
  });

  return next;
}

function keepOnlyAcceptedStartFields(originalProject, suggestedProject) {
  return {
    ...EMPTY_PROJECT_FOR_SERVER,
    ...originalProject,
    title: suggestedProject.title || originalProject.title,
    topic: originalProject.topic || originalProject.title,
    requirements: originalProject.requirements || DEFAULT_REQUIREMENTS
  };
}

function labelForField(field) {
  const labels = {
    title: 'Project Title',
    problem: 'Problem Framing',
    method: 'Method / Agent Workflow',
    timeline: 'Research Milestones',
    evaluation: 'Evaluation Plan',
    resources: 'Resources',
    references: 'Sources / Assumptions'
  };

  return labels[clean(field)] || titleCase(field);
}

function summarizeProjectInput(project) {
  const fields = [
    ['Topic', project.title || project.topic],
    ['Problem', project.problem],
    ['Method', project.method],
    ['Timeline', project.timeline],
    ['Evaluation', project.evaluation],
    ['Resources', project.resources],
    ['References', project.references]
  ];
  const missing = buildQuestionObjects(project)
    .filter((question) => question.field !== 'next-step')
    .map((question) => question.reason);

  return {
    fields,
    missing,
    markdown: `# Intake Summary

${fields.map(([label, value]) => `- ${label}: ${clean(value) || 'Missing'}`).join('\n')}

## Missing or Weak Inputs
${missing.length ? missing.map((item) => `- ${item}`).join('\n') : '- None detected by the basic checker.'}
`
  };
}

function normalizeQuestions(questions, project) {
  const parsed = Array.isArray(questions)
    ? questions.map(normalizeQuestion).filter((question) => question.question)
    : [];

  return (parsed.length ? parsed : buildQuestionObjects(project)).slice(0, 5);
}

function normalizeQuestion(question) {
  if (!question) return null;

  if (typeof question === 'string') {
    return {
      id: `question-${question.slice(0, 18)}`,
      field: 'method',
      question: clean(question),
      reason: 'The model requested this clarification.',
      priority: 'High'
    };
  }

  return {
    id: clean(question.id) || `${clean(question.field) || 'question'}-${clean(question.question).slice(0, 18)}`,
    field: clean(question.field) || 'method',
    question: clean(question.question),
    reason: clean(question.reason) || 'This detail will improve the proposal.',
    priority: clean(question.priority) || 'High'
  };
}

function firstMissingField(project) {
  const firstQuestion = buildQuestionObjects(project).find((question) => question.field !== 'next-step');
  return firstQuestion?.field || 'method';
}

function mergeProject(current, incoming) {
  const next = { ...current };

  Object.entries(incoming).forEach(([key, value]) => {
    const cleaned = clean(value);
    if (cleaned) next[key] = cleaned;
  });

  return next;
}

function mergeField(current, addition) {
  const base = clean(current);
  const next = clean(addition);

  if (!base) return next;
  if (!next) return base;
  if (base.toLowerCase().includes(next.toLowerCase())) return base;
  return `${base}\n${next}`;
}

function normalizePayload(payload) {
  return {
    topic: clean(payload.topic),
    title: clean(payload.title) || clean(payload.topic),
    problem: clean(payload.problem),
    method: clean(payload.method),
    timeline: clean(payload.timeline),
    evaluation: clean(payload.evaluation),
    resources: clean(payload.resources),
    references: clean(payload.references),
    requirements: clean(payload.requirements) || DEFAULT_REQUIREMENTS,
    literatureContext: normalizeLiteratureContext(payload.literatureContext)
  };
}

function normalizeLiteratureContext(ctx) {
  if (!ctx) return { selectedPapers: [], evidenceNotes: [], continuationIdeas: [], citationCandidates: [] };
  return {
    selectedPapers: Array.isArray(ctx.selectedPapers) ? ctx.selectedPapers : [],
    evidenceNotes: Array.isArray(ctx.evidenceNotes) ? ctx.evidenceNotes : [],
    continuationIdeas: Array.isArray(ctx.continuationIdeas) ? ctx.continuationIdeas : [],
    citationCandidates: Array.isArray(ctx.citationCandidates) ? ctx.citationCandidates : []
  };
}

function extractChecklist(requirements) {
  const items = clean(requirements)
    .split(/\n|;/)
    .map((line) => line.replace(/^[-*]\s*/, '').replace(/^\d+\.\s*/, '').trim())
    .filter((line) => line.length > 4)
    .filter((line) => !/^proposal must include:?$/i.test(line));

  return [...new Set(items.length ? items : DEFAULT_REQUIREMENTS.split('\n').slice(1).map((line) => line.replace(/^-\s*/, '')))];
}

function findRequirementEvidence(requirement, project) {
  const text = requirement.toLowerCase();

  if (/title/.test(text) && project.title) return project.title;
  if (/abstract/.test(text)) return 'Draft includes an abstract section.';
  if (/motivation|gap|problem/.test(text) && project.problem) return project.problem;
  if (/goal/.test(text) && project.title) return 'Goal section is generated from the project topic.';
  if (/method|workflow|approach/.test(text) && project.method) return project.method;
  if (/expected|milestone|timeline/.test(text) && project.timeline) return project.timeline;
  if (/evaluation|metric|test/.test(text) && project.evaluation) return project.evaluation;
  if (/risk|mitigation/.test(text)) return 'Fallback draft includes risks and mitigations.';
  if (/resource|budget|tool/.test(text) && project.resources) return project.resources;
  if (/reference|assumption|source/.test(text) && project.references) return project.references;

  return '';
}

function readModelContent(data) {
  if (typeof data?.choices?.[0]?.message?.content === 'string') {
    return data.choices[0].message.content;
  }

  if (typeof data?.output_text === 'string') {
    return data.output_text;
  }

  const outputText = data?.output
    ?.flatMap((item) => item?.content || [])
    ?.map((item) => item?.text)
    ?.filter(Boolean)
    ?.join('\n');

  if (outputText) return outputText;

  return JSON.stringify(data);
}

function parseJsonContent(content) {
  const trimmed = clean(content);

  // 1. Try fenced code block first
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try { return JSON.parse(fenced[1]); } catch { /* fall through */ }
  }

  // 2. Try the raw content directly
  try { return JSON.parse(trimmed); } catch { /* fall through */ }

  // 3. Try to find the outermost {...} block (handles prose wrapping the JSON)
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* fall through */ }
  }

  // 4. LaTeX escape fallback — the most common failure mode: the LLM embeds a LaTeX
  //    document inside JSON but doesn't escape backslashes/quotes, making JSON.parse fail.
  //    Extract the LaTeX document directly via regex, then try to parse the rest.
  const latexMatch = trimmed.match(/\\documentclass[\s\S]*?\\end\{document\}/i);
  if (latexMatch) {
    const extractedLatex = latexMatch[0];
    // Strip the LaTeX out and try to parse the remaining JSON fields
    const withoutLatex = trimmed.replace(latexMatch[0], '""');
    let extras = {};
    try {
      const partial = JSON.parse(withoutLatex.slice(withoutLatex.indexOf('{')));
      extras = partial;
    } catch { /* best effort */ }
    log('parseJsonContent', `JSON parse failed but recovered LaTeX (${extractedLatex.length} chars) via regex`);
    return {
      proposalLatex: extractedLatex,
      complianceMatrix: extras.complianceMatrix || [],
      evaluationReport: extras.evaluationReport || '# Evaluation Report\n\nRecovered LaTeX from malformed response. Compliance details unavailable.',
      questions: extras.questions || []
    };
  }

  // 5. If it looks like raw LaTeX with no JSON at all, salvage the LaTeX
  if (looksLikeLatex(trimmed)) {
    log('parseJsonContent', 'Response is raw LaTeX without JSON wrapper — salvaging');
    return {
      proposalLatex: trimmed,
      complianceMatrix: [],
      evaluationReport: '# Evaluation Report\n\nModel returned raw LaTeX without JSON wrapper. Regenerate or check model output format.',
      questions: []
    };
  }

  log('parseJsonContent', `Parse failed entirely. Raw response (first 500 chars): ${trimmed.slice(0, 500)}`);
  return {
    proposalLatex: '',
    complianceMatrix: [],
    evaluationReport: '# Evaluation Report\n\nThe model response could not be parsed. Try regenerating.',
    questions: []
  };
}

function coerceResult(result, project, checklist) {
  return {
    proposalLatex: extractProposalLatex(result, project),
    complianceMatrix: Array.isArray(result.complianceMatrix) && result.complianceMatrix.length
      ? result.complianceMatrix.map((row) => ({
        requirement: clean(row.requirement),
        status: clean(row.status) || 'Needs work',
        evidence: clean(row.evidence),
        fix: clean(row.fix)
      }))
      : checklist.map((requirement) => ({
        requirement,
        status: 'Needs work',
        evidence: 'API did not provide matrix evidence.',
        fix: 'Regenerate with stricter output instructions.'
      })),
    evaluationReport: clean(result.evaluationReport) || '# Evaluation Report\n\nNo evaluation report returned.',
    questions: Array.isArray(result.questions) ? result.questions.map(clean).filter(Boolean).slice(0, 5) : []
  };
}

function extractProposalLatex(result, project) {
  const candidates = [
    result?.proposalLatex,
    result?.proposalTex,
    result?.latex,
    result?.tex
  ]
    .map(clean)
    .filter(Boolean);

  for (const candidate of candidates) {
    const unwrapped = unwrapLatexCandidate(candidate);
    if (looksLikeLatex(unwrapped)) {
      return unwrapped;
    }
  }

  return buildLocalProposalLatex(project);
}

function unwrapLatexCandidate(value) {
  let candidate = stripCodeFence(clean(value));

  for (let index = 0; index < 3; index += 1) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('"')) break;

    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        candidate = stripCodeFence(parsed);
        continue;
      }

      const nested = parsed?.proposalLatex || parsed?.proposalTex || parsed?.latex || parsed?.tex;
      if (nested) {
        candidate = stripCodeFence(String(nested));
        continue;
      }

      break;
    } catch {
      const extracted = extractNestedLatexString(trimmed);
      if (extracted) {
        candidate = stripCodeFence(extracted);
        continue;
      }
      break;
    }
  }

  return candidate;
}

function stripCodeFence(value) {
  const trimmed = clean(value);
  const fenced = trimmed.match(/```(?:latex|tex)?\s*([\s\S]*?)```/i);
  return fenced?.[1]?.trim() || trimmed;
}

function isSpecific(value, length) {
  return clean(value).length >= length;
}

function clean(value) {
  return String(value || '').trim();
}

function looksLikeLatex(value) {
  return /^\\(?:documentclass\b|begin\{document\}|section\{)/.test(String(value || '').trim());
}

function extractNestedLatexString(value) {
  const match = String(value || '').match(/"proposalLatex"\s*:\s*"([\s\S]*?)"\s*,\s*"(?:complianceMatrix|evaluationReport|questions)"/);

  if (!match?.[1]) {
    return '';
  }

  return match[1]
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function latexParagraph(value) {
  return escapeLatex(value)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n\n');
}

function escapeLatex(value) {
  return String(value || '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

function getProvider() {
  const provider = clean(process.env.LLM_PROVIDER).toLowerCase();
  const url = clean(process.env.LLM_API_URL).toLowerCase();

  if (provider === 'gemini' || url.includes('generativelanguage.googleapis.com')) {
    return 'gemini';
  }

  return 'openai-compatible';
}

function titleCase(value) {
  return clean(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}
