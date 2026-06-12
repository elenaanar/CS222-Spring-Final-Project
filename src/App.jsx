import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  Download,
  FileText,
  ListChecks,
  Loader2,
  Play,
  RefreshCw,
  Send,
  Sparkles,
  X
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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

const EMPTY_LITERATURE_CONTEXT = {
  selectedPapers: [],
  evidenceNotes: [],
  continuationIdeas: [],
  citationCandidates: []
};

const EMPTY_PROJECT = {
  title: '',
  topic: '',
  problem: '',
  method: '',
  timeline: '',
  evaluation: '',
  resources: '',
  references: '',
  requirements: DEFAULT_REQUIREMENTS,
  literatureContext: EMPTY_LITERATURE_CONTEXT
};

const PROJECT_FIELDS = [
  ['problem', 'Problem'],
  ['method', 'Method'],
  ['evaluation', 'Evaluation'],
  ['timeline', 'Timeline'],
  ['resources', 'Resources'],
  ['references', 'Sources']
];

const STAGES = [
  ['1', 'Extract', 'LLM turns the rough idea into structured proposal data'],
  ['2', 'Decide', 'You choose or edit candidate framings'],
  ['3', 'Assemble', 'Accepted fields become project state'],
  ['4', 'Draft', 'LLM writes proposal artifacts'],
  ['5', 'Review', 'Matrix and critique check weak spots']
];


const MEMORY_KEY = 'proposal-agent-final-project-memory-v1';
const EMPTY_LITERATURE = {
  topic: '',
  mode: 'idle',
  provider: '',
  queriesEnhanced: false,
  queries: [],
  papers: [],
  sourceStats: { semanticScholar: 0, arxiv: 0 },
  dedupeStats: { raw: 0, unique: 0 }
};

const EMPTY_GAP_RESULT = {
  topic: '',
  paperCount: 0,
  paperAnalyses: [],
  explorationChecks: [],
  rankedGaps: [],
  runMessage: ''
};

const EMPTY_REVIEW_CYCLE = {
  rounds: [],
  selectedCritiqueIds: [],
  userInstruction: ''
};

function App() {
  const [topicInput, setTopicInput] = useState('');
  const [project, setProject] = useState(EMPTY_PROJECT);
  const [fieldSuggestions, setFieldSuggestions] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [customNote, setCustomNote] = useState('');
  const [result, setResult] = useState(null);
  const [pdfUrl, setPdfUrl] = useState('');
  const [runLog, setRunLog] = useState([]);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('evaluation');
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [decisionIndex, setDecisionIndex] = useState(0);
  const [memorySavedAt, setMemorySavedAt] = useState('');
  const [memoryReady, setMemoryReady] = useState(false);
  const [activeStage, setActiveStage] = useState(0);
  const [literature, setLiterature] = useState(EMPTY_LITERATURE);
  const [selectedPaperIds, setSelectedPaperIds] = useState([]);
  const [selectedPapersOpen, setSelectedPapersOpen] = useState(false);
  const [activeSelectedPaperId, setActiveSelectedPaperId] = useState('');
  const [gapStatus, setGapStatus] = useState('idle');
  const [gapResult, setGapResult] = useState(EMPTY_GAP_RESULT);
  const [selectedGapId, setSelectedGapId] = useState('');
  const [reviewStatus, setReviewStatus] = useState('idle');
  const [reviewCycle, setReviewCycle] = useState(EMPTY_REVIEW_CYCLE);
  const [enhanceQueriesWithAI, setEnhanceQueriesWithAI] = useState(false);

  const abortRef = useRef(null);
  const gapAbortRef = useRef(null);
  const reviewAbortRef = useRef(null);
  const evalReportAbortRef = useRef(null);
  const [evalReportStatus, setEvalReportStatus] = useState('idle');
  const [latexEditorValue, setLatexEditorValue] = useState('');
  const [latexExportStatus, setLatexExportStatus] = useState('idle');

  const litCtx = (proj) => proj.literatureContext || EMPTY_LITERATURE_CONTEXT;

  const matrixStats = useMemo(() => {
    const rows = result?.complianceMatrix || [];
    const covered = rows.filter((row) => /^covered$/i.test(row.status)).length;
    return { covered, total: rows.length };
  }, [result]);

  const acceptedCount = PROJECT_FIELDS.filter(([field]) => Boolean(project[field])).length;
  const acceptedSuggestionCount = fieldSuggestions.filter((suggestion) =>
    suggestionIsAccepted(project[suggestion.field], suggestion.value)
  ).length;
  const currentSuggestion = fieldSuggestions[suggestionIndex] || null;
  const currentDecision = decisions[decisionIndex] || null;
  const currentQuestion = questions[0];
  const selectedPaperCount = selectedPaperIds.length;
  const allPapersSelected = literature.papers.length > 0 && selectedPaperCount === literature.papers.length;
  const hasStructuredData = Boolean(fieldSuggestions.length || decisions.length || acceptedCount || result || literature.papers.length);
  const hasDraftInputs = Boolean(acceptedCount || project.title);
  const hasDraftResult = Boolean(result);
  const maxUnlockedStage = hasDraftResult ? 4 : hasDraftInputs ? 3 : hasStructuredData ? 2 : 0;
  const visibleStageCount = Math.min(STAGES.length, maxUnlockedStage + 2);
  const selectedPapers = useMemo(() => {
    const idSet = new Set(selectedPaperIds);

    return (literature.papers || [])
      .filter((paper) => idSet.has(paperStableId(paper)))
      .sort((a, b) => Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0));
  }, [literature.papers, selectedPaperIds]);
  const activeSelectedPaper = selectedPapers.find((paper) => paperStableId(paper) === activeSelectedPaperId) || selectedPapers[0] || null;
  const activeGap = (gapResult.rankedGaps || []).find((gap) => gap.id === selectedGapId) || null;
  const latestReviewRound = reviewCycle.rounds[reviewCycle.rounds.length - 1] || null;
  const selectedCritiques = (latestReviewRound?.critiques || []).filter((critique) => reviewCycle.selectedCritiqueIds.includes(critique.id));

  useEffect(() => {
    loadSavedMemory({ silent: true });
    setMemoryReady(true);
  }, []);

  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    };
  }, [pdfUrl]);

  useEffect(() => {
    if (!selectedPapers.length) {
      setSelectedPapersOpen(false);
      setActiveSelectedPaperId('');
      return;
    }

    if (!selectedPapers.some((paper) => paperStableId(paper) === activeSelectedPaperId)) {
      setActiveSelectedPaperId(paperStableId(selectedPapers[0]));
    }
  }, [selectedPapers, activeSelectedPaperId]);

  useEffect(() => {
    if (activeStage > maxUnlockedStage) {
      setActiveStage(maxUnlockedStage);
    }
  }, [activeStage, maxUnlockedStage]);

  // Sync editor when a new proposal is generated (but not while user is editing)
  useEffect(() => {
    if (result?.proposalLatex) {
      setLatexEditorValue(result.proposalLatex);
    }
  }, [result?.proposalLatex]);


  useEffect(() => {
    if (!memoryReady) return;

    if (!topicInput && !fieldSuggestions.length && !decisions.length && !result && !literature.papers.length && !selectedPaperIds.length) {
      return;
    }

    saveMemory({ silent: true });
  }, [
    memoryReady,
    topicInput,
    project,
    fieldSuggestions,
    decisions,
    questions,
    result,
    literature,
    selectedPaperIds,
    gapResult,
    reviewCycle,
    runLog,
    activeTab,
    suggestionIndex,
    decisionIndex,
    activeStage
  ]);

  async function startAgent() {
    return startAgentForTopic(topicInput);
  }

  async function startSampleAgent() {
    const sampleTopic = 'Citation-grounded agent for literature review workflows';
    setTopicInput(sampleTopic);
    return startAgentForTopic(sampleTopic);
  }

  async function startAgentForTopic(nextTopic) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus('starting');
    setError('');
    clearArtifacts();

    try {
      const data = await postJson('/api/agent/start', {
        topic: nextTopic,
        requirements: DEFAULT_REQUIREMENTS
      }, controller.signal);

      setProject({ ...EMPTY_PROJECT, ...data.project });
      setFieldSuggestions(data.fieldSuggestions || []);
      setDecisions(data.decisions || []);
      setQuestions(data.questions || []);
      setSuggestionIndex(0);
      setDecisionIndex(0);
      setRunLog([
        logEntry('Extract', data.runMessage || 'LLM prepared structured suggestions.'),
        logEntry('Decide', `Review ${(data.fieldSuggestions || []).length} fields and ${(data.decisions || []).length} decision card(s).`)
      ]);

      const literatureData = await postJson('/api/literature', {
        topic: nextTopic,
        queryCount: 3,
        maxPerQuery: 12,
        topPapers: 36,
        enhanceWithAI: enhanceQueriesWithAI
      }, controller.signal);
      setLiterature({ ...EMPTY_LITERATURE, ...literatureData });
      setSelectedPaperIds([]);
      setGapResult(EMPTY_GAP_RESULT);
      setSelectedGapId('');
      setRunLog((current) => [
        ...current,
        logEntry('Explore', `Retrieved ${literatureData.papers?.length || 0} deduplicated papers from ${literatureData.queries?.length || 0} query rewrites.`)
      ]);
      setActiveStage(1);
      setCustomNote('');
    } catch (requestError) {
      if (isAbortError(requestError)) {
        console.log('[LLM] Request cancelled by user: structure/start generation');
        setRunLog((current) => [...current, logEntry('Canceled', 'Generation stopped.')]);
        return;
      }
      setError(readError(requestError));
    } finally {
      setStatus('idle');
      abortRef.current = null;
    }
  }

  async function submitCustomNote() {
    const trimmed = customNote.trim();
    if (!trimmed) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus('answering');
    setError('');

    const projectSnapshot = project;

    try {
      const data = await postJson('/api/agent/answer', {
        project,
        question: currentQuestion || {
          field: 'method',
          question: 'Integrate this user note into the project state.',
          reason: 'The user provided a custom refinement.',
          priority: 'Medium'
        },
        answer: trimmed,
        requirements: DEFAULT_REQUIREMENTS
      }, controller.signal);

      const merged = mergeProjectStates(projectSnapshot, data.project);
      const changedFields = computeChangedFields(projectSnapshot, merged);
      setProject(merged);
      setQuestions(data.questions || []);
      const updateMsg = changedFields.length > 0
        ? `Updated: ${changedFields.join(', ')}.`
        : 'No project fields were updated.';
      setRunLog((current) => [
        ...current,
        logEntry('Update', updateMsg)
      ]);
      setCustomNote('');
      clearArtifacts();
      setActiveStage(2);
    } catch (requestError) {
      if (isAbortError(requestError)) {
        console.log('[LLM] Request cancelled by user: LLM integrate (answer agent question)');
        setRunLog((current) => [...current, logEntry('Canceled', 'Integration stopped.')]);
        return;
      }
      setError(readError(requestError));
    } finally {
      setStatus('idle');
      abortRef.current = null;
    }
  }

  async function generateProposal() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus('drafting');
    setError('');

    try {
      const data = await postJson('/api/proposal', {
        ...project,
        topic: project.topic || project.title,
        literatureContext: litCtx(project),
        requirements: DEFAULT_REQUIREMENTS
      }, controller.signal);
      const nextPdfUrl = await exportPdfUrl(data.proposalLatex, project.title || 'proposal');

      setResult(data);
      updatePdfUrl(nextPdfUrl);
      setRunLog((current) => [
        ...current,
        logEntry('Draft', `Generated proposal using ${data.mode}.`),
        logEntry('Review', `Coverage ${countCovered(data.complianceMatrix)}/${data.complianceMatrix?.length || 0}.`)
      ]);
      setActiveStage(3);
    } catch (requestError) {
      if (isAbortError(requestError)) {
        console.log('[LLM] Request cancelled by user: proposal draft generation');
        setRunLog((current) => [...current, logEntry('Canceled', 'Draft generation stopped.')]);
        return;
      }
      setError(readError(requestError));
    } finally {
      setStatus('idle');
      abortRef.current = null;
    }
  }

  function acceptSuggestion(suggestion) {
    mergeProjectField(suggestion.field, suggestion.value);
    advanceSuggestion();
    setRunLog((current) => [...current, logEntry('Accept', `Accepted ${suggestion.label || suggestion.field}.`)]);
  }

  function skipSuggestion() {
    if (!currentSuggestion) return;
    advanceSuggestion();
    setRunLog((current) => [...current, logEntry('Skip', `Skipped ${currentSuggestion.label || currentSuggestion.field}.`)]);
  }

  function advanceSuggestion() {
    setSuggestionIndex((current) => Math.min(current + 1, Math.max(fieldSuggestions.length - 1, 0)));
  }

  function chooseOption(decision, option) {
    mergeProjectField(decision.field, option.value);
    setDecisions((current) => {
      const next = current.filter((item) => item.id !== decision.id);
      setDecisionIndex((index) => Math.min(index, Math.max(next.length - 1, 0)));
      return next;
    });
    setRunLog((current) => [...current, logEntry('Decision', `Selected ${option.label} for ${decision.title}.`)]);
  }

  function skipDecision() {
    if (!currentDecision) return;
    advanceDecision();
    setRunLog((current) => [...current, logEntry('Skip', `Skipped ${currentDecision.title}.`)]);
  }

  function advanceDecision() {
    setDecisionIndex((current) => Math.min(current + 1, Math.max(decisions.length - 1, 0)));
  }

  function updateProjectField(field, value) {
    setProject((current) => ({
      ...current,
      [field]: value,
      topic: current.topic || current.title || topicInput
    }));
    clearArtifacts();
  }

  function mergeProjectField(field, value) {
    setProject((current) => ({
      ...current,
      [field]: mergeTextField(current[field], value),
      topic: current.topic || current.title || topicInput
    }));
    clearArtifacts();
  }

  function clearArtifacts() {
    setResult(null);
    updatePdfUrl('');
    setReviewCycle(EMPTY_REVIEW_CYCLE);
    setReviewStatus('idle');
  }

  function updatePdfUrl(nextUrl) {
    setPdfUrl((currentUrl) => {
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      return nextUrl;
    });
  }

  function reset() {
    setTopicInput('');
    setProject(EMPTY_PROJECT);
    setFieldSuggestions([]);
    setDecisions([]);
    setQuestions([]);
    setCustomNote('');
    clearArtifacts();
    setRunLog([]);
    setError('');
    setActiveTab('pdf');
    setSuggestionIndex(0);
    setDecisionIndex(0);
    setActiveStage(0);
    setLiterature(EMPTY_LITERATURE);
    setSelectedPaperIds([]);
    setGapStatus('idle');
    setGapResult(EMPTY_GAP_RESULT);
    setSelectedGapId('');
    setReviewStatus('idle');
    setReviewCycle(EMPTY_REVIEW_CYCLE);
  }

  function cancelStatus() { abortRef.current?.abort(); }
  function cancelGap() { gapAbortRef.current?.abort(); }
  function cancelReview() { reviewAbortRef.current?.abort(); }
  function cancelEvalReport() { evalReportAbortRef.current?.abort(); }

  async function applyLatexEdits() {
    const latex = latexEditorValue.trim();
    if (!latex) return;
    setLatexExportStatus('exporting');
    setError('');
    try {
      const newPdfUrl = await exportPdfUrl(latex, project.title || 'proposal');
      setResult((current) => ({ ...current, proposalLatex: latex }));
      updatePdfUrl(newPdfUrl);
      setActiveTab('pdf');
      setRunLog((current) => [...current, logEntry('LaTeX Edit', 'PDF updated from manual edits.')]);
    } catch (err) {
      setError(readError(err));
    } finally {
      setLatexExportStatus('idle');
    }
  }

  async function retryEvalReport() {
    if (!result?.proposalLatex) return;
    evalReportAbortRef.current?.abort();
    const controller = new AbortController();
    evalReportAbortRef.current = controller;
    setEvalReportStatus('loading');
    setError('');
    try {
      const data = await postJson('/api/eval-report', {
        project,
        proposalLatex: result.proposalLatex
      }, controller.signal);
      setResult((current) => ({
        ...current,
        evaluationReport: data.evaluationReport || current.evaluationReport,
        complianceMatrix: Array.isArray(data.complianceMatrix) && data.complianceMatrix.length
          ? data.complianceMatrix
          : current.complianceMatrix
      }));
      setRunLog((current) => [...current, logEntry('Eval Report', 'Evaluation report regenerated.')]);
    } catch (requestError) {
      if (isAbortError(requestError)) {
        console.log('[LLM] Request cancelled by user: eval report retry');
        setRunLog((current) => [...current, logEntry('Canceled', 'Eval report generation stopped.')]);
        return;
      }
      setError(readError(requestError));
    } finally {
      setEvalReportStatus('idle');
      evalReportAbortRef.current = null;
    }
  }

  function togglePaperSelection(paper) {
    const paperKey = paperStableId(paper);

    setSelectedPaperIds((current) => {
      const exists = current.includes(paperKey);
      const next = exists ? current.filter((id) => id !== paperKey) : [...current, paperKey];

      setProject((currentProject) => {
        const currentSelected = litCtx(currentProject).selectedPapers;
        const nextSelected = exists
          ? currentSelected.filter((p) => paperStableId(p) !== paperKey)
          : currentSelected.some((p) => paperStableId(p) === paperKey)
            ? currentSelected
            : [...currentSelected, curatedPaper(paper)];
        return { ...currentProject, literatureContext: { ...litCtx(currentProject), selectedPapers: nextSelected } };
      });

      setGapResult(EMPTY_GAP_RESULT);
      setSelectedGapId('');

      setRunLog((log) => [
        ...log,
        logEntry('Explore', `${exists ? 'Unselected' : 'Selected'} paper: ${paper.title}.`)
      ]);

      return next;
    });
  }

  function selectAllPapers() {
    const allIds = (literature.papers || []).map((paper) => paperStableId(paper));
    setSelectedPaperIds(allIds);
    setGapResult(EMPTY_GAP_RESULT);
    setSelectedGapId('');
    if (allIds.length) {
      setActiveSelectedPaperId(allIds[0]);
    }
    setProject((currentProject) => ({
      ...currentProject,
      literatureContext: { ...litCtx(currentProject), selectedPapers: (literature.papers || []).map(curatedPaper) }
    }));
    setRunLog((current) => [...current, logEntry('Explore', `Selected all ${allIds.length} papers.`)]);
  }

  function deselectAllPapers() {
    setSelectedPaperIds([]);
    setGapResult(EMPTY_GAP_RESULT);
    setSelectedGapId('');
    setProject((currentProject) => ({
      ...currentProject,
      literatureContext: { ...litCtx(currentProject), selectedPapers: [] }
    }));
    setRunLog((current) => [...current, logEntry('Explore', 'Cleared all selected papers.')]);
  }

  async function detectResearchGaps() {
    if (selectedPapers.length < 3) {
      setError('Select at least 3 papers first to get continuation suggestions.');
      return;
    }

    gapAbortRef.current?.abort();
    const controller = new AbortController();
    gapAbortRef.current = controller;

    setGapStatus('running');
    setError('');

    try {
      const data = await postJson('/api/research-gaps', {
        topic: topicInput || project.title || project.topic,
        papers: selectedPapers.map(curatedPaper)
      }, controller.signal);
      setGapResult({ ...EMPTY_GAP_RESULT, ...data });
      setSelectedGapId(data.rankedGaps?.[0]?.id || '');
      setRunLog((current) => [
        ...current,
        logEntry('Continuation', data.runMessage || `Found ${data.rankedGaps?.length || 0} continuation suggestions.`)
      ]);
    } catch (requestError) {
      if (isAbortError(requestError)) {
        console.log('[LLM] Request cancelled by user: continuation/gap suggestions');
        setRunLog((current) => [...current, logEntry('Canceled', 'Continuation suggestions stopped.')]);
        return;
      }
      setError(readError(requestError));
    } finally {
      setGapStatus('idle');
      gapAbortRef.current = null;
    }
  }

  function openSelectedPapersModal() {
    if (!selectedPapers.length) return;
    setSelectedPapersOpen(true);
    if (!activeSelectedPaperId) {
      setActiveSelectedPaperId(paperStableId(selectedPapers[0]));
    }
  }

  function closeSelectedPapersModal() {
    setSelectedPapersOpen(false);
  }

  function adoptGap(gap) {
    if (!gap) return;

    const basedOnTitles = (gap.basedOnPapers || gap.supportingPaperKeys || []).slice(0, 5).filter(Boolean);
    const methodAddition = gap.possibleMethod || `Investigate: "${gap.title}" using targeted methodology, baselines, and evaluation.`;

    setProject((current) => {
      const currentCtx = litCtx(current);
      const alreadyAdded = currentCtx.continuationIdeas.some((idea) => idea.id === gap.id);
      return {
        ...current,
        problem: mergeTextField(current.problem, gap.description || ''),
        method: mergeTextField(current.method, methodAddition),
        references: mergeArrayField(
          current.references ? current.references.split('\n').filter(Boolean) : [],
          basedOnTitles
        ).join('\n'),
        literatureContext: {
          ...currentCtx,
          continuationIdeas: alreadyAdded ? currentCtx.continuationIdeas : [...currentCtx.continuationIdeas, gap]
        }
      };
    });

    setSelectedGapId(gap.id);
    setRunLog((current) => [...current, logEntry('Continuation', `Added to proposal: ${gap.title}.`)]);
    setActiveStage(2);
  }

  function downloadLatex() {
    const proposal = result?.proposalLatex || '';
    const blob = new Blob([proposal], { type: 'text/x-tex;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = 'proposal.tex';
    anchor.click();
    URL.revokeObjectURL(href);
  }

  async function downloadPdf() {
    if (!result?.proposalLatex) return;

    setStatus('exporting');
    setError('');

    try {
      const href = pdfUrl || (await exportPdfUrl(result.proposalLatex, project.title || 'proposal'));
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = 'proposal.pdf';
      anchor.click();
      if (!pdfUrl) URL.revokeObjectURL(href);
      setRunLog((current) => [...current, logEntry('Export', 'Downloaded proposal.pdf.')]);
    } catch (requestError) {
      setError(readError(requestError));
    } finally {
      setStatus('idle');
    }
  }

  async function runReviewerCritique() {
    if (!result?.proposalLatex) {
      setError('Generate a proposal before running the reviewer critique cycle.');
      return;
    }

    reviewAbortRef.current?.abort();
    const controller = new AbortController();
    reviewAbortRef.current = controller;

    setReviewStatus('critiquing');
    setError('');

    try {
      const previousCritiques = reviewCycle.rounds.flatMap((round) => round.critiques || []);
      const data = await postJson('/api/review/critique', {
        project,
        proposalLatex: result.proposalLatex,
        evaluationReport: result.evaluationReport,
        priorCritiques: previousCritiques
      }, controller.signal);

      const critiques = Array.isArray(data.critiques) ? data.critiques : [];
      const round = {
        id: `review-round-${Date.now()}`,
        mode: data.mode || 'local-fallback',
        provider: data.provider || 'template',
        summary: data.reviewSummary || 'Reviewer completed one critique pass.',
        critiques
      };

      setReviewCycle((current) => ({
        ...current,
        rounds: [...current.rounds, round],
        selectedCritiqueIds: critiques.map((critique) => critique.id)
      }));
      setRunLog((current) => [
        ...current,
        logEntry('Review', `Reviewer produced ${critiques.length} critique item(s).`)
      ]);
      setActiveTab('evaluation');
    } catch (requestError) {
      if (isAbortError(requestError)) {
        console.log('[LLM] Request cancelled by user: reviewer critique');
        setRunLog((current) => [...current, logEntry('Canceled', 'Reviewer critique stopped.')]);
        return;
      }
      setError(readError(requestError));
    } finally {
      setReviewStatus('idle');
      reviewAbortRef.current = null;
    }
  }

  function toggleCritiqueSelection(critiqueId) {
    setReviewCycle((current) => {
      const exists = current.selectedCritiqueIds.includes(critiqueId);
      return {
        ...current,
        selectedCritiqueIds: exists
          ? current.selectedCritiqueIds.filter((id) => id !== critiqueId)
          : [...current.selectedCritiqueIds, critiqueId]
      };
    });
  }

  async function applyReviewChanges() {
    if (!selectedCritiques.length && !reviewCycle.userInstruction.trim()) {
      setError('Select at least one critique or add revision instructions before applying changes.');
      return;
    }

    reviewAbortRef.current?.abort();
    const controller = new AbortController();
    reviewAbortRef.current = controller;

    setReviewStatus('revising');
    setError('');

    try {
      const revision = await postJson('/api/review/revise', {
        project,
        selectedCritiques,
        userInstruction: reviewCycle.userInstruction
      }, controller.signal);

      const revisedProject = { ...EMPTY_PROJECT, ...(revision.project || project) };

      const nextResult = await postJson('/api/proposal', {
        ...revisedProject,
        topic: revisedProject.topic || revisedProject.title,
        literatureContext: litCtx(revisedProject),
        requirements: DEFAULT_REQUIREMENTS
      }, controller.signal);

      const nextPdfUrl = await exportPdfUrl(nextResult.proposalLatex, revisedProject.title || 'proposal');

      // Only update state after all three operations succeed
      setProject(revisedProject);
      setReviewCycle((current) => ({ ...current, userInstruction: '' }));
      setResult(nextResult);
      updatePdfUrl(nextPdfUrl);
      setRunLog((current) => [
        ...current,
        logEntry('Review', revision.runMessage || 'Applied selected critique fixes.'),
        logEntry('Draft', `Regenerated proposal after review cycle using ${nextResult.mode}.`)
      ]);
      setActiveTab('evaluation');
    } catch (requestError) {
      if (isAbortError(requestError)) {
        console.log('[LLM] Request cancelled by user: review revision + re-draft');
        setRunLog((current) => [...current, logEntry('Canceled', 'Review revision stopped.')]);
        return;
      }
      setError(readError(requestError));
    } finally {
      setReviewStatus('idle');
      reviewAbortRef.current = null;
    }
  }

  function saveMemory({ silent = false } = {}) {
    const snapshot = {
      savedAt: new Date().toISOString(),
      topicInput,
      project,
      fieldSuggestions,
      decisions,
      questions,
      result: compactResult(result),
      literature,
      selectedPaperIds,
      gapResult,
      selectedGapId,
      reviewCycle,
      runLog,
      activeTab,
      suggestionIndex,
      decisionIndex,
      activeStage,
      enhanceQueriesWithAI
    };

    localStorage.setItem(MEMORY_KEY, JSON.stringify(snapshot));
    setMemorySavedAt(snapshot.savedAt);

    if (!silent) {
      setRunLog((current) => [...current, logEntry('Memory', 'Saved workspace memory.')]);
    }
  }

  async function loadSavedMemory({ silent = false } = {}) {
    const raw = localStorage.getItem(MEMORY_KEY);
    if (!raw) {
      if (!silent) setError('No saved memory found.');
      return;
    }

    try {
      const snapshot = JSON.parse(raw);
      setTopicInput(snapshot.topicInput || '');
      setProject({ ...EMPTY_PROJECT, ...(snapshot.project || {}) });
      setFieldSuggestions(Array.isArray(snapshot.fieldSuggestions) ? snapshot.fieldSuggestions : []);
      setDecisions(Array.isArray(snapshot.decisions) ? snapshot.decisions : []);
      setQuestions(Array.isArray(snapshot.questions) ? snapshot.questions : []);
      setResult(snapshot.result || null);
      setLiterature({ ...EMPTY_LITERATURE, ...(snapshot.literature || {}) });
      setSelectedPaperIds(Array.isArray(snapshot.selectedPaperIds) ? snapshot.selectedPaperIds : []);
      setGapResult({ ...EMPTY_GAP_RESULT, ...(snapshot.gapResult || {}) });
      setSelectedGapId(snapshot.selectedGapId || '');
      setReviewCycle({ ...EMPTY_REVIEW_CYCLE, ...(snapshot.reviewCycle || {}) });
      setRunLog(Array.isArray(snapshot.runLog) ? snapshot.runLog : []);
      setActiveTab(['evaluation', 'matrix'].includes(snapshot.activeTab) ? snapshot.activeTab : 'evaluation');
      setSuggestionIndex(Number(snapshot.suggestionIndex || 0));
      setDecisionIndex(Number(snapshot.decisionIndex || 0));
      setActiveStage(Number.isFinite(Number(snapshot.activeStage)) ? Number(snapshot.activeStage) : 0);
      setEnhanceQueriesWithAI(Boolean(snapshot.enhanceQueriesWithAI));
      setMemorySavedAt(snapshot.savedAt || '');
      setError('');

      if (snapshot.result?.proposalLatex) {
        try {
          updatePdfUrl(await exportPdfUrl(snapshot.result.proposalLatex, snapshot.project?.title || 'proposal'));
        } catch {
          updatePdfUrl('');
        }
      } else {
        updatePdfUrl('');
      }

      if (!silent) {
        setRunLog((current) => [...current, logEntry('Memory', 'Reloaded saved workspace memory.')]);
      }
    } catch {
      setError('Saved memory is unreadable. Clear it and save again.');
    }
  }

  function clearSavedMemory() {
    localStorage.removeItem(MEMORY_KEY);
    setMemorySavedAt('');
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <h1>Research Proposal Agent</h1>
        <span className="status-pill">
          <Sparkles size={16} aria-hidden="true" />
          {result?.mode || (fieldSuggestions.length ? 'structuring' : 'ready')}
        </span>
      </header>

      <section className="workspace single-pane">
        <section className="workflow-artifact">
          <div className="workflow-grid" aria-label="Workflow stages">
            {STAGES.slice(0, visibleStageCount).map(([number, title, description], index) => (
              <button
                className={[`stage-card`, 'stage-tab', activeStage === index ? 'stage-active' : ''].join(' ')}
                type="button"
                key={title}
                onClick={() => setActiveStage(index)}
                disabled={index > maxUnlockedStage}
              >
                <div className="stage-topline">
                  <span className="stage-number">{number}</span>
                  <span className={`stage-status ${stageStatus(index, fieldSuggestions, decisions, project, result)}`}>
                    {stageLabel(index, fieldSuggestions, decisions, project, result)}
                  </span>
                </div>
                <h3>{title}</h3>
                <p>{description}</p>
              </button>
            ))}
          </div>

          <div className="memory-bar">
            <div>
              <strong>Memory</strong>
              <span>{memorySavedAt ? `Saved ${formatSavedAt(memorySavedAt)}` : 'No saved workspace yet'}</span>
            </div>
            <div className="memory-actions">
              <button className="secondary" type="button" onClick={() => saveMemory()}>
                Save
              </button>
              <button className="secondary" type="button" onClick={() => loadSavedMemory()}>
                Reload
              </button>
              <button className="secondary" type="button" onClick={clearSavedMemory}>
                Clear
              </button>
            </div>
          </div>

          {error ? <p className="error-banner">{error}</p> : null}

          {activeStage === 0 ? (
            <>
              <div className="topic-launch">
                <label htmlFor="project-topic">
                  Rough Idea
                  <input
                    id="project-topic"
                    value={topicInput}
                    onChange={(event) => setTopicInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') startAgent();
                    }}
                    placeholder="Example: Agent for citation-grounded literature review"
                  />
                </label>
                <div className="actions framework-actions">
                  <button className="primary" disabled={!topicInput.trim() || status !== 'idle'} onClick={startAgent} type="button">
                    {status === 'starting' ? <Loader2 className="spin" size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
                    Structure Idea
                  </button>
                  {status === 'starting' ? (
                    <button className="secondary" type="button" onClick={cancelStatus} aria-label="Cancel">
                      <X size={18} aria-hidden="true" /> Cancel
                    </button>
                  ) : (
                    <button className="secondary" disabled={status !== 'idle'} onClick={startSampleAgent} type="button">
                      <Sparkles size={18} aria-hidden="true" />
                      Sample
                    </button>
                  )}
                  <button className="secondary icon-button" onClick={reset} type="button" aria-label="Reset">
                    <RefreshCw size={18} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className="query-options">
                <label className="query-enhance-toggle">
                  <input
                    type="checkbox"
                    checked={enhanceQueriesWithAI}
                    onChange={(event) => setEnhanceQueriesWithAI(event.target.checked)}
                  />
                  Enhance search queries with AI
                </label>
                <span className="query-enhance-hint">
                  {enhanceQueriesWithAI
                    ? 'LLM will generate varied query phrasings — useful for vague or broad topics.'
                    : 'Using preset queries (topic, survey, review, limitations, evaluation).'}
                </span>
              </div>
            </>
          ) : null}

          {activeStage === 0 ? (
            <div className="workspace-grid stage-single">
              <section className="workspace-panel">
                <section className="literature-inline">
                  <PanelHeader title="Literature Explorer" meta={`${selectedPaperCount} selected`} />
                  <div className="selected-papers-bar">
                    <div className="selected-papers-bar-info">
                      <span>Selected Papers Workspace</span>
                      <strong>{selectedPaperCount}</strong>
                    </div>
                    <div className="selected-papers-bar-actions">
                      <button
                        className={`secondary icon-button selected-papers-bar-toggle${allPapersSelected ? ' bar-toggle-active' : ''}`}
                        type="button"
                        onClick={allPapersSelected ? deselectAllPapers : selectAllPapers}
                        disabled={!literature.papers.length}
                        title={allPapersSelected ? 'Deselect all papers' : 'Select all papers'}
                        aria-label={allPapersSelected ? 'Deselect all papers' : 'Select all papers'}
                      >
                        {allPapersSelected ? <X size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
                      </button>
                      <button
                        className="secondary"
                        type="button"
                        onClick={openSelectedPapersModal}
                        disabled={!selectedPaperCount}
                      >
                        Open Reader
                      </button>
                    </div>
                  </div>
                  {literature.papers.length ? (
                    <>
                      <div className="literature-scroll literature-inline-card" aria-label="Retrieved papers">
                        {literature.papers.map((paper) => {
                          const paperKey = paperStableId(paper);
                          const isSelected = selectedPaperIds.includes(paperKey);

                          return (
                            <article className="paper-card" key={paperKey}>
                              <div className="paper-headline">
                                <a href={paper.url || '#'} target="_blank" rel="noreferrer">
                                  {paper.title}
                                </a>
                                <span className="priority medium">{paper.relevanceScore || 0}</span>
                              </div>
                              <p className="paper-meta">
                                {(paper.authors || []).slice(0, 3).join(', ') || 'Unknown authors'}
                                {paper.year ? ` • ${paper.year}` : ''}
                                {paper.venue ? ` • ${paper.venue}` : ''}
                              </p>
                              <p>{paper.summary || paper.abstract || 'No summary available.'}</p>
                              <small>{paper.whyRelevant || 'Potentially relevant to your topic.'}</small>
                              {literature.queriesEnhanced ? (
                                <div className="paper-tags">
                                  {(paper.queryHits || []).slice(0, 3).map((query) => (
                                    <span key={`${paperKey}-${query}`}>{queryTagLabel(query, literature.topic)}</span>
                                  ))}
                                </div>
                              ) : null}
                              <div className="deck-actions">
                                <button
                                  className={`secondary icon-button paper-read-icon${isSelected ? ' paper-read-selected' : ''}`}
                                  type="button"
                                  onClick={() => togglePaperSelection(paper)}
                                  title={isSelected ? 'Selected for reading' : 'Select for reading'}
                                  aria-label={isSelected ? 'Selected for reading' : 'Select for reading'}
                                >
                                  <BookOpen size={16} aria-hidden="true" />
                                </button>
                              </div>
                            </article>
                          );
                        })}
                      </div>

                      <div className="literature-summary literature-inline-card">
                        <span>
                          Queries: {literature.queries.join(' | ')}
                        </span>
                        <span>
                          Semantic Scholar: {literature.sourceStats?.semanticScholar || 0} | arXiv: {literature.sourceStats?.arxiv || 0}
                        </span>
                        <span>
                          Deduped: {literature.dedupeStats?.unique || literature.papers.length} unique from {literature.dedupeStats?.raw || literature.papers.length} fetched
                        </span>
                      </div>
                    </>
                  ) : (
                    <EmptyState text="Structure a topic to retrieve and rank related papers." compact />
                  )}
                </section>
              </section>
            </div>
          ) : null}

          {activeStage === 1 ? (
            <div className="workspace-grid stage-two">
              <section className="workspace-panel suggestions-panel">
                <PanelHeader title="LLM Suggested Structure" meta={`${fieldSuggestions.length} fields`} />
                {fieldSuggestions.length ? (
                  <div className="suggestion-deck">
                    <div className="deck-progress">
                      <span>{Math.min(suggestionIndex + 1, fieldSuggestions.length)} / {fieldSuggestions.length}</span>
                      <strong>{acceptedSuggestionCount} accepted</strong>
                    </div>
                    {currentSuggestion ? (
                      <article className="suggestion-card active-card" key={`${currentSuggestion.field}-${currentSuggestion.value}`}>
                        <div className="card-line">
                          <h3>{currentSuggestion.label || labelForField(currentSuggestion.field)}</h3>
                          <span className={`priority ${String(currentSuggestion.confidence || 'medium').toLowerCase()}`}>
                            {currentSuggestion.confidence || 'Medium'}
                          </span>
                        </div>
                        <p>{currentSuggestion.value}</p>
                        <small>{currentSuggestion.reason}</small>
                        <div className="deck-actions">
                          <button
                            className={suggestionIsAccepted(project[currentSuggestion.field], currentSuggestion.value) ? 'secondary accepted' : 'primary'}
                            type="button"
                            onClick={() => acceptSuggestion(currentSuggestion)}
                          >
                            <CheckCircle2 size={16} aria-hidden="true" />
                            {suggestionIsAccepted(project[currentSuggestion.field], currentSuggestion.value) ? 'Accepted' : 'Accept and Next'}
                          </button>
                          <button className="secondary" type="button" onClick={skipSuggestion}>
                            Skip
                          </button>
                        </div>
                      </article>
                    ) : null}
                    <div className="deck-nav">
                      <button
                        className="secondary"
                        type="button"
                        disabled={suggestionIndex === 0}
                        onClick={() => setSuggestionIndex((current) => Math.max(current - 1, 0))}
                      >
                        Previous
                      </button>
                      <button
                        className="secondary"
                        type="button"
                        disabled={suggestionIndex >= fieldSuggestions.length - 1}
                        onClick={() => setSuggestionIndex((current) => Math.min(current + 1, fieldSuggestions.length - 1))}
                      >
                        Next
                      </button>
                    </div>
                    <div className="deck-strip" aria-label="Suggestion progress">
                      {fieldSuggestions.map((suggestion, index) => (
                        <button
                          key={`${suggestion.field}-${index}`}
                          className={[
                            'deck-dot',
                            index === suggestionIndex ? 'current' : '',
                            suggestionIsAccepted(project[suggestion.field], suggestion.value) ? 'done' : ''
                          ].join(' ')}
                          type="button"
                          aria-label={`Open ${suggestion.label || labelForField(suggestion.field)}`}
                          onClick={() => setSuggestionIndex(index)}
                        />
                      ))}
                    </div>
                  </div>
                ) : (
                  <EmptyState text="Enter a rough idea, then let the model structure it." compact />
                )}

                <section className="custom-note">
                  <h3>Additional Input</h3>
                  <textarea
                    value={customNote}
                    onChange={(event) => setCustomNote(event.target.value)}
                    placeholder={currentQuestion?.question || 'Add a detail the options missed.'}
                  />
                  <div className="deck-actions">
                    <button className="primary" disabled={!customNote.trim() || status !== 'idle'} onClick={submitCustomNote} type="button">
                      {status === 'answering' ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
                      Let LLM Integrate
                    </button>
                    {status === 'answering' ? (
                      <button className="secondary" type="button" onClick={cancelStatus}>
                        <X size={16} aria-hidden="true" /> Cancel
                      </button>
                    ) : null}
                  </div>
                </section>
              </section>

              <section className="workspace-panel decisions-panel">
                <PanelHeader title="Decision Needed" meta={`${decisions.length} open`} />
                {decisions.length ? (
                  <div className="decision-deck">
                    <div className="deck-progress">
                      <span>{Math.min(decisionIndex + 1, decisions.length)} / {decisions.length}</span>
                      <strong>{decisions.length} open</strong>
                    </div>
                    {currentDecision ? (
                      <article className="decision-card active-card" key={currentDecision.id}>
                        <h3>{currentDecision.title}</h3>
                        <p>{currentDecision.question}</p>
                        <div className="option-stack">
                          {currentDecision.options.map((option) => (
                            <button
                              className="option-button"
                              key={`${currentDecision.id}-${option.label}`}
                              type="button"
                              onClick={() => chooseOption(currentDecision, option)}
                            >
                              <strong>{option.label}</strong>
                              <span>{option.value}</span>
                              <small>{option.rationale}</small>
                            </button>
                          ))}
                        </div>
                        <div className="deck-actions">
                          <button className="secondary" type="button" onClick={skipDecision}>
                            Skip
                          </button>
                        </div>
                      </article>
                    ) : null}
                    <div className="deck-nav">
                      <button
                        className="secondary"
                        type="button"
                        disabled={decisionIndex === 0}
                        onClick={() => setDecisionIndex((current) => Math.max(current - 1, 0))}
                      >
                        Previous
                      </button>
                      <button
                        className="secondary"
                        type="button"
                        disabled={decisionIndex >= decisions.length - 1}
                        onClick={() => setDecisionIndex((current) => Math.min(current + 1, decisions.length - 1))}
                      >
                        Next
                      </button>
                    </div>
                    <div className="deck-strip" aria-label="Decision progress">
                      {decisions.map((decision, index) => (
                        <button
                          key={`${decision.id}-${index}`}
                          className={['deck-dot', index === decisionIndex ? 'current' : ''].join(' ')}
                          type="button"
                          aria-label={`Open ${decision.title}`}
                          onClick={() => setDecisionIndex(index)}
                        />
                      ))}
                    </div>
                  </div>
                ) : (
                  <EmptyState text="No major decision is open. Review the accepted state or draft the proposal." compact />
                )}

                <section className="gap-panel gap-decision-card">
                  <div className="gap-decision-header">
                    <h3>Continuation Suggestions</h3>
                    <div className="deck-actions">
                      <button
                        className="secondary"
                        type="button"
                        onClick={detectResearchGaps}
                        disabled={gapStatus !== 'idle' || selectedPaperCount < 3}
                      >
                        {gapStatus === 'running' ? <Loader2 className="spin" size={16} aria-hidden="true" /> : null}
                        Suggest Continuations
                      </button>
                      {gapStatus === 'running' ? (
                        <button className="secondary" type="button" onClick={cancelGap}>
                          <X size={16} aria-hidden="true" /> Cancel
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <p className="gap-hint">Uses your selected papers to find continuation directions from limitations and future work.</p>
                  <p className="gap-hint">Selected papers: {selectedPaperCount} {selectedPaperCount < 3 ? '(select at least 3)' : ''}</p>
                  {gapResult.rankedGaps?.length ? (
                    <ol className="gap-list">
                      {gapResult.rankedGaps.map((gap) => {
                        const isAdopted = litCtx(project).continuationIdeas.some((idea) => idea.id === gap.id);

                        return (
                          <li key={gap.id} className={['gap-item', isAdopted ? 'gap-item-adopted' : ''].filter(Boolean).join(' ')}>
                            <div className="gap-item-topline">
                              <strong>{gap.title}</strong>
                              <span className="priority medium">{gap.feasibility || gap.overallScore}</span>
                            </div>
                            <p className="gap-addresses"><strong>{gap.type || gap.category || 'continuation'}</strong></p>
                            <p className="gap-description">{gap.description}</p>
                            <small className="gap-rationale">Possible continuation based on selected papers.</small>
                            {(gap.basedOnPapers || gap.supportingPaperKeys)?.length ? (
                              <small className="gap-rationale">Based on: {(gap.basedOnPapers || gap.supportingPaperKeys).slice(0, 3).join('; ')}</small>
                            ) : null}
                            {gap.researchQuestion || gap.possibleResearchQuestion ? (
                              <p className="gap-check gap-question">Research question: {gap.possibleResearchQuestion || gap.researchQuestion}</p>
                            ) : null}
                            <div className="deck-actions">
                              <button
                                className={isAdopted ? 'secondary accepted' : 'primary'}
                                type="button"
                                onClick={() => { if (!isAdopted) adoptGap(gap); }}
                                disabled={isAdopted}
                              >
                                {isAdopted ? <CheckCircle2 size={16} aria-hidden="true" /> : null}
                                {isAdopted ? 'Added to Proposal' : 'Add to Proposal'}
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <p className="gap-hint">Select papers and click Suggest Continuations.</p>
                  )}
                </section>
              </section>
            </div>
          ) : null}

          {activeStage === 2 ? (
            <div className="workspace-grid stage-single">
              <section className="workspace-panel state-panel">
                <PanelHeader title="Accepted Project State" meta={`${acceptedCount}/${PROJECT_FIELDS.length} ready`} />
                <label>
                  Project Title
                  <input value={project.title} onChange={(event) => updateProjectField('title', event.target.value)} />
                </label>
                {PROJECT_FIELDS.map(([field, label]) => (
                  <label key={field}>
                    {label}
                    <textarea value={project[field] || ''} onChange={(event) => updateProjectField(field, event.target.value)} />
                  </label>
                ))}
                <div className="deck-actions">
                  <button className="primary" disabled={!project.title || status !== 'idle'} onClick={generateProposal} type="button">
                    {status === 'drafting' ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
                    Generate Proposal
                  </button>
                  {status === 'drafting' ? (
                    <button className="secondary" type="button" onClick={cancelStatus}>
                      <X size={16} aria-hidden="true" /> Cancel
                    </button>
                  ) : null}
                </div>
              </section>
            </div>
          ) : null}

          {activeStage === 3 ? (
            <div className="draft-split">
              <section className="draft-editor-panel">
                <div className="draft-editor-toolbar">
                  <div className="deck-actions">
                    <button className="primary" disabled={!project.title || status !== 'idle'} onClick={generateProposal} type="button">
                      {status === 'drafting' ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
                      {result ? 'Regenerate' : 'Generate Proposal'}
                    </button>
                    {status === 'drafting' ? (
                      <button className="secondary" type="button" onClick={cancelStatus}>
                        <X size={16} aria-hidden="true" /> Cancel
                      </button>
                    ) : null}
                    {latexEditorValue ? (
                      <button className="primary" type="button" onClick={applyLatexEdits} disabled={latexExportStatus !== 'idle'}>
                        {latexExportStatus === 'exporting' ? <Loader2 className="spin" size={16} aria-hidden="true" /> : null}
                        {latexExportStatus === 'exporting' ? 'Compiling…' : 'Update PDF'}
                      </button>
                    ) : null}
                    {latexEditorValue && latexEditorValue !== (result?.proposalLatex || '') ? (
                      <button className="secondary" type="button" onClick={() => setLatexEditorValue(result?.proposalLatex || '')} disabled={latexExportStatus !== 'idle'}>
                        Reset
                      </button>
                    ) : null}
                  </div>
                  <div className="deck-actions">
                    <button className="secondary" type="button" disabled={!result?.proposalLatex} onClick={downloadLatex}>
                      <Download size={15} aria-hidden="true" /> LaTeX
                    </button>
                    <button className="secondary" type="button" disabled={!result?.proposalLatex || status !== 'idle'} onClick={downloadPdf}>
                      {status === 'exporting' ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}
                      PDF
                    </button>
                  </div>
                </div>
                <textarea
                  className="latex-editor"
                  value={latexEditorValue}
                  onChange={(e) => setLatexEditorValue(e.target.value)}
                  spellCheck={false}
                  placeholder="LaTeX source appears here after generating a proposal. Edit freely — click Update PDF to recompile."
                />
              </section>
              <section className="draft-preview-panel">
                {pdfUrl ? (
                  <iframe className="pdf-preview" src={pdfUrl} title="Compiled proposal PDF" />
                ) : (
                  <EmptyState text={status === 'drafting' ? 'Generating proposal…' : 'Generate a proposal to see the PDF preview.'} />
                )}
              </section>
            </div>
          ) : null}

          {activeStage === 4 ? (
            <div className="workflow-columns">
              <section className="workflow-panel">
                <h2>Run Log</h2>
                {runLog.length ? (
                  <ol className="run-log">
                    {runLog.map((entry) => (
                      <li key={entry.id}>
                        <span>{entry.stage}</span>
                        <p>{entry.message}</p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <EmptyState text="Run log appears after the idea is structured." compact />
                )}
              </section>

              <section className="workflow-panel review-panel">
                <div className="artifact-toolbar">
                  <nav className="tabs" aria-label="Review artifacts">
                    {[['evaluation', ListChecks, 'Evaluation'], ['matrix', ClipboardCheck, 'Matrix']].map(([id, Icon, label]) => (
                      <button
                        key={id}
                        className={activeTab === id ? 'tab active' : 'tab'}
                        type="button"
                        onClick={() => setActiveTab(id)}
                      >
                        <Icon size={17} aria-hidden="true" />
                        {label}
                      </button>
                    ))}
                  </nav>
                  <div className="artifact-summary-inline">
                    <span>Coverage <strong>{matrixStats.total ? `${matrixStats.covered}/${matrixStats.total}` : '—'}</strong></span>
                  </div>
                </div>

                {activeTab === 'matrix' ? (
                  renderArtifact('matrix', result, pdfUrl)
                ) : (
                  <div className="markdown-output">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{result?.evaluationReport || ''}</ReactMarkdown>
                  </div>
                )}

                <div className="deck-actions" style={{ margin: '0.75rem 0' }}>
                  <button
                    className="secondary"
                    type="button"
                    onClick={retryEvalReport}
                    disabled={evalReportStatus !== 'idle' || !result?.proposalLatex}
                  >
                    {evalReportStatus === 'loading' ? <Loader2 className="spin" size={16} aria-hidden="true" /> : null}
                    {evalReportStatus === 'loading' ? 'Generating…' : 'Retry Evaluation Report'}
                  </button>
                  {evalReportStatus === 'loading' ? (
                    <button className="secondary" type="button" onClick={cancelEvalReport}>
                      <X size={16} aria-hidden="true" /> Cancel
                    </button>
                  ) : null}
                </div>

                <section className="review-cycle-panel">
                  <div className="review-cycle-header">
                    <h3>Reviewer Agent Cycle</h3>
                    <div className="deck-actions">
                      <button
                        className="secondary"
                        type="button"
                        onClick={runReviewerCritique}
                        disabled={reviewStatus !== 'idle' || !result?.proposalLatex}
                      >
                        {reviewStatus === 'critiquing' ? <Loader2 className="spin" size={16} aria-hidden="true" /> : null}
                        Run Reviewer Critique
                      </button>
                      {reviewStatus === 'critiquing' ? (
                        <button className="secondary" type="button" onClick={cancelReview}>
                          <X size={16} aria-hidden="true" /> Cancel
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <p className="review-cycle-hint">Cycle pattern: critique {'→'} change {'→'} critique {'→'} change. You control which fixes are applied.</p>

                  {latestReviewRound ? (
                    <>
                      <p className="review-cycle-summary">{latestReviewRound.summary}</p>
                      <ol className="review-critique-list">
                        {(latestReviewRound.critiques || []).map((critique) => {
                          const isSelected = reviewCycle.selectedCritiqueIds.includes(critique.id);
                          return (
                            <li key={critique.id} className={isSelected ? 'review-critique-item selected' : 'review-critique-item'}>
                              <label className="review-critique-toggle">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleCritiqueSelection(critique.id)}
                                />
                                <span>{critique.question || critique.title}</span>
                              </label>
                              <div className="review-critique-meta">
                                <span className="priority high">Severity {critique.severity}/5</span>
                                <span>{critique.targetField}</span>
                              </div>
                              <p>{critique.analysis}</p>
                              <small>Suggested fix: {critique.suggestedFix}</small>
                            </li>
                          );
                        })}
                      </ol>
                    </>
                  ) : (
                    <p className="review-cycle-hint">Run reviewer critique to generate severity-scored critique cards.</p>
                  )}

                  <label>
                    Your revision instruction (optional)
                    <textarea
                      value={reviewCycle.userInstruction}
                      onChange={(event) => setReviewCycle((current) => ({ ...current, userInstruction: event.target.value }))}
                      placeholder="Example: keep scope narrow to one MIR task and add one deterministic baseline"
                    />
                  </label>

                  <div className="deck-actions">
                    <button
                      className="primary"
                      type="button"
                      onClick={applyReviewChanges}
                      disabled={reviewStatus !== 'idle' || (!selectedCritiques.length && !reviewCycle.userInstruction.trim())}
                    >
                      {reviewStatus === 'revising' ? <Loader2 className="spin" size={16} aria-hidden="true" /> : null}
                      Apply Selected Changes and Regenerate
                    </button>
                    {reviewStatus === 'revising' ? (
                      <button className="secondary" type="button" onClick={cancelReview}>
                        <X size={16} aria-hidden="true" /> Cancel
                      </button>
                    ) : null}
                  </div>
                </section>
              </section>
            </div>
          ) : null}

          {selectedPapersOpen ? (
            <div className="modal-overlay" role="presentation" onClick={closeSelectedPapersModal}>
              <section
                className="selected-papers-modal"
                role="dialog"
                aria-modal="true"
                aria-label="Selected papers workspace"
                onClick={(event) => event.stopPropagation()}
              >
                <header className="selected-papers-modal-header">
                  <h2>Selected Papers Workspace</h2>
                  <button className="secondary" type="button" onClick={closeSelectedPapersModal}>
                    Close
                  </button>
                </header>

                <div className="selected-papers-modal-body">
                  <aside className="selected-papers-list">
                    {selectedPapers.map((paper) => {
                      const paperKey = paperStableId(paper);
                      const isActive = activeSelectedPaperId === paperKey;

                      return (
                        <button
                          key={paperKey}
                          className={isActive ? 'paper-list-item active' : 'paper-list-item'}
                          type="button"
                          onClick={() => setActiveSelectedPaperId(paperKey)}
                        >
                          <strong>{paper.title}</strong>
                          <span>{paper.year ? `${paper.year} • ` : ''}{paper.venue || paper.source}</span>
                        </button>
                      );
                    })}
                  </aside>

                  <section className="selected-paper-detail">
                    {activeSelectedPaper ? (
                      <>
                        <div className="paper-headline">
                          <a href={activeSelectedPaper.url || '#'} target="_blank" rel="noreferrer">
                            {activeSelectedPaper.title}
                          </a>
                          <span className="priority medium">{activeSelectedPaper.relevanceScore || 0}</span>
                        </div>
                        <p className="paper-meta">
                          {(activeSelectedPaper.authors || []).join(', ') || 'Unknown authors'}
                          {activeSelectedPaper.year ? ` • ${activeSelectedPaper.year}` : ''}
                          {activeSelectedPaper.venue ? ` • ${activeSelectedPaper.venue}` : ''}
                        </p>
                        <p>{activeSelectedPaper.summary || activeSelectedPaper.abstract || 'No summary available.'}</p>
                        <small>{activeSelectedPaper.whyRelevant || 'Potentially relevant to your topic.'}</small>
                        {literature.queriesEnhanced ? (
                          <div className="paper-tags">
                            {(activeSelectedPaper.queryHits || []).slice(0, 4).map((query) => (
                              <span key={`${paperStableId(activeSelectedPaper)}-${query}`}>{queryTagLabel(query, literature.topic)}</span>
                            ))}
                          </div>
                        ) : null}
                        <div className="deck-actions">
                          <button
                            className="secondary"
                            type="button"
                            onClick={() => window.open(activeSelectedPaper.url || '#', '_blank', 'noopener,noreferrer')}
                          >
                            Open Source
                          </button>
                        </div>
                      </>
                    ) : (
                      <EmptyState text="Select a paper to inspect details." compact />
                    )}
                  </section>
                </div>
              </section>
            </div>
          ) : null}

        </section>
      </section>
    </main>
  );
}

async function postJson(url, body, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.detail || data.error || 'Request failed.');
  }

  return data;
}

async function exportPdfUrl(proposalLatex, title) {
  const response = await fetch('/api/export/pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      proposalLatex
    })
  });

  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.detail || data.error || 'PDF export failed.');
  }

  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

function renderArtifact(activeTab, result, pdfUrl) {
  if (!result) {
    return <EmptyState text="Proposal artifacts appear after Generate Proposal." />;
  }

  if (activeTab === 'pdf') {
    return pdfUrl ? (
      <iframe className="pdf-preview" src={pdfUrl} title="Compiled proposal PDF" />
    ) : (
      <EmptyState text="PDF preview is rendering." />
    );
  }

  if (activeTab === 'matrix') {
    return (
      <div className="matrix-wrap">
        <table>
          <thead>
            <tr>
              <th>Requirement</th>
              <th>Status</th>
              <th>Evidence</th>
              <th>Fix</th>
            </tr>
          </thead>
          <tbody>
            {(result.complianceMatrix || []).map((row, index) => (
              <tr key={`${row.requirement}-${index}`}>
                <td>{row.requirement}</td>
                <td>
                  <span className={/^covered$/i.test(row.status) ? 'badge covered' : 'badge needs-work'}>{row.status}</span>
                </td>
                <td>{row.evidence}</td>
                <td>{row.fix}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (activeTab === 'evaluation') {
    return (
      <div className="markdown-output">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.evaluationReport || ''}</ReactMarkdown>
      </div>
    );
  }

  return <pre className="proposal-output">{result.proposalLatex}</pre>;
}

function PanelHeader({ title, meta }) {
  return (
    <div className="panel-header">
      <h2>{title}</h2>
      <span>{meta}</span>
    </div>
  );
}

function EmptyState({ text, compact = false }) {
  return (
    <div className={compact ? 'empty-state compact' : 'empty-state'}>
      <FileText size={compact ? 24 : 32} aria-hidden="true" />
      <p>{text}</p>
    </div>
  );
}

function stageStatus(index, fieldSuggestions, decisions, project, result) {
  if (index === 0 && fieldSuggestions.length) return 'status-complete';
  if (index === 1 && decisions.length) return 'status-complete';
  if (index === 2 && PROJECT_FIELDS.some(([field]) => project[field])) return 'status-complete';
  if (index >= 3 && result) return 'status-complete';
  return 'status-waiting';
}

function stageLabel(index, fieldSuggestions, decisions, project, result) {
  if (index === 0 && fieldSuggestions.length) return 'Shown';
  if (index === 1 && decisions.length) return 'Shown';
  if (index === 2 && PROJECT_FIELDS.some(([field]) => project[field])) return 'Shown';
  if (index >= 3 && result) return 'Shown';
  return 'Ready';
}

function countCovered(rows = []) {
  return rows.filter((row) => /^covered$/i.test(row.status)).length;
}

function labelForField(field) {
  const found = PROJECT_FIELDS.find(([key]) => key === field);
  return found?.[1] || 'Field';
}

function logEntry(stage, message) {
  return {
    id: `${stage}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    stage,
    message
  };
}

function readError(error) {
  return error instanceof Error ? error.message : String(error);
}

function compactResult(result) {
  if (!result) return null;

  return {
    mode: result.mode,
    provider: result.provider,
    proposalLatex: result.proposalLatex,
    complianceMatrix: result.complianceMatrix,
    evaluationReport: result.evaluationReport,
    questions: result.questions
  };
}

function formatSavedAt(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'recently';
  }

  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function queryTagLabel(query, topic) {
  const t = (topic || '').trim();
  const q = (query || '').trim();
  if (!t) return q;
  if (q.toLowerCase() === t.toLowerCase()) return 'direct';
  if (q.toLowerCase().startsWith(t.toLowerCase() + ' ')) return q.slice(t.length + 1);
  return q;
}

function paperStableId(paper) {
  if (paper?.paperId) return `pid:${paper.paperId}`;
  if (paper?.doi) return `doi:${paper.doi}`;
  return `title:${String(paper?.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
}

function curatedPaper(paper) {
  return {
    paperId: String(paper.paperId || ''),
    doi: String(paper.doi || ''),
    title: String(paper.title || ''),
    authors: (Array.isArray(paper.authors) ? paper.authors : []).slice(0, 6),
    year: paper.year || '',
    venue: String(paper.venue || ''),
    url: String(paper.url || ''),
    abstract: String(paper.abstract || '').slice(0, 500),
    summary: String(paper.summary || ''),
    whyRelevant: String(paper.whyRelevant || '')
  };
}

function mergeTextField(existing, incoming) {
  const a = String(existing || '').trim();
  const b = String(incoming || '').trim();
  if (!a) return b;
  if (!b) return a;
  if (a.toLowerCase().includes(b.toLowerCase().slice(0, 80))) return a;
  return `${a}\n${b}`;
}

function mergeArrayField(existing, incoming) {
  const existingArr = Array.isArray(existing) ? existing : [];
  const incomingArr = Array.isArray(incoming) ? incoming : [];
  const normalized = new Set(existingArr.map((item) => String(item).trim().toLowerCase()).filter(Boolean));
  const additions = incomingArr.filter((item) => item && !normalized.has(String(item).trim().toLowerCase()));
  return [...existingArr, ...additions];
}

function mergeProjectStates(current, incoming) {
  if (!incoming) return current;
  const textFields = ['problem', 'method', 'timeline', 'evaluation', 'resources', 'references'];
  const next = { ...current };
  if (!next.title && incoming.title) next.title = String(incoming.title || '').trim();
  if (!next.topic && incoming.topic) next.topic = String(incoming.topic || '').trim();
  textFields.forEach((field) => {
    const val = String(incoming[field] || '').trim();
    if (val) next[field] = mergeTextField(current[field], val);
  });
  return next;
}

function suggestionIsAccepted(projectFieldValue, suggestionValue) {
  const field = String(projectFieldValue || '').toLowerCase();
  const val = String(suggestionValue || '').toLowerCase().slice(0, 100).trim();
  return val.length > 10 && field.includes(val);
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.message === 'The user aborted a request.';
}

function computeChangedFields(before, after) {
  const fields = ['title', 'topic', 'problem', 'method', 'timeline', 'evaluation', 'resources', 'references'];
  return fields.filter((field) => {
    const a = String(before[field] || '').trim();
    const b = String(after[field] || '').trim();
    return b && b !== a;
  });
}

export default App;
