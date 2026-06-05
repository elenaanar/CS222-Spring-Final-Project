# Update

Stage 2 and Stage 3 have been merged into a single **Stage 2**.

- **Stage 2 Part 1** now only requires source code for your refined agent or workflow. You do not need to submit `workflow_usage.md`, run logs, screenshots, transcripts, demo evidence, or `AI_USAGE.md` for Part 1.
- **Stage 2 Part 2** is the final proposal submission: `proposal.pdf`, proposal source, references or source notes, and figure or diagram source if applicable.

# Two-Stage Final Project: Research Proposal Agent

## Goal

Build and evaluate a research proposal workflow. The project is not just about producing one polished PDF. It asks you to show that you understand how strong proposals are written, how an agent can support that process, and how the final proposal can be evaluated.

You will complete the final project in two stages:

1. **Stage 1: Initial Agent + Workflow Design**
   - Build an initial agent or prototype through vibe coding.
   - Research proposal-writing guides, examples, and agent workflow patterns.
   - Submit a 5-minute presentation video of your workflow design.
   - Attend the mandatory in-person presentation session to show your motivation, idea, and goal.
   - A polished proposal is not required in this stage.

2. **Stage 2: Refined Agent + Final Proposal**
   - **Part 1: Source Code.** Refine the Stage 1 agent or workflow and submit the source code.
   - **Part 2: Final Proposal.** Submit the final `proposal.pdf`.
   - The proposal is graded separately for research proposal quality.
   - The proposal should not be framed as a short course implementation report; the course deadline and the proposed research timeline are separate.

Part 1 credit is based on the submitted source code for your refined agent or workflow. You do not need to submit workflow usage evidence. Part 2 credit is based on the final proposal quality.

## Deadlines And Submission Requirements

All deadlines use Pacific Time.

| Stage | Due Date | Submit | Notes |
| --- | --- | --- | --- |
| Stage 1: Initial Agent + Workflow Design | Friday, June 5, 2026, 11:59 PM | 5-minute presentation video, initial agent/prototype artifact, optional screenshots or interaction trace. | Stage 1 is graded from the video. The in-person presentation is mandatory but not separately graded; it is for showing motivation, ideas, goals, and peer feedback. Late submissions accepted until Sunday, June 7, 2026, 11:59 PM with a 20% penalty. |
| Stage 2 Part 1: Refined Source Code | Friday, June 12, 2026, 11:59 PM | Source code for the refined agent or workflow. | Part 1 does not require `workflow_usage.md`, run logs, screenshots, transcripts, demo evidence, or `AI_USAGE.md`. Late submissions accepted until Sunday, June 14, 2026, 11:59 PM with a 20% penalty. |
| Stage 2 Part 2: Final Proposal | Friday, June 12, 2026, 11:59 PM | `proposal.pdf`, proposal source, references or source notes, figure/diagram source if applicable. | The proposal is graded for research proposal quality. Late submissions accepted until Sunday, June 14, 2026, 11:59 PM with a 20% penalty. |

## Optional Starter App

This repository includes a small starter app to illustrate one possible proposal-agent workflow. It is optional: you may use it, replace it, or ignore it.

Example starter screens:

![Starter app workflow screen](docs/assets/starter-app-workflow.png)

![Starter app proposal preview screen](docs/assets/starter-app-proposal-preview.png)

To run the starter:

```bash
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:5174
```

We encourage students to start with the [Gemini API free tier](https://ai.google.dev/gemini-api/docs/pricing). If the free tier is not enough for your project, email the TA at <yfu093@ucr.edu> to request additional API access. Keep all API keys out of GitHub and document your setup.

## Resources

Vibe coding tools:

- [Cursor](https://cursor.com/en/students). Students can apply for a student account with their `.edu` email; contact Cursor through the official student page if you need help with the application.
- [GitHub Copilot](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/enable-copilot/set-up-for-students)
- [Google Gemini API](https://ai.google.dev/gemini-api/docs/pricing)
- [Google Gemini Code Assist](https://developers.google.com/gemini-code-assist/resources/faqs)
- [Claude / Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)
- [Windsurf](https://windsurf.com/windsurf/students)
- [Cline](https://docs.cline.bot/introduction/overview) / [Roo Code](https://roocode.com/)
- [ChatGPT](https://chatgpt.com/)
- [v0 by Vercel](https://v0.dev/)

Tool availability, student plans, and free tiers can change. Check the official pages before relying on a specific plan.

Proposal-agent inspiration:

- [Civio](https://www.civio.ai/) shows how proposal and compliance workflows can become real products. A strong class project can be more than a demo; it can point toward a startup-style opportunity if it solves a real workflow pain.

## Stage 1 Deliverables

Stage 1 focuses on initial agent design and workflow thinking. A polished proposal is not required.

Submit:

- initial agent or prototype demo artifact;
- 5-minute presentation video or link;
- mandatory in-person presentation for demonstration and feedback;
- optional screenshots or interaction trace.

Details: [docs/stage_1_workflow_design.md](docs/stage_1_workflow_design.md)

## Stage 2 Deliverables

Stage 2 has two parts: refined source code and the final proposal.

### Part 1: Refined Source Code

Submit:

- source code for your refined agent or workflow.

### Part 2: Final Proposal

Part 2 focuses on final proposal quality.

Submit:

- `proposal.pdf`;
- `proposal.tex` or equivalent proposal source;
- references or source notes;
- figure or diagram source if applicable.

Details: [docs/stage_3_final_proposal.md](docs/stage_3_final_proposal.md)

## Required Proposal Requirements

The final proposal requirements are in:

[docs/proposal_requirements.md](docs/proposal_requirements.md)

Detailed grading is in one file:

[docs/grading_rubric.md](docs/grading_rubric.md)

## Grading Overview

Total: 100 points.

Bonus: up to 5 subjective points for unusually impressive work.

| Stage | Points | What It Evaluates |
| --- | ---: | --- |
| Stage 1: Initial Agent + Workflow Design | 30 | Initial agent/prototype, vibe coding demo, proposal-writing research, workflow thinking, and presentation. |
| Stage 2 Part 1: Refined Source Code | 20 | Quality and completeness of the submitted source code for the refined agent or workflow. |
| Stage 2 Part 2: Final Proposal | 50 | Quality of the submitted `proposal.pdf`, including format, figure, logic, novelty, method, evaluation, feasibility, and writing. |

Detailed grading: [docs/grading_rubric.md](docs/grading_rubric.md)

## Suggested Repo Layout

```text
.
├── README.md
├── proposal.pdf
├── proposal.tex
├── references-or-source-notes/
├── figure-or-diagram-source/
└── source-code-or-workflow/
```

## Bottom Line

Stage 1 asks: **What is your initial agent and proposal-writing workflow idea?**

Stage 2 Part 1 asks: **Did you refine the agent/workflow and submit its source code?**

Stage 2 Part 2 asks: **Is the final proposal itself strong?**
