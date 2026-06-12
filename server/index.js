import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { retrieveLiterature } from './literatureRetriever.js';
import { proposalLatexToPdf } from './pdfExport.js';
import {
  answerAgentQuestion,
  critiqueProposal,
  generateEvalReport,
  generateProposal,
  reviseProposalFromCritique,
  startAgentSession
} from './proposalGenerator.js';
import { detectResearchGaps } from './researchGapDetector.js';

const app = express();
const port = Number(process.env.PORT || 8787);

app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    mode: process.env.LLM_API_KEY ? 'api-ready' : 'local-fallback'
  });
});

app.post('/api/agent/start', async (request, response) => {
  try {
    const payload = request.body || {};

    if (!String(payload.topic || '').trim()) {
      response.status(400).json({ error: 'Topic is required.' });
      return;
    }

    response.json(await startAgentSession(payload));
  } catch (error) {
    response.status(500).json({
      error: 'Agent start failed.',
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post('/api/agent/answer', async (request, response) => {
  try {
    const payload = request.body || {};

    if (!String(payload.answer || '').trim()) {
      response.status(400).json({ error: 'Answer is required.' });
      return;
    }

    response.json(await answerAgentQuestion(payload));
  } catch (error) {
    response.status(500).json({
      error: 'Answer integration failed.',
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post('/api/proposal', async (request, response) => {
  try {
    const payload = request.body || {};

    if (!String(payload.topic || '').trim()) {
      response.status(400).json({ error: 'Topic is required.' });
      return;
    }

    const result = await generateProposal(payload);
    response.json(result);
  } catch (error) {
    response.status(500).json({
      error: 'Proposal generation failed.',
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post('/api/literature', async (request, response) => {
  try {
    const payload = request.body || {};

    if (!String(payload.topic || '').trim()) {
      response.status(400).json({ error: 'Topic is required.' });
      return;
    }

    response.json(await retrieveLiterature(payload));
  } catch (error) {
    response.status(500).json({
      error: 'Literature retrieval failed.',
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post('/api/research-gaps', async (request, response) => {
  try {
    const payload = request.body || {};

    if (!String(payload.topic || '').trim()) {
      response.status(400).json({ error: 'Topic is required.' });
      return;
    }

    if (!Array.isArray(payload.papers) || !payload.papers.length) {
      response.status(400).json({ error: 'papers is required.' });
      return;
    }

    response.json(await detectResearchGaps(payload));
  } catch (error) {
    response.status(500).json({
      error: 'Research gap detection failed.',
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post('/api/eval-report', async (request, response) => {
  try {
    const payload = request.body || {};
    if (!String(payload.project?.topic || payload.project?.title || payload.topic || '').trim()) {
      response.status(400).json({ error: 'Project topic is required.' });
      return;
    }
    response.json(await generateEvalReport(payload));
  } catch (error) {
    response.status(500).json({
      error: 'Evaluation report generation failed.',
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post('/api/review/critique', async (request, response) => {
  try {
    const payload = request.body || {};

    if (!String(payload?.project?.title || payload?.project?.topic || payload?.topic || '').trim()) {
      response.status(400).json({ error: 'Project topic or title is required.' });
      return;
    }

    response.json(await critiqueProposal(payload));
  } catch (error) {
    response.status(500).json({
      error: 'Reviewer critique failed.',
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post('/api/review/revise', async (request, response) => {
  try {
    const payload = request.body || {};

    if (!payload.project) {
      response.status(400).json({ error: 'project is required.' });
      return;
    }

    response.json(await reviseProposalFromCritique(payload));
  } catch (error) {
    response.status(500).json({
      error: 'Reviewer revision failed.',
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post('/api/export/pdf', async (request, response) => {
  try {
    const payload = request.body || {};
    const latex = String(payload.proposalLatex || '').trim();

    if (!latex) {
      response.status(400).json({ error: 'proposalLatex is required.' });
      return;
    }

    const title = String(payload.title || 'proposal').trim();
    const pdf = await proposalLatexToPdf(latex, title);

    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Disposition', 'attachment; filename="proposal.pdf"');
    response.send(pdf);
  } catch (error) {
    response.status(500).json({
      error: 'PDF export failed.',
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.listen(port, () => {
  console.log(`Proposal API listening on http://127.0.0.1:${port}`);
});
