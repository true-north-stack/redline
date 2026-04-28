---
name: redline:ux-review
description: Run a UX Audit Framework review (55 principles including the Steve Jobs Pitch) on a component, page, or recent changes. Produces a structured report with violations, flags, and passes.
argument-hint: "[component path or description]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Agent
---

# UX Review — UX Audit Framework

Structured review of UI/UX work against the complete UX Audit Framework (54 established principles) plus the Steve Jobs Pitch (#55). Produces actionable findings, not vague praise.

Full reference: `~/.claude/docs/UX_AUDIT_FRAMEWORK.md`

## What to Review

If an argument is provided, review that component/page. Otherwise, review recently changed UI files (check `git diff` for modified `.tsx` files).

## How to Run the Review

### 1. Identify What's Being Reviewed

Read the relevant component/page files. If reviewing a live page, use browser tools to capture the current state.

### 2. Evaluate Against All Applicable Laws

Score each applicable law: **Pass**, **Flag** (minor concern), **Violation** (needs fixing). Read `~/.claude/docs/UX_AUDIT_FRAMEWORK.md` for full details on any law you're uncertain about.

#### UX Theory (29 laws)

**Always evaluate — core product UI laws:**

| # | Law | Key Question |
|---|-----|-------------|
| 1 | **Aesthetic-Usability Effect** | Does visual quality match the product standard? Beautiful = perceived as more usable |
| 2 | **Doherty Threshold** | Will interactions feel responsive (<400ms)? Progress bars for waits? |
| 3 | **Fitts' Law** | Are touch targets large enough? Primary actions easy to reach? |
| 4 | **Hick's Law** | Too many choices? Could options be reduced, staged, or recommended? |
| 5 | **Jakob's Law** | Does this follow conventions users expect from similar products? |
| 6 | **Miller's Law** | Is the user asked to hold >7 items in working memory? Content chunked? |
| 7 | **Law of Proximity** | Are related elements grouped? Unrelated elements separated? |
| 8 | **Law of Common Region** | Do borders/backgrounds clarify grouping? |
| 9 | **Law of Similarity** | Do visually similar elements share meaning? Links distinct from text? |
| 10 | **Tesler's Law** | Is complexity handled by the system, not pushed to the user? |
| 11 | **Occam's Razor** | Can any element be removed without losing function? |

**Evaluate when relevant:**

| # | Law | When to Check |
|---|-----|--------------|
| 12 | **Goal-Gradient Effect** | Multi-step flows, progress indicators, onboarding |
| 13 | **Law of Pragnanz** | Complex layouts — can the user parse the simplest shape? |
| 14 | **Law of Uniform Connectedness** | Related data, parent-child relationships, visual connections |
| 15 | **Pareto Principle** | Feature prioritization — does 20% of UI serve 80% of use? |
| 16 | **Parkinson's Law** | Time-sensitive tasks, form completion — does UI prevent inflation? |
| 17 | **Postel's Law** | Form inputs, user-provided data — tolerant of varied input? |
| 18 | **Peak-End Rule** | Onboarding, checkout, completion flows — peak and end moments? |
| 19 | **Serial Position Effect** | Navigation, lists, tab ordering — important items first/last? |
| 20 | **Von Restorff Effect** | CTAs, alerts — does the important thing visually stand out? |
| 21 | **Zeigarnik Effect** | Setup wizards, incomplete states — do incomplete tasks pull users back? |
| 22 | **Campbell's Law** | Metrics-driven UI — could the metric be gamed? |
| 23 | **Stroop Effect** | Conflicting signals — does a destructive button look safe? |
| 24 | **Simon Effect** | Is the action control near where the result appears? |
| 25 | **Accot-Zhai Steering Law** | Dropdown menus, sliders, path-following elements — wide enough? |
| 26 | **Law of Closure** | Icons, simplified visuals — are they recognizable? |
| 27 | **Law of Continuity** | Element alignment — do elements create visual flow? |
| 28 | **Paradox of the Active User** | Will users skip docs and jump in? Is guidance contextual? |
| 29 | **Principle of Least Effort** | Multi-step actions — is this the minimum effort path? |

#### Interaction Principles (7)

| # | Principle | Key Question |
|---|-----------|-------------|
| 30 | **Discoverability** | Can users find what's possible? Clear focal points and hierarchy? |
| 31 | **Affordances** | Does the form imply the function? Buttons look clickable? |
| 32 | **Signifiers** | Are there visible cues showing where/how to interact? |
| 33 | **Feedback** | Does the system confirm what action was taken? Loading states? |
| 34 | **Mapping** | Do controls relate spatially to what they affect? |
| 35 | **Constraints** | Do physical/logical limits prevent errors? |
| 36 | **Conceptual Model** | Does the UI match users' mental model of how it should work? |

#### Psychology Concepts (9)

| # | Concept | When to Check |
|---|---------|--------------|
| 37 | **Cognitive Load** | Dense UIs — is intrinsic load minimized? Extraneous load eliminated? |
| 38 | **Cognitive Bias** | Decision UIs — could confirmation bias or anchoring mislead users? |
| 39 | **Cognitive Dissonance** | Does the UI deliver what its affordances promise? |
| 40 | **Mental Model** | Does the design match how users think this should work? |
| 41 | **Chunking** | Is information grouped into meaningful, scannable chunks? |
| 42 | **Selective Attention** | Could banner blindness or change blindness cause missed info? |
| 43 | **Analysis Paralysis** | Too many options without guidance? Need filtering/recommendations? |
| 44 | **Flow** | Is task difficulty balanced with user skill? No friction breaking flow? |
| 45 | **Short-Term Memory** | Is the system remembering things so the user doesn't have to? |

#### UX Methods (applicable during design phase)

| # | Method | When to Recommend |
|---|--------|------------------|
| 46 | **Card Sorting** | Information architecture decisions — uncertain about grouping |
| 47 | **Design Principles** | Team alignment — inconsistent design decisions |
| 48 | **Journey Mapping** | Multi-step flows — need to understand emotional peaks/valleys |
| 49 | **User Personas** | Target audience unclear — who is this for? |
| 50 | **Usability Test** | Complex interactions — need real user validation |
| 51 | **User Interview** | Unclear requirements — need to understand user mental models |
| 52 | **Affinity Mapping** | Post-research — need to synthesize findings into themes |
| 53 | **UX Survey** | Need quantitative user feedback at scale |
| 54 | **Contextual Inquiry** | Need to observe users in their real environment |

#### The Steve Jobs Pitch (always evaluate last)

| # | Check | Key Question |
|---|-------|-------------|
| 55 | **The Steve Jobs Law** | We're walking into a room to pitch this to Steve Jobs. Will he invest — or will he fire us on the spot? |

This is the capstone law. Evaluate AFTER all other laws. Imagine you're demoing this feature to SJ — not as peers, but as the team showing him what we built. He's sitting across the table, arms crossed, waiting to be impressed. He will click every button, ask why everything exists, and find every crack. This law synthesizes everything into one question: **would we survive the pitch?**

**The six checks:**

1. **Is it pitch ready?** We're about to walk SJ through this live. Every button works. Every link goes somewhere. Every action completes its full cycle from click to database to UI update. No placeholders, no TODOs, no "we'll fix it later." If we have to say "oh, that part isn't done yet" — the pitch is over. He's already checked out.

2. **Will SJ fire us?** He's clicking around now. Dead buttons, broken flows, console errors, missing loading states, actions that silently fail — any of these and we're done. Not "let's revisit this" done. Fired. The bar is zero tolerance for broken interactions, because broken interactions tell him we don't care about the details.

3. **What questions will SJ ask?** He points at something: "What happens when I click this?" "Where does this data come from?" "Why is this here?" "What if there's no data?" Every element must have a clear answer. If we stammer, if we say "well, that's just a placeholder" — he knows we shipped without thinking. Before the pitch, ask his questions for him and have the answers built in.

4. **What gaps will he discover?** He will find them. Empty states without guidance. Missing confirmation on destructive actions. Flows that dead-end. Data that doesn't save. A dropdown with one option that should be auto-selected. He doesn't just use the happy path — he tries to break it. Close every gap before he walks in the room.

5. **Does it excite him?** He's seen "it works" a thousand times. What makes him lean forward? Craft. A transition that feels effortless. Data that appears before you ask for it. An interaction so intuitive it needs no explanation. The difference between "fine" and "show me more." If we can't point to one moment that would make him say "that's nice" — we haven't pushed hard enough.

6. **Does everything work E2E?** He's doing the full walkthrough now. The action button says what it will do — and does it. The link takes him where it says. Form submission saves. Delete actually deletes. Cancel actually cancels. The toast confirms what happened. The page reflects the change. No errors. No confusion. No "wait, let me refresh." The full pipeline from intent to outcome is seamless — because that's the only version SJ accepts.

**Scoring:** If ANY of checks 1-4 fail, it's a **Violation** — we don't survive the pitch. Check 5 is a **Flag** — we survive but don't get a second meeting. Check 6 failing is an automatic **Violation** — the pitch ends the moment something doesn't work.

### 3. Output Format

Default to the **skim summary**. Keep it short. Plain English. No law numbers in the headline lines unless the user asks for detail (or passes `--full`).

```
## UX Review: [Component/Page Name]

**Verdict:** [one short sentence — is this good, okay, or broken?]

**Fix now (N):**
- [Plain-English issue]. [One-line fix]. — `file:line`
- ...

**Worth a look (N):**
- [Plain-English concern]. — `file:line`
- ...

**Working well (N):**
- [What's good, in one short phrase]
- ...

**Top priority:** [one sentence — the single most important thing to do next]
```

Rules for the skim format:
- One line per item. No paragraphs.
- Plain English first. The law name in parens at the end only if it adds clarity, e.g. `Dropdown has 12 options with no default (Hick's Law)`.
- Cap each section at ~5 items. If there are more, list the top 5 and add `+N more — ask for --full`.
- Skip "Methods to consider" in skim mode unless one is critical.
- No preamble, no closing fluff. Just the report.

If the user passes `--full` (or asks for detail), expand to the long format with every law cited by number, methods section, and pass justifications.

### 4. Rules

- **Skim by default.** Long form only on request.
- **Be specific but brief.** "12 options in the dropdown, no default" beats "too many choices" and beats a paragraph.
- **Prioritize.** Fix-now first, worth-a-look second, working-well last.
- **No fluff.** Skip laws that don't apply. Don't pad with praise.
- **Reference the file.** `file_path:line_number` on every finding.
- **Every fix-now needs a one-line fix.** No diagnoses without remedies.
- **Read the full reference** (`~/.claude/docs/UX_AUDIT_FRAMEWORK.md`) for any law you're unsure about before scoring — but the user-facing report stays short.
