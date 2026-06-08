import { useEffect, useMemo, useState } from 'react';
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
  Sparkles
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

const EMPTY_PROJECT = {
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

const TABS = [
  ['pdf', FileText, 'PDF'],
  ['latex', FileText, 'LaTeX'],
  ['matrix', ClipboardCheck, 'Matrix'],
  ['evaluation', ListChecks, 'Review']
];

const MEMORY_KEY = 'proposal-agent-final-project-memory-v1';
const EMPTY_LITERATURE = {
  topic: '',
  mode: 'idle',
  provider: '',
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
  const [activeTab, setActiveTab] = useState('pdf');
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

  const matrixStats = useMemo(() => {
    const rows = result?.complianceMatrix || [];
    const covered = rows.filter((row) => /^covered$/i.test(row.status)).length;
    return { covered, total: rows.length };
  }, [result]);

  const acceptedCount = PROJECT_FIELDS.filter(([field]) => Boolean(project[field])).length;
  const acceptedSuggestionCount = fieldSuggestions.filter((suggestion) => project[suggestion.field] === suggestion.value).length;
  const currentSuggestion = fieldSuggestions[suggestionIndex] || null;
  const currentDecision = decisions[decisionIndex] || null;
  const currentQuestion = questions[0];
  const selectedPaperCount = selectedPaperIds.length;
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
    setStatus('starting');
    setError('');
    clearArtifacts();

    try {
      const data = await postJson('/api/agent/start', {
        topic: nextTopic,
        requirements: DEFAULT_REQUIREMENTS
      });

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
      });
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
      setError(readError(requestError));
    } finally {
      setStatus('idle');
    }
  }

  async function submitCustomNote() {
    const trimmed = customNote.trim();
    if (!trimmed) return;

    setStatus('answering');
    setError('');

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
      });

      setProject({ ...EMPTY_PROJECT, ...data.project });
      setFieldSuggestions(data.fieldSuggestions || []);
      setDecisions(data.decisions || []);
      setQuestions(data.questions || []);
      setSuggestionIndex(0);
      setDecisionIndex(0);
      setRunLog((current) => [
        ...current,
        logEntry('Update', data.runMessage || 'Integrated custom note.'),
        logEntry('Decide', `Refreshed ${(data.fieldSuggestions || []).length} suggested field(s).`)
      ]);
      setCustomNote('');
      clearArtifacts();
    } catch (requestError) {
      setError(readError(requestError));
    } finally {
      setStatus('idle');
    }
  }

  async function generateProposal() {
    setStatus('drafting');
    setError('');

    try {
      const data = await postJson('/api/proposal', {
        ...project,
        topic: project.topic || project.title,
        requirements: DEFAULT_REQUIREMENTS
      });
      const nextPdfUrl = await exportPdfUrl(data.proposalLatex, project.title || 'proposal');

      setResult(data);
      updatePdfUrl(nextPdfUrl);
      setActiveTab('pdf');
      setRunLog((current) => [
        ...current,
        logEntry('Draft', `Generated proposal using ${data.mode}.`),
        logEntry('Review', `Coverage ${countCovered(data.complianceMatrix)}/${data.complianceMatrix?.length || 0}.`)
      ]);
      setActiveStage(4);
    } catch (requestError) {
      setError(readError(requestError));
    } finally {
      setStatus('idle');
    }
  }

  function acceptSuggestion(suggestion) {
    updateProjectField(suggestion.field, suggestion.value);
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
    updateProjectField(decision.field, option.value);
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

  function togglePaperSelection(paper) {
    const paperKey = paperStableId(paper);

    setSelectedPaperIds((current) => {
      const exists = current.includes(paperKey);
      const next = exists ? current.filter((id) => id !== paperKey) : [...current, paperKey];
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
    setRunLog((current) => [...current, logEntry('Explore', `Selected all ${allIds.length} papers.`)]);
  }

  function deselectAllPapers() {
    setSelectedPaperIds([]);
    setGapResult(EMPTY_GAP_RESULT);
    setSelectedGapId('');
    setRunLog((current) => [...current, logEntry('Explore', 'Cleared all selected papers.')]);
  }

  async function detectResearchGaps() {
    const topPapers = [...(literature.papers || [])]
      .sort((a, b) => Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0))
      .slice(0, 24);

    if (topPapers.length < 8) {
      setError('Retrieve a larger literature set first. At least 8 top papers are needed for gap detection.');
      return;
    }

    setGapStatus('running');
    setError('');

    try {
      const data = await postJson('/api/research-gaps', {
        topic: topicInput || project.title || project.topic,
        papers: topPapers
      });
      setGapResult({ ...EMPTY_GAP_RESULT, ...data });
      setSelectedGapId(data.rankedGaps?.[0]?.id || '');
      setRunLog((current) => [
        ...current,
        logEntry('Gap', data.runMessage || `Detected ${data.rankedGaps?.length || 0} research gaps.`)
      ]);
    } catch (requestError) {
      setError(readError(requestError));
    } finally {
      setGapStatus('idle');
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

    const selectedTitles = selectedPapers.slice(0, 5).map((paper) => paper.title).filter(Boolean);

    setProject((current) => ({
      ...current,
      problem: gap.description,
      method: current.method || `Investigate the gap "${gap.title}" with a targeted methodology, baselines, and ablation checks.`,
      evaluation:
        current.evaluation ||
        `Evaluate novelty and feasibility using reproducible metrics, compare against existing approaches, and validate with selected literature evidence.`,
      references: [current.references, ...selectedTitles].filter(Boolean).join('\n')
    }));

    setSelectedGapId(gap.id);
    setRunLog((current) => [...current, logEntry('Gap', `Adopted gap: ${gap.title}.`)]);
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

    setReviewStatus('critiquing');
    setError('');

    try {
      const previousCritiques = reviewCycle.rounds.flatMap((round) => round.critiques || []);
      const data = await postJson('/api/review/critique', {
        project,
        proposalLatex: result.proposalLatex,
        evaluationReport: result.evaluationReport,
        priorCritiques: previousCritiques
      });

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
      setError(readError(requestError));
    } finally {
      setReviewStatus('idle');
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

    setReviewStatus('revising');
    setError('');

    try {
      const revision = await postJson('/api/review/revise', {
        project,
        selectedCritiques,
        userInstruction: reviewCycle.userInstruction
      });
      const revisedProject = { ...EMPTY_PROJECT, ...(revision.project || project) };

      setProject(revisedProject);
      setReviewCycle((current) => ({
        ...current,
        userInstruction: ''
      }));

      const nextResult = await postJson('/api/proposal', {
        ...revisedProject,
        topic: revisedProject.topic || revisedProject.title,
        requirements: DEFAULT_REQUIREMENTS
      });
      const nextPdfUrl = await exportPdfUrl(nextResult.proposalLatex, revisedProject.title || 'proposal');

      setResult(nextResult);
      updatePdfUrl(nextPdfUrl);
      setRunLog((current) => [
        ...current,
        logEntry('Review', revision.runMessage || 'Applied selected critique fixes.'),
        logEntry('Draft', `Regenerated proposal after review cycle using ${nextResult.mode}.`)
      ]);
      setActiveTab('evaluation');
    } catch (requestError) {
      setError(readError(requestError));
    } finally {
      setReviewStatus('idle');
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
      activeStage
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
      setActiveTab(snapshot.activeTab || 'pdf');
      setSuggestionIndex(Number(snapshot.suggestionIndex || 0));
      setDecisionIndex(Number(snapshot.decisionIndex || 0));
      setActiveStage(Number.isFinite(Number(snapshot.activeStage)) ? Number(snapshot.activeStage) : 0);
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
              <button className="secondary" disabled={status !== 'idle'} onClick={startSampleAgent} type="button">
                <Sparkles size={18} aria-hidden="true" />
                Sample
              </button>
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

          {activeStage === 0 ? (
            <div className="workspace-grid stage-single">
              <section className="workspace-panel suggestions-panel">
                {false && (
                  <>
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
                                className={project[currentSuggestion.field] === currentSuggestion.value ? 'secondary accepted' : 'primary'}
                                type="button"
                                onClick={() => acceptSuggestion(currentSuggestion)}
                              >
                                <CheckCircle2 size={16} aria-hidden="true" />
                                {project[currentSuggestion.field] === currentSuggestion.value ? 'Accepted' : 'Accept and Next'}
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
                                project[suggestion.field] === suggestion.value ? 'done' : ''
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
                  </>
                )}

                <section className="literature-inline">
                  <PanelHeader title="Literature Explorer" meta={`${selectedPaperCount} selected`} />
                  <div className="selected-papers-bar">
                    <div className="selected-papers-bar-info">
                      <span>Selected Papers Workspace</span>
                      <strong>{selectedPaperCount}</strong>
                    </div>
                    <button
                      className="secondary"
                      type="button"
                      onClick={openSelectedPapersModal}
                      disabled={!selectedPaperCount}
                    >
                      Open Reader
                    </button>
                  </div>
                  {literature.papers.length ? (
                    <>
                      <div className="literature-summary literature-inline-card">
                        <div className="literature-actions">
                          <button
                            className="secondary icon-button literature-action-icon"
                            type="button"
                            onClick={selectAllPapers}
                            disabled={!literature.papers.length || selectedPaperCount === literature.papers.length}
                            title="Select all papers"
                            aria-label="Select all papers"
                          >
                            <CheckCircle2 size={16} aria-hidden="true" />
                          </button>
                          <button
                            className="secondary icon-button literature-action-icon"
                            type="button"
                            onClick={deselectAllPapers}
                            disabled={!selectedPaperCount}
                            title="Deselect all papers"
                            aria-label="Deselect all papers"
                          >
                            <RefreshCw size={16} aria-hidden="true" />
                          </button>
                        </div>
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
                              <div className="paper-tags">
                                {(paper.queryHits || []).slice(0, 3).map((query) => (
                                  <span key={`${paperKey}-${query}`}>{query}</span>
                                ))}
                              </div>
                              <div className="deck-actions">
                                <button
                                  className={isSelected ? 'secondary accepted icon-button paper-read-icon' : 'secondary icon-button paper-read-icon'}
                                  type="button"
                                  onClick={() => togglePaperSelection(paper)}
                                  title={isSelected ? 'Selected for reading' : 'Select for reading'}
                                  aria-label={isSelected ? 'Selected for reading' : 'Select for reading'}
                                >
                                  {isSelected ? <CheckCircle2 size={16} aria-hidden="true" /> : <BookOpen size={16} aria-hidden="true" />}
                                </button>
                              </div>
                            </article>
                          );
                        })}
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
            <div className="workspace-grid stage-single">
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

                <section className="custom-note">
                  <h3>Extra Note</h3>
                  <textarea
                    value={customNote}
                    onChange={(event) => setCustomNote(event.target.value)}
                    placeholder={currentQuestion?.question || 'Add a detail the options missed.'}
                  />
                  <button className="primary" disabled={!customNote.trim() || status !== 'idle'} onClick={submitCustomNote} type="button">
                    {status === 'answering' ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
                    Let LLM Integrate
                  </button>
                </section>

                <section className="gap-panel gap-decision-card">
                  <div className="gap-decision-header">
                    <h3>Research Gap Detector</h3>
                    <button
                      className="secondary"
                      type="button"
                      onClick={detectResearchGaps}
                      disabled={gapStatus !== 'idle' || literature.papers.length < 8}
                    >
                      {gapStatus === 'running' ? <Loader2 className="spin" size={16} aria-hidden="true" /> : null}
                      Detect Gaps
                    </button>
                  </div>
                  <p className="gap-hint">Uses top retrieved papers automatically (not manual paper selections).</p>
                  <p className="gap-hint">Top-paper pool: {Math.min(24, literature.papers.length)} / {literature.papers.length || 0}</p>
                  {gapResult.rankedGaps?.length ? (
                    <ol className="gap-list">
                      {gapResult.rankedGaps.map((gap) => {
                        const isSelected = activeGap?.id === gap.id;

                        return (
                          <li key={gap.id} className={isSelected ? 'gap-item gap-item-active' : 'gap-item'}>
                            <div className="gap-item-topline">
                              <strong>{gap.title}</strong>
                              <span className="priority medium">{gap.overallScore}</span>
                            </div>
                            <p className="gap-addresses"><strong>{gap.category || 'Gap'}</strong> - {gap.confidenceLabel || 'partially explored'}</p>
                            <p className="gap-description">{gap.description}</p>
                            <small className="gap-rationale">{gap.rationale}</small>
                            <div className="gap-metrics">
                              <span>Novelty: {gap.novelty}</span>
                              <span>Feasibility: {gap.feasibility}</span>
                              <span>Data Availability: {gap.availableData}</span>
                              <span>Relevance: {gap.relevance}</span>
                              <span>Proposal Potential: {gap.proposalPotential}</span>
                            </div>
                            {gap.researchQuestion ? (
                              <p className="gap-check gap-question">Research question: {gap.researchQuestion}</p>
                            ) : null}
                            <div className="deck-actions">
                              <button className="secondary" type="button" onClick={() => setSelectedGapId(gap.id)}>
                                Consider
                              </button>
                              <button className="primary" type="button" onClick={() => adoptGap(gap)}>
                                Use This Gap
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <p className="gap-hint">No gap run cached yet.</p>
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
                <button className="primary" disabled={!project.title || status !== 'idle'} onClick={generateProposal} type="button">
                  {status === 'drafting' ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
                  Generate Proposal
                </button>
              </section>
            </div>
          ) : null}

          {activeStage === 3 ? (
            <div className="workspace-grid stage-single">
              <section className="workspace-panel state-panel">
                <PanelHeader title="Draft Proposal" meta={project.title ? 'Ready to generate' : 'Needs title'} />
                <p className="stage-copy">Generate proposal artifacts from the assembled project state.</p>
                <button className="primary" disabled={!project.title || status !== 'idle'} onClick={generateProposal} type="button">
                  {status === 'drafting' ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
                  Generate Proposal
                </button>
                {result ? <p className="stage-copy">A draft already exists. Open Review for matrix and critique outputs.</p> : null}
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

              <section className="workflow-panel artifacts-panel">
                <div className="artifact-toolbar">
                  <nav className="tabs" aria-label="Generated artifacts">
                    {TABS.map(([id, Icon, label]) => (
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
                  <button className="secondary" type="button" disabled={!result?.proposalLatex} onClick={downloadLatex}>
                    <Download size={17} aria-hidden="true" />
                    LaTeX
                  </button>
                  <button
                    className="primary"
                    type="button"
                    disabled={!result?.proposalLatex || status !== 'idle'}
                    onClick={downloadPdf}
                  >
                    {status === 'exporting' ? <Loader2 className="spin" size={17} aria-hidden="true" /> : <Download size={17} aria-hidden="true" />}
                    PDF
                  </button>
                </div>

                <div className="artifact-summary">
                  <div>
                    <span>Coverage</span>
                    <strong>{matrixStats.total ? `${matrixStats.covered}/${matrixStats.total}` : '0/0'}</strong>
                  </div>
                  <div>
                    <span>Accepted</span>
                    <strong>{acceptedCount}/{PROJECT_FIELDS.length}</strong>
                  </div>
                  <div className="provider-metric">
                    <span>Provider</span>
                    <strong className="provider-value" title={result?.provider || 'waiting'}>{result?.provider || 'waiting'}</strong>
                  </div>
                </div>

                {activeTab === 'evaluation' ? (
                  <div className="review-cycle-wrap">
                    <div className="markdown-output">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{result?.evaluationReport || ''}</ReactMarkdown>
                    </div>

                    <section className="review-cycle-panel">
                      <div className="review-cycle-header">
                        <h3>Reviewer Agent Cycle</h3>
                        <button
                          className="secondary"
                          type="button"
                          onClick={runReviewerCritique}
                          disabled={reviewStatus !== 'idle' || !result?.proposalLatex}
                        >
                          {reviewStatus === 'critiquing' ? <Loader2 className="spin" size={16} aria-hidden="true" /> : null}
                          Run Reviewer Critique
                        </button>
                      </div>
                      <p className="review-cycle-hint">Cycle pattern: critique {'->'} change {'->'} critique {'->'} change. You control which fixes are applied.</p>

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

                      <button
                        className="primary"
                        type="button"
                        onClick={applyReviewChanges}
                        disabled={reviewStatus !== 'idle' || (!selectedCritiques.length && !reviewCycle.userInstruction.trim())}
                      >
                        {reviewStatus === 'revising' ? <Loader2 className="spin" size={16} aria-hidden="true" /> : null}
                        Apply Selected Changes and Regenerate
                      </button>
                    </section>
                  </div>
                ) : (
                  renderArtifact(activeTab, result, pdfUrl)
                )}
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
                        <div className="paper-tags">
                          {(activeSelectedPaper.queryHits || []).slice(0, 4).map((query) => (
                            <span key={`${paperStableId(activeSelectedPaper)}-${query}`}>{query}</span>
                          ))}
                        </div>
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

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
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

function paperStableId(paper) {
  if (paper?.paperId) return `pid:${paper.paperId}`;
  if (paper?.doi) return `doi:${paper.doi}`;
  return `title:${String(paper?.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
}

export default App;
