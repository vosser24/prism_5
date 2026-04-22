---
name: video-production
description: >
  Create professional videos using Remotion + Claude Code.
  Use when user says "make a video", "create a TikTok", "create a Reel",
  "YouTube Short", "record a demo", "product video", "explainer video",
  "video about", "produce a clip", "motion graphics", "animate",
  "screen recording", "video for social media", "render a video",
  "viral" (any viral content request), "promote my [app/product/project]",
  "screenshot my app for video", "record a flow", "capture checkout",
  "make a promo", "launch video", "marketing video", "demo reel".
  Transforms vague prompts into optimized Remotion compositions.
  Auto-hires specialist agents (@viral-tiktok-producer, @[app]-app-expert)
  when needed. NEVER activate for non-video tasks.
---

# Video Production Skill — Remotion + Claude Code

## PREREQUISITES CHECK (run ONCE per project)
Before creating any video, verify the workspace:
```
0. CONTEXT — does the project have a CONTEXT.md file?
   Check: project-root/CONTEXT.md (or docs/CONTEXT.md)
   If YES: READ IT FIRST. It contains:
     - What the product is
     - Target audience
     - Key features to highlight
     - Brand voice and tone
     - Visual style preferences
     - Good demo moments / hooks to use
     - What to AVOID
   This is the ground truth for any video content.
   
   If NO: offer to CREATE a sales-grade CONTEXT.md:
     "I don't see a CONTEXT.md. Without it, I'll produce generic 
     marketing — not content that actually sells your product.
     
     I can build one now using proven SaaS positioning frameworks:
       - April Dunford's 'Obviously Awesome' (positioning)
       - Jobs-to-be-Done (what customers hire the product for)  
       - StoryBrand (hero's journey structure)
       - AIDA (Attention, Interest, Desire, Action)
     
     Options:
       A. Build CONTEXT.md — I'll ask 8 strategic questions
       B. I'll point you to existing docs (README, pitch deck)
       C. Describe inline — I'll extract and structure it
       D. Proceed without context (not recommended)
     Which? (A/B/C/D)"

   IF A — run SALES-GRADE CONTEXT GENERATION PROTOCOL:

### SALES-GRADE CONTEXT GENERATION (when user picks A)

Ask these 8 questions ONE AT A TIME (don't dump all at once):

```
Q1. POSITIONING (Dunford):
"What category does your product compete in? And more importantly, 
what makes it the BEST in that category for a specific type of 
customer? Not 'features' — the competitive alternative it replaces."

Examples that work:
  BAD:  "We're a task management app"
  GOOD: "Linear for teams who hated Jira's bloat but need more 
         power than Trello"

Q2. TARGET CUSTOMER (be specific):
"Describe ONE person who would pay you tomorrow. Their job title, 
what they're working on right now, what's frustrating them this week.
Don't give me a persona — give me a real human."

Q3. THE PAIN (JTBD — what they hire the product to do):
"What were they doing BEFORE they found your product? What workaround 
were they forced into? How painful was it — 1-10?"

Q4. THE MOMENT (trigger event):
"What event pushes someone to finally try your product? The moment 
where they say 'enough, I need a better way.'"

Q5. THE AH-HA (activation moment):
"When a new user becomes a true believer — what exactly happens? 
What's the one thing they do/see that makes them go 'oh, this is 
different'?"

Q6. UNIQUE MECHANISM (what makes it work):
"How does your product deliver results in a way competitors can't 
copy? This is your differentiator — not a feature, a mechanism."

Examples:
  WEAK:  "We have AI"
  STRONG: "We research your domain with NotebookLM first, so agents 
           have 50 sources of grounded knowledge before they answer"

Q7. PROOF (evidence they'll believe):
"What's the strongest proof you have that this works? A metric, 
a testimonial, a demo moment, a result from your own use. Not 
marketing claims — actual proof."

Q8. OBJECTION (what stops them):
"When someone sees your product and DOESN'T buy, what's the #1 
reason? Price? Trust? Complexity? Wrong category? Be honest — 
this is what your video must preempt."
```

AFTER collecting answers, GENERATE CONTEXT.md with this structure:

```markdown
# [PRODUCT NAME] — Context for Video Production

## ONE-LINE PITCH
[Dunford-style positioning statement that names the alternative]

## ALTERNATIVE HOOKS (for A/B testing)
- Hook 1 — Pain-focused: "[frustration] is killing your [outcome]. Here's the fix."
- Hook 2 — Curiosity: "I built [unexpected thing] and it [surprising result]"
- Hook 3 — Contrarian: "Everyone tells you to [common advice]. I found something better."
- Hook 4 — Social proof: "[N] developers switched from [competitor] to this"
- Hook 5 — Transformation: "From [before state] to [after state] in [timeframe]"

## THE CUSTOMER

### Primary audience
[From Q2 — specific person, not persona]

### They're currently stuck doing
[From Q3 — the workaround / painful old way]

### The moment they'll switch
[From Q4 — the trigger event]

## THE PROBLEM (what customers actually feel)

Before [product], [target customer] had to:
1. [Pain point 1 — concrete, not abstract]
2. [Pain point 2]
3. [Pain point 3]

Pain level: [N]/10 — this is what justifies them trying something new.

## THE SOLUTION (JTBD framing)

Customers hire [product] to:
- **Functional job:** [the practical outcome]
- **Emotional job:** [how they want to FEEL]
- **Social job:** [how they want to be SEEN]

## UNIQUE MECHANISM

[From Q6 — HOW it works differently, not WHAT it does]

This is what competitors can't easily copy:
- [Specific mechanism 1]
- [Specific mechanism 2]

## KEY FEATURES (ranked by "wow" factor)

[Extract 5-7 features from the mechanism. Rank by how much 
they make the ah-ha moment happen. Each feature includes:
- Name
- One-sentence explanation
- Demo moment (what to show in video)
- Why it matters (outcome, not feature)]

## PROOF POINTS (for video credibility)

[From Q7 — concrete evidence]
- Numbers/metrics
- Demo moments that prove the claim
- Testimonials or usage stats
- Before/after comparisons

## VIRAL HOOKS (for short-form video)

Proven hook templates applied to this product:

1. **Unexpected Result** (curiosity + credibility)
   "I [did specific thing with product] and [surprising outcome happened]"

2. **The Contrarian** (pattern interrupt)
   "Everyone's telling you to [X]. I tried [product] instead. Here's what happened."

3. **Pain Amplification** (relatable frustration)
   "If you've ever [specific frustration target customer feels], 
    you need to see this."

4. **Social Proof Cascade** (momentum)
   "[N] [target customer type] switched to this in [timeframe]. Here's why."

5. **Transformation Promise** (outcome-focused)
   "From [painful before state] to [desired after state] in [specific timeframe]. 
    Here's the exact process."

6. **The Demonstration** (show don't tell)
   "Watch me [specific task] in [impressively short time] using [product]."

## OBJECTION HANDLING (preempt in video)

[From Q8 — what stops conversions]

**Objection 1: "[Actual objection]"**
Counter: [specific response that addresses the real concern]
In-video proof: [what to show that disarms this objection]

[Repeat for top 3 objections]

## COMPETITIVE POSITIONING

**vs [Alternative 1]:** [How this is different/better for the target]
**vs [Alternative 2]:** [Specific advantage]  
**vs Doing nothing (status quo):** [Why the pain is worse than switching cost]

## BRAND GUIDELINES

### Colors
- Primary: [user input or ask]
- Accent: [user input or ask]
- Background: [user input or ask]

### Fonts  
- Display: [suggest based on brand tone]
- Code: [if relevant]

### Motion
- Style: [bouncy / snappy / smooth / brutal — match to tone]

### Tone
- [Extract from user's language in Q1-Q8]
- Example phrases: [capture their actual wording]

## WHAT TO AVOID (anti-patterns)

Based on target audience, DO NOT:
- ✗ Use generic category imagery (same as competitors)
- ✗ Use buzzwords they're tired of (list specific ones)
- ✗ Lead with features before establishing pain
- ✗ Use stock/corporate visuals if audience hates corporate
- ✗ Sound like every other [category] company

## DEMO MOMENTS (what to show in videos)

Strongest proof-of-value moments to capture:
1. [The ah-ha from Q5 — show this as hero moment]
2. [Specific feature demo that proves unique mechanism]
3. [Before/after transformation]
4. [Objection-busting moment]
5. [Social proof or metric reveal]

## VIDEO GOALS BY FUNNEL STAGE

### Top of funnel (awareness)
- 15-30s, hook-heavy, no feature deep-dive
- Goal: interrupt pattern, earn 3 seconds of attention
- Best hooks: pain amplification, contrarian, unexpected result

### Middle of funnel (interest)
- 30-60s, show the ah-ha moment
- Goal: prove the unique mechanism works
- Best format: demonstration, before/after

### Bottom of funnel (decision)
- 60s-3min, objection handling + proof stacking
- Goal: answer every doubt they have
- Best format: comparison, testimonial, extended demo

## CTA FRAMEWORK

### Soft CTA (awareness stage)
"Link in bio if you want to see how it works"

### Direct CTA (decision stage)  
"Install in 2 minutes — link in bio"

### Urgency CTA (limited offers only — don't fake it)
"[Specific time-limited reason to act now]"
```

After generating CONTEXT.md, SAVE IT to project root and tell user:
"Created CONTEXT.md. Review it — edit freely. This is the strategic 
foundation for all your videos. The specialist and skill will read 
this before every video build."

1. Is this a Remotion project? Check: package.json has "remotion" dependency
   If NO: "This isn't a Remotion project. Create one with: npx create-video@latest"
   
2. Are Remotion skills installed? Check: .claude/skills/remotion-best-practices/
   If NO: "Install skills: npx skills add remotion-dev/skills"

3. Is @remotion/google-fonts installed? Check: node_modules/@remotion/google-fonts/
   If NO: "npm install --save-exact @remotion/google-fonts"

4. Is Remotion Studio running? Remind user: "Run npm run dev in a separate terminal"

5. OPTIONAL — only if video needs screenshots from a web app:
   Is Playwright installed? Check: node_modules/@playwright/test/
   If NO and app-expert will be hired:
     npm install -D @playwright/test
     npx playwright install chromium
   If user declines, fall back to user-provided screenshots.
```

## QUICK MODE (skip heavy setup for fast iteration)

If user says "quick" / "just make it" / "skip setup" / "use defaults":
- SKIP brand kit 10-question setup → use sensible defaults
- SKIP viral specialist creation → use generic viral best practices
- SKIP app expert creation → ask for user-provided screenshots
- Render with minimal configuration

Activate quick mode when:
- User explicitly requests it
- User has no existing brand/specialists AND needs a video in <10 min
- User is iterating (making V2, V3 of same concept)

Quick mode defaults:
```typescript
const QUICK_BRAND = {
  colors: { primary: '#1B3A5C', accent: '#D4A84B', bg: '#0a0e1a', text: '#e2e8f0' },
  fonts: { display: 'DM Sans', code: 'JetBrains Mono' },
  motion: { entrance: { damping: 12, stiffness: 100, mass: 0.8 } },
};
```

Tell user: "Running in quick mode. You can upgrade later with full brand 
kit setup via: 'Set up my brand kit'"

## SPECIALIST AGENT TRIGGER (runs FIRST)

Before the prompt optimization protocol, check if this request needs deeper
specialist expertise. Some video types benefit from a dedicated agent.

### When to hire/create a specialist

Trigger words that require a specialist:
```
KEYWORD / PHRASE                   → REQUIRED SPECIALIST AGENT
────────────────────────────────────────────────────────────────────
"viral", "go viral", "engagement"  → @viral-tiktok-producer
"TikTok trends", "trending format" → @viral-tiktok-producer
"promote my product/app/project"   → @viral-tiktok-producer
"maximize views"                   → @viral-tiktok-producer
"hook that stops scroll"           → @viral-tiktok-producer
"high-conversion video"            → @viral-tiktok-producer
"YouTube Shorts strategy"          → @shorts-strategist (similar)
"Instagram Reels algorithm"        → @reels-strategist (similar)
"screenshot my app", "capture flow"→ @[app-name]-app-expert
"show the checkout/dashboard/etc" → @[app-name]-app-expert
```

### Agent hiring flow

Step 1 — Check if specialist exists:
```bash
# Read the roster to find a matching agent
cat ~/.claude/skills/atlas-plan/references/roster.json | grep -A5 "viral"
```

Step 2A — If agent EXISTS:
Hire directly. Example:
```
@viral-tiktok-producer I need to promote [project/app]. 
Analyze what makes a viral TikTok in this domain and design a 
30-second video concept. After your analysis, I'll use the 
video-production skill to build the Remotion composition.
```

The agent will produce a scene plan + hook + trend match.
The skill will then build it in Remotion.

Step 2B — If agent DOES NOT EXIST:
Spawn the factory to create it. Tell the user:
```
"For viral content, I should hire a @viral-tiktok-producer specialist.
It doesn't exist yet — I'll create one via @agent-factory.

This will:
- Research current TikTok viral patterns via NotebookLM (FREE)
- Study trending formats, hooks, and algorithm factors
- Create a permanent agent with deep expertise
- Cost: $0.00 (NotebookLM Tier 1) or ~$1-3 (Tier 3 fallback)
- Time: 20-40 minutes

Proceed? Say 'go' to create the agent, or 'skip' to use my 
generic knowledge (lower quality for viral content)."
```

If user says go → spawn factory with this blueprint:

**CRITICAL: Use the Task tool to invoke @agent-factory. Paste the FULL
blueprint below as the task description. After factory completes, verify
the agent has `notebook_id` in its frontmatter (generated by factory
during NotebookLM research). If missing, the agent won't have living
knowledge.**

```
@agent-factory

Create a @viral-tiktok-producer specialist agent.

DOMAIN: Viral short-form video production for TikTok, YouTube Shorts, 
Instagram Reels. Focus on 15-60 second vertical videos that promote 
products, apps, tools, or projects.

TIER 1 RESEARCH — Run these NotebookLM queries (3 queries minimum):

Query 1: "TikTok viral algorithm factors 2026 watch time completion 
rate hook rate share velocity For You Page ranking signals"

Query 2: "TikTok trending video formats 2026 hooks templates 
storytelling structures 15 second 30 second pacing attention 
retention techniques"

Query 3: "Product promotion TikTok strategy app marketing SaaS dev 
tools viral examples CTA placement link in bio conversion best 
practices 2026"

Additional research angles (add more queries if gaps):
- Developer tool marketing on TikTok (tech creators, viral dev content)
- Short form hook templates (first 2-3 second patterns)
- Text overlay design for mute viewing (80% watch muted)
- Sound strategy (trending audio vs original voiceover)
- Posting schedule and analytics interpretation

PRECISION QUESTIONS (Q1-Q5 for NotebookLM):

Q1: What are the specific algorithmic signals TikTok's FYP uses to 
    rank content in 2026? Include watch time thresholds, completion 
    rate percentages, share velocity metrics, and comment engagement 
    factors. Distinguish between initial push (first 200 views) and 
    sustained push.

Q2: What are the 10 most effective hook patterns for viral TikToks 
    in 2026, specifically for promoting developer tools, apps, or 
    software products? Include pattern name, template, example, and 
    why it works psychologically.

Q3: For a 30-second product promotion video, what is the optimal 
    scene structure (beat-by-beat breakdown)? Include timestamps, 
    visual actions, text overlay strategy, and audio design for each 
    beat.

Q4: How should text overlays be designed for maximum impact on 
    muted viewing? Include font choices, size hierarchy, color 
    contrast, animation timing, and safe zone rules for 2026 TikTok 
    UI (which covers parts of the screen).

Q5: What are the most common viral video anti-patterns that kill 
    engagement? Why do they fail? Include examples of "corporate" 
    feel, weak hooks, CTA timing mistakes, and hashtag misuse.

AGENT CAPABILITIES (build these into the agent):

1. CONTEXT ANALYSIS — given a product/app/project, identify:
   - Target audience (developers? consumers? students? businesses?)
   - Pain point the product solves
   - Differentiator vs competitors
   - Best angle to present it

2. TREND MATCHING — map the product to current viral formats:
   - Which trending template fits? (POV, tutorial, before/after, 
     reaction, storytelling, listicle, etc.)
   - What trending audio pairs with it?
   - What hook template fits the audience?

3. SCENE DESIGN — produce a timed beat-by-beat breakdown:
   Scene 1 (0-3s): HOOK — specific text, visual, sound
   Scene 2 (3-8s): SETUP — what/why
   Scene 3 (8-20s): DEMO or VALUE — the meat
   Scene 4 (20-27s): PROOF — result, testimonial, data
   Scene 5 (27-30s): CTA — link in bio + action prompt

4. COPY WRITING — for every on-screen text element:
   - Hook text (first 2 seconds, MAX 8 words)
   - Section headers (6 words max)
   - CTA (3 words)
   - Caption (first line visible, 125 char optimal)
   - Hashtag strategy (mix of broad + niche + trending)

5. HANDOFF — produce a STRUCTURED SPEC the video-production skill builds.
   MUST use this exact JSON format for reliable handoff:
   
   ```json
   {
     "meta": {
       "title": "string — composition id",
       "duration_seconds": 30,
       "fps": 30,
       "format": "tiktok|reel|short|youtube",
       "width": 1080,
       "height": 1920
     },
     "brand": {
       "use_project_brand": true,
       "overrides": {}
     },
     "trending_audio": {
       "use": true|false,
       "name": "track name if known",
       "mood": "suspense|upbeat|inspirational|etc",
       "search_terms": "for user to find on pixabay/mixkit"
     },
     "voiceover": {
       "use": true|false,
       "script": "exact spoken words",
       "tone": "energetic developer|calm educator|dramatic|etc",
       "source": "notebooklm|user|piper|elevenlabs"
     },
     "scenes": [
       {
         "id": 1,
         "start_frame": 0,
         "end_frame": 90,
         "type": "hook|setup|demo|proof|cta",
         "visual": "detailed description of what's on screen",
         "animation": "spring entrance|fade|slide|typing|etc",
         "text_overlay": {
           "content": "exact text",
           "position": "center|top|bottom",
           "font_size": 72,
           "font_weight": 700,
           "color": "primary|accent|custom hex",
           "appears_at_frame": 5,
           "animation": "spring|fade|slide"
         },
         "assets_needed": [
           {
             "type": "screenshot|ai-image|audio|video",
             "filename": "public/audio/voiceover.mp3",
             "prompt": "if AI-generated: exact Gemini prompt",
             "instructions": "if screenshot: exact commands to capture"
           }
         ],
         "sfx": {
           "file": "public/audio/sfx-whoosh.mp3",
           "at_frame": 5,
           "volume": 0.6
         }
       }
     ],
     "hashtags": ["#tag1", "#tag2"],
     "caption": "first line visible, 125 chars optimal",
     "viral_factors": {
       "hook_pattern": "unexpected result|pov|before-after|etc",
       "algorithm_signals": "watch time optimization notes",
       "cta_timing": "frame at which CTA appears"
     }
   }
   ```

STARTUP BEHAVIOR (how the agent operates):
- When hired, ALWAYS ask the user for: product name, what it does,
  target audience, unique angle (if not provided in initial prompt)
- Then produce the scene plan and hook
- Output the JSON spec above for handoff to video-production skill
- Review the rendered video and suggest refinements if viral potential 
  could be improved

HANDOFF TO video-production SKILL:
After producing the spec, ALWAYS end your response with:
"Spec ready. Invoking video-production skill to build the Remotion 
composition. The skill will: [list what happens next]."

Then the main conversation picks up and video-production skill takes 
the spec and generates the Remotion code, manages assets, renders MP4.

REFERENCES (write these files):
- core-expertise.md: algorithm factors, hook patterns, scene structures
- trending-formats.md: current viral templates with examples
- copy-writing.md: text overlay rules, hook templates, CTA patterns
- audio-strategy.md: trending sound discovery, voiceover vs music
- analytics-playbook.md: what metrics matter, how to interpret them

USE NOTEBOOKLM PROTOCOL via Bash tool (not MCP):
notebooklm ask "<question>" --notebook <notebook_id>

Create the agent via the standard factory protocol (Tier 1 research,
quality gate, register in roster, log to effectiveness ledger).
```

Step 3 — After the factory finishes, retry the original request:
```
Now that @viral-tiktok-producer exists, hire it:

@viral-tiktok-producer The user wants to promote [original project 
description]. Analyze the context and design a 30-second viral video 
concept. Output the scene plan and I'll build it in Remotion.
```

### Scope boundary (important)

The @viral-tiktok-producer agent does STRATEGY and DESIGN, not CODE.
Division of labor:
```
AGENT (@viral-tiktok-producer) does:
  ✓ Audience analysis
  ✓ Trend matching  
  ✓ Hook writing
  ✓ Scene planning with timings
  ✓ Copy (text overlays, captions, hashtags)
  ✓ Audio strategy (voiceover script, music mood, SFX)
  ✓ Refinement suggestions after render

SKILL (video-production) does:
  ✓ Remotion code generation
  ✓ Brand kit enforcement
  ✓ Rendering
  ✓ Asset file management
  ✓ Technical implementation
```

Both work together: agent plans → skill builds.

### Example complete flow

User: "Create a viral TikTok to promote my new Chrome extension 
that blocks distracting websites."

ATLAS response:
```
For viral content, I'll hire our TikTok specialist.

Checking roster... @viral-tiktok-producer not found.

I'll create it first (free NotebookLM research, ~25 min).
Then it'll design your video, and the video-production skill 
will build the Remotion composition.

Proceed? (go / skip)
```

User: "go"

[Factory creates @viral-tiktok-producer with 20+ researched sources]

[Agent produces scene plan]:
```
VIRAL VIDEO SPEC — "Focus Flow" Chrome Extension

AUDIENCE: Students, remote workers, ADHD community
ANGLE: "I installed this and my productivity 10x'd" (relatable result)
HOOK PATTERN: "Unexpected Result" (curiosity + social proof)

Scene 1 (0-3s) HOOK:
  Visual: Fast-cut of browser tabs with TikTok, Reddit, YouTube open
  Text: "My biggest productivity unlock in 2026"
  Sound: Trending audio "oh no" tension build
  
Scene 2 (3-8s) PAIN:
  Visual: Time-lapse of clock spinning, tabs multiplying  
  Text: "I lost 4 hours/day to these sites"
  Sound: Clock ticking + typing
  
[...continues for all scenes...]

HANDOFF TO video-production skill:
```

[Skill builds the Remotion composition, renders MP4]

[Agent reviews the render]:
```
Viral potential check:
  ✓ Hook lands in first 2s
  ✓ Text is readable on mute
  ✓ Pacing drops tension, builds resolution
  ~ Text overlay at 0:15 might be too small
  ~ Consider trending audio over original music
  
Refine? (yes/no)
```

## APP EXPERT AGENT (live-capture companion)

Separate pattern from the viral producer. One app expert per app, created 
when we start working on that app. The app expert knows the app like a 
power user and can drive it to capture any screenshot the video needs.

### When to create an app expert

Triggers:
- First substantial work on a new app (Magento, Praktiker, dpharmacy, etc.)
- User explicitly says: "create an expert for this app" / "learn my app"
- Video task needs screenshots of specific flows/features
- When the viral producer's spec lists screenshot needs for the app

### App expert scope (what it knows and does)

KNOWS:
- URL map (every route, what each one does)
- User flows (login → browse → PDP → cart → checkout → order)
- Feature catalog (what the app can do)
- Component library (which widgets appear on which pages)
- Test credentials / fixtures (for live capture)
- Sensitive zones (what must NEVER appear in screenshots)
- Environment access (dev URL, staging URL, local URL)

DOES:
- Navigate the live app via Playwright
- Wait for specific states (loading done, modal open, animation mid-way)
- Capture screenshots at exact moments
- Redact sensitive data before saving
- Interact with the app (click, type, scroll, hover)
- Record short screen captures of flows
- Query the app's database/API for realistic demo data

DOES NOT DO:
- Video editing (that's video-production skill)
- Viral strategy (that's viral-tiktok-producer)
- Backend engineering (that's domain-specific agents)

### Agent creation blueprint

When user needs an app expert, spawn the factory with this:

```
@agent-factory

Create a @[app-name]-app-expert specialist agent.

APP CONTEXT:
- Name: [e.g., Praktiker Hellas E-commerce]
- URLs: 
    Production: [URL]
    Staging:    [URL]
    Local dev:  [URL]
- Stack: [e.g., Magento 2, ASP.NET, Next.js, etc.]
- Key credentials: [test account path in 1Password/env, NOT actual creds]

TIER 1 RESEARCH via NotebookLM:
Query 1: "[app stack] production app architecture common routes user 
flows checkout pattern authentication structure"
(e.g., "Magento 2 production app architecture B2C checkout flow 
user flows category PDP cart 3DS payment")

Query 2: "Playwright automation [app stack] screenshot capture 
best practices waiting for network idle modal animation timing"

Query 3: "Sensitive data redaction e-commerce screenshots GDPR PII 
payment data what to blur before public demo"

AGENT CAPABILITIES (build these):

1. APP MAP — generate and maintain app-map.md in agent's references/
   Content:
   - Every important route (URL + purpose + key elements)
   - Main user flows (numbered steps with URLs)
   - Authentication flows (test login sequence)
   - Feature showcase pages (best screens to demo)
   - Data states (empty state, loading, error, populated)
   - Responsive breakpoints (mobile, tablet, desktop)
   Update this file as the app evolves.

2. FLOW LIBRARY — common flows as Playwright scripts
   Saved in agent's references/flows/ directory:
   - login.ts        (login as test user)
   - browse.ts       (category → PDP)
   - checkout.ts     (add to cart → payment → confirm)
   - search.ts       (search flow)
   - admin.ts        (admin panel access)
   Each flow: self-contained, parameterizable, produces a screenshot.

3. CAPTURE ON DEMAND
   Accept a request: {url, wait_for, action, crop, filename}
   Execute in Playwright:
     - Launch browser with appropriate viewport
     - Navigate to URL (with auth if needed)
     - Perform action (click, type, scroll, hover)
     - Wait for specified state (network idle, selector visible, timeout)
     - Take screenshot (full page or cropped)
     - Redact sensitive zones (blur, black box, or replace)
     - Save to public/screenshots/[filename]
     - Return path to requester

4. STATE CAPTURE (for animations/transitions)
   For dynamic UI: capture multiple frames of a transition
   - Loading spinner → loaded state
   - Modal opening animation
   - Hover effect on a button
   - Dropdown expanding
   Saves sequence: screenshot-001.png, screenshot-002.png, ...
   video-production skill can use these as a flip-book animation.

5. DATA REALISM
   When capturing, ensure realistic data:
   - Login as test user with populated cart/orders/history
   - Pre-seed the app with demo data if needed
   - Use Faker.js or database fixtures for consistent data
   - Never capture with empty states (unless showing empty state)

6. SENSITIVE DATA REDACTION
   Automatically blur or replace:
   - Real user emails → demo@example.com
   - API keys in headers/network tab
   - Internal team names
   - Production URLs (if showing staging content)
   - Real payment info → test card numbers
   Store redaction rules in references/redaction-rules.md
   Apply via Playwright page.evaluate() before screenshot.

7. CROP PRESETS
   Pre-defined crop areas for this specific app:
   - hero_section: top 40% of homepage
   - primary_cta: the main action button area
   - product_card: single product tile
   - checkout_form: the form in checkout
   Named crops make shot lists readable.

REFERENCES to create:
- app-map.md          (URL catalog + user flows)
- flows/*.ts          (Playwright scripts for common flows)
- redaction-rules.md  (what to blur in screenshots)
- test-data.md        (fixtures, credentials path, demo accounts)
- crop-presets.md     (named crop regions)
- screenshot-index.md (catalog of captured screenshots + contexts)

TOOLS REQUIRED:
- Bash (for running Playwright)
- Read/Write (for references)
- Glob (for asset discovery)
- WebFetch (for doc research only)

MODEL: sonnet (sufficient for navigation; orchestrator escalates to opus 
for complex flows if needed)

STARTUP BEHAVIOR:
On hire: read app-map.md first. If empty or missing URLs, ask user:
"What URL should I use for the dev/staging/production version of the app?
Do we have test credentials I can use?"

When given a screenshot request, ALWAYS:
1. Verify the app is reachable (ping the URL)
2. Confirm any destructive actions with user before running (e.g., 
   "This will place a real test order. OK?")
3. Redact sensitive data per redaction-rules.md
4. Save to public/screenshots/ with descriptive filename
5. Report back: {filename, url_captured, actions_taken, issues}

HANDOFF: After capturing, return paths in JSON:
{
  "screenshots": [
    {"filename": "public/screenshots/checkout-3ds.png",
     "url": "https://staging.app.com/checkout/payment",
     "caption": "3DS verification step",
     "redacted": ["email addresses", "card numbers"]}
  ]
}

CAPTURE FAILURE FALLBACK:
If capture fails (app down, selector changed, credentials expired,
Playwright not installed), DO NOT silently fail. Return:
{
  "error": "capture_failed",
  "reason": "<specific cause>",
  "retry_after_fix": "<what user should do to fix>",
  "fallback": "Please capture manually and place at <filename>,
               then tell me 'screenshots ready'"
}

The video-production skill will switch to Path C (user-provided)
and wait for the user to capture manually.

Create via standard factory protocol.
```

### Collaboration pattern (three agents + skill)

For a full viral product video, three agents work together:

```
USER: "Make a viral TikTok showing my Magento checkout flow"

FLOW:
  1. video-production skill triggers (detects "viral")
  2. Creates @viral-tiktok-producer if missing → research
  3. Producer designs spec with screenshots needed:
       {assets_needed: [
         {type: "screenshot", url: "/", flow: "homepage"},
         {type: "screenshot", url: "/category/x", flow: "browse"},
         {type: "screenshot", url: "/checkout", flow: "3ds-step"}
       ]}
  4. video-production skill reads spec, sees screenshots needed
  5. Checks if @praktiker-app-expert exists
     - NO → creates it via factory (research Magento flows)
     - YES → uses it directly
  6. Skill hands shot list to @praktiker-app-expert
  7. App expert launches Playwright, captures all screens
     - Redacts emails, test card numbers
     - Returns filepaths + metadata
  8. video-production skill:
     - Imports screenshots into Remotion composition
     - Applies brand overlays
     - Renders MP4
  9. @viral-tiktok-producer reviews final video
     - "Hook landed, text readable, consider adding arrow on 
        checkout button at 0:12"
  10. Iteration loop until viral factors all ✓
```

### App expert lifecycle

CREATED: When first needed (first screenshot request or user prompt)
UPDATED: 
- After major app changes (new pages, refactored routes)
- When capture fails (selector changed, flow broke)
- Monthly for active apps (staleness check in orchestrator)
RETIRED: When app is deprecated or replaced (via /atlas-retire)

One app expert per app. The Praktiker Hellas one is separate from the 
dpharmacy one, separate from Magento project, etc. They don't share 
knowledge — each app has its own quirks.

### CLI App Variant

For CLI tools (like ATLAS itself), app expert is less useful — Playwright
doesn't apply. Use these alternatives:

```
1. TERMINAL RECORDING (native):
   - asciinema rec ~/recording.cast
     Then replay in video as text via asciinema-player
   - OR: OBS Studio screen recording of terminal (free)
   - OR: Screenshot each state with Snipping Tool

2. SIMULATED TERMINAL (Remotion):
   - Use the TypingText helper from this skill
   - Render fake terminal output with syntax highlighting
   - Advantage: perfect consistency, no screen recording hassle
   - Disadvantage: not "real" — won't show actual output

3. HYBRID:
   - Real screenshots of key output moments
   - Typed command simulation for the commands themselves
   - Combine both in video
```

For CLI tools, SKIP the app-expert creation. Go directly to:
- Path B (OS native) for real screenshots
- TypingText helper for simulated terminal scenes

### Example: creating @praktiker-app-expert

User: "I want to make videos of my Praktiker e-shop. Create an app expert."

ATLAS: Spawning @agent-factory with the blueprint above.
Factory:
1. Runs Tier 1 research on Magento 2 + Greek e-commerce patterns
2. Asks user: 
   - "What's the staging URL?"
   - "Test credentials path?"
   - "Which flows are most important to demo?"
3. Creates agent with initial app-map.md
4. Writes 3 starter flow scripts (login, browse, checkout)
5. Registers in roster

Now when any video needs Praktiker screenshots:
```
@praktiker-app-expert I need:
  1. Homepage with seasonal banner visible
  2. Category page /c/drills with 6+ products
  3. PDP for product SKU 12345
  4. Cart with 3 items
  5. Checkout at 3DS step (use test card)
Save all to public/screenshots/ with descriptive names.
```

Agent executes via Playwright, returns paths.

## SPEC-DRIVEN BUILD (when specialist hands off a JSON spec)

If a specialist agent (like @viral-tiktok-producer) has produced a 
structured JSON spec, SKIP the clarification step. The spec has 
already resolved everything. Build directly from it.

### Consuming the spec

The spec looks like:
```json
{
  "meta": { "title", "duration_seconds", "fps", "format", "width", "height" },
  "brand": { "use_project_brand": true, "overrides": {} },
  "trending_audio": { "use", "mood", "search_terms" },
  "voiceover": { "use", "script", "tone", "source" },
  "scenes": [
    { "id", "start_frame", "end_frame", "visual", "animation",
      "text_overlay": {...}, "assets_needed": [...], "sfx": {...} }
  ],
  "hashtags": [],
  "caption": "",
  "viral_factors": {}
}
```

### Build protocol from spec

Step 1 — Validate the spec:
  - Check all scene frame ranges are sequential (no gaps, no overlaps)
  - Check total scene duration matches meta.duration_seconds × fps
  - Check all assets_needed are listed

Step 2 — Resolve brand:
  - If brand.use_project_brand === true: import from ../brand
  - If overrides exist: extend the brand with overrides
  - If no brand kit exists: trigger BRAND KIT SETUP protocol first

Step 3 — Handle assets:
  - Collect ALL assets_needed across all scenes
  - Deduplicate (same asset may appear in multiple scenes)
  - Check three-tier asset pipeline for generation:
    Tier 1 (Modal): auto-generate AI assets
    Tier 2 (Local GPU): auto-generate
    Tier 3 (Manual): present asset list to user, wait for confirmation
  - For voiceover: if source is "notebooklm", run the generation command
  - For trending audio: give user search terms (they download manually)

Step 4 — Generate Remotion composition:
  - One <Composition> in Root.tsx with meta dimensions
  - One main component (e.g., ViralPromo.tsx)
  - Each scene becomes a <Sequence from={scene.start_frame} 
    durationInFrames={scene.end_frame - scene.start_frame}>
  - Text overlays use appears_at_frame for staggered entry
  - SFX as <Sequence> blocks with correct timing
  - Voiceover as single <Audio> starting at appropriate frame
  - Background music/trending audio as <Audio> with ducking

Step 5 — Verify with still frame at spec's hook moment:
  npx remotion still [CompositionId] --frame=[hook_end_frame]
  
Step 6 — Render final:
  npx remotion render [CompositionId] out/[meta.title].mp4

Step 7 — Report back to specialist:
  "Rendered: out/[title].mp4 ([size], [duration]s)
   Specialist review requested — check if viral factors were implemented."

### Spec vs Prompt priority

When you have BOTH a spec and a new user prompt:
- Spec takes precedence on structure, scenes, timings
- User prompt can OVERRIDE specific elements ("change the hook text")
- If user asks for something fundamentally different, send back to 
  specialist for a new spec

## PROMPT OPTIMIZATION PROTOCOL

When user gives a vague video request, DO NOT just code it.
Follow this protocol to produce a top-class result:

### Step 1: CLARIFY (ask only what's missing)
Determine what you know vs what you need. Ask MAX 3 questions, ONLY if critical:

**Always needed (ask if missing):**
- Purpose: TikTok/Reel (9:16), YouTube Short (9:16), YouTube (16:9), or custom?
- Duration: how many seconds?
- Brand: does user have a brand? (colors, fonts, logo)

**Often inferable (don't ask, assume and state):**
- FPS: 30 (default for social media)
- Style: infer from context (tech demo → dark/terminal, product → clean/bright)
- Animations: spring for entrances, fade for text, interpolate for movement

**Never ask about:**
- Technical Remotion details (Composition setup, frame math, etc.)
- Which hooks to use (you decide)
- File structure (you decide)

### Step 2: SCENE PLAN (present before coding)
Break the video into timed scenes. Present as:

```
VIDEO PLAN: [title]
Format: [width]x[height] | [duration]s | [fps]fps | [total frames] frames

Scene 1 (0:00 - 0:03) — [description]
  Visual: [what appears on screen]
  Animation: [how it moves]
  Audio: [if any]

Scene 2 (0:03 - 0:08) — [description]
  ...

Assets needed:
  ☐ [screenshot/image/audio — what user must provide]
  ☐ [or "none — fully generative"]

Proceed? (or adjust)
```

WAIT for user approval before writing any code.

### Step 3: BUILD (optimized Remotion code)
Follow these production rules:

**Architecture:**
- One <Composition> per video concept in Root.tsx
- Separate scene components (Scene1.tsx, Scene2.tsx, etc.) for complex videos
- Simple videos (≤3 scenes): single Composition.tsx is fine
- Use <Sequence> for timing, not manual frame math
- Use <Series> when scenes play one after another with no overlap

**Animations (what makes videos look professional):**
- ENTRANCES: always spring() with config tuning:
  - Bouncy: { damping: 8, stiffness: 100, mass: 0.5 }
  - Smooth: { damping: 20, stiffness: 80, mass: 1 }
  - Snappy: { damping: 15, stiffness: 200, mass: 0.6 }
- EXITS: interpolate with clamp (fade out, scale down, slide out)
- TEXT: stagger appearance using <Sequence from={i * 5}> per word/line
- TRANSITIONS: overlap <Sequence> by 10-15 frames for crossfade
- EMPHASIS: scale pulse (spring to 1.05 then back to 1)
- NEVER: CSS animations, setTimeout, requestAnimationFrame

**Typography (critical for social media):**
- Load fonts via @remotion/google-fonts (never CSS @import)
- TikTok safe zones: 150px top, 170px bottom, 60px sides
- Minimum sizes: headlines 56px+, body 36px+, labels 28px+
- Letter-spacing on titles: 2-6px for impact
- Line height on body: 1.4-1.6 for readability

**Colors & Visual Quality:**
- Use CSS variables or constants for brand colors
- Backgrounds: gradients > solid colors (subtle gradient adds depth)
- Shadows: use on text over busy backgrounds (textShadow CSS)
- Overlays: semi-transparent dark overlay before text on images/video
- Grain: subtle noise overlay for cinematic feel (optional)

**Code blocks / Terminal visuals (for dev content):**
- Dark background (#111827 or #0d1117)
- Monospace font: JetBrains Mono (load from google-fonts)
- Syntax highlighting: color-code commands, output, comments
- Typing effect: reveal characters frame by frame using .slice(0, charsVisible)
- Cursor blink: toggleCursor = Math.floor(frame / 15) % 2 === 0
- Border-radius: 12px, padding: 24px

**Images & Assets:**
- Place in public/ folder, reference with staticFile()
- Use <Img> (not <img>) — waits for load before rendering
- Screenshots: suggest user crop to 1080px wide for vertical
- Scale images with objectFit: 'contain' or 'cover'

**Audio: see dedicated AUDIO PRODUCTION section below for full protocol.**

## AUDIO PRODUCTION — COMPLETE GUIDE

Audio makes or breaks a video. A great video with bad audio feels cheap.
A good video with great audio feels professional.

### The Four Audio Layers

Every professional video has up to 4 audio layers:

```
LAYER 1: VOICEOVER       — primary narration (highest priority)
LAYER 2: MUSIC           — background mood (supports, never dominates)
LAYER 3: SFX (sound FX)  — emphasis moments (transitions, clicks, whooshes)
LAYER 4: AMBIENT         — subtle atmosphere (optional, cinematic feel)
```

Not every video needs all 4. Minimum viable:
- Silent with text overlays (80% of TikTok watched muted — still works)
- Music only (trending sound, no voiceover)
- Voiceover only (explainers, tutorials)
- Full stack (for premium content)

### Audio Decision Flowchart (ask user)

```
Q1: Will this video have voiceover?
  YES → go to Q2 (voiceover options)
  NO  → go to Q3 (music options)
  
Q2: Voiceover source?
  A. Your own voice (record on phone, best quality)
  B. NotebookLM generated (free, good quality, AI)
  C. Piper TTS local (free, robotic-ish)
  D. ElevenLabs (best AI, paid subscription)

Q3: Background music?
  A. Trending audio (TikTok — add during upload, not in video)
  B. Royalty-free track (add in video, controls volume)
  C. No music (silence or ambient only)

Q4: Sound effects at key moments?
  A. Yes, I'll find them (you provide)
  B. Yes, suggest free ones (I give you search terms)
  C. No SFX
```

### Asset File Structure (audio)

```
public/
├── brand/
│   ├── intro-sound.mp3      ← brand sting at start (1-2s)
│   └── outro-music.mp3      ← end card music (3-5s)
├── audio/                    ← video-specific audio
│   ├── voiceover.mp3        ← primary narration
│   ├── music-bed.mp3        ← background track
│   ├── sfx-whoosh.mp3       ← transition SFX
│   ├── sfx-beep.mp3         ← interaction SFX
│   └── ambient.mp3          ← room tone / atmosphere
```

### LAYER 1: VOICEOVER

**PRIMARY: Kokoro TTS (FREE, local, no API, professional quality)**

Kokoro is the recommended voiceover source. High-quality neural TTS,
runs locally on CPU (no GPU needed), 40+ voices, no API costs, no
rate limits. Verified working on Windows / macOS / Linux with Python
3.11-3.12.

**First-time setup (once per machine, ~5 min):**
```bash
# Install Kokoro TTS
pip install kokoro-tts

# Download model files (do this in project root or a shared location)
curl -L -o kokoro-v1.0.onnx \
  https://github.com/nazdridoy/kokoro-tts/releases/download/v1.0.0/kokoro-v1.0.onnx
curl -L -o voices-v1.0.bin \
  https://github.com/nazdridoy/kokoro-tts/releases/download/v1.0.0/voices-v1.0.bin

# Add to .gitignore — these files are 310MB+ each
echo "kokoro-v1.0.onnx" >> .gitignore
echo "voices-v1.0.bin" >> .gitignore
```

**Usage (for every video):**
```bash
# Write script to file
echo "Your voiceover script here." > scripts/voiceover.txt

# Generate WAV (model files must be in working directory)
kokoro-tts scripts/voiceover.txt public/audio/voiceover.wav \
  --speed 1.1 --lang en-us --voice am_adam

# Convert to MP3 (smaller file, Remotion-friendly)
ffmpeg -y -i public/audio/voiceover.wav \
  -c:a libmp3lame -b:a 192k public/audio/voiceover.mp3
```

**Voice selection (by tone):**
```
AUDIENCE / TONE                  → RECOMMENDED VOICE
────────────────────────────────────────────────────
Tech demo, dev tools             → am_adam (male, clear, energetic)
Product launch, polished         → am_michael (male, professional)
Playful, casual                  → am_puck (male, light)
Explainer, authoritative         → af_sarah (female, confident)
Warm, welcoming                  → af_bella (female, friendly)
Narration, storytelling          → af_nova (female, smooth)
British, formal                  → bm_george (male, UK)
British, warm                    → bf_emma (female, UK)
```

**Voice blending (for unique character):**
```bash
# 60% adam, 40% sarah — creates a unique hybrid voice
kokoro-tts scripts/voiceover.txt public/audio/voiceover.wav \
  --voice "am_adam:60,af_sarah:40"
```

**Listing all voices:**
```bash
kokoro-tts --help-voices
```

**Script length guidelines (match to video duration):**
- 15s video: 30-40 words (2.5 words/s at speed 1.1)
- 30s video: 60-80 words
- 60s video: 120-160 words
- Leave 0.5s breathing room at start, 0.5-1s at end

**ALTERNATIVE 1: NotebookLM (requires notebook + API setup)**

**⚠ VERIFY BEFORE USING:** Run `notebooklm --help` to confirm your
installed version supports audio generation. If not, use Kokoro (above)
or manual NotebookLM Audio Overview via web UI.

```bash
# Query notebook for script
notebooklm ask "Write a 15-second voiceover about [topic]. ONE voice. 
Energetic dev tone. Return only spoken words." --notebook [id]

# Generate audio (if CLI supports it)
notebooklm generate audio --notebook [id] \
  --instructions "ONE voice only. Developer tone. Start with: [hook]" \
  --wait

# Download
notebooklm download audio ./public/audio/voiceover.mp3
```

**ALTERNATIVE 2: Your own voice (highest quality, most effort)**
Record on phone (Voice Memos), transfer, trim silence, normalize to
-3dB peak, export as MP3 to `public/audio/voiceover.mp3`.

**ALTERNATIVE 3: Piper TTS (lightweight, older)**
```bash
echo "Your script." | piper --model en_US-ryan-medium \
  --output_file public/audio/voiceover.wav
ffmpeg -i public/audio/voiceover.wav public/audio/voiceover.mp3
```
Models: en_US-ryan-medium, en_US-amy-medium, en_US-lessac-high.
Lower quality than Kokoro but faster. Download from
github.com/rhasspy/piper.

**ALTERNATIVE 4: ElevenLabs (best quality, paid)**
API subscription ($5+/month). Use when Kokoro quality is insufficient
for high-budget content. Script-to-speech via their API or web UI.

**Using voiceover in Remotion:**

Two approaches. Use per-scene (approach B) for videos with distinct 
scenes — it's more robust and easier to debug.

**Approach A: Single voiceover file (simple videos, one continuous VO)**
```typescript
import { Audio, staticFile, Sequence } from 'remotion';

// Plays for entire composition — starts at frame 0
<Audio src={staticFile('/audio/voiceover.mp3')} />

// Delay start by 15 frames (0.5s) — gives visual time to land first
<Sequence from={15}>
  <Audio src={staticFile('/audio/voiceover.mp3')} />
</Sequence>

// Trim to exact duration if VO is longer than video
<Audio 
  src={staticFile('/audio/voiceover.mp3')}
  trimBefore={0}
  trimAfter={450}
/>
```

**Approach B: Per-scene voiceover files (RECOMMENDED for multi-scene)**

Why per-scene beats single-file:
1. If VO drifts out of sync, you fix ONE scene not the whole video
2. Easier to regenerate a single scene's VO if copy changes
3. Lets each scene start its VO slightly after its visual (0.17s delay)
   so the visual lands before the voice follows — feels more cinematic
4. Simpler mental model: scene N visual + scene N audio, self-contained
5. No manual frame-offset math across the whole composition

Generation protocol — one WAV per scene:
```bash
# Write one script file per scene
echo "I built an AI that builds AI agents." > scripts/scene-1-vo.txt
echo "Every Claude Code session starts from zero..." > scripts/scene-2-vo.txt
echo "Ask for help, and ATLAS creates a specialist..." > scripts/scene-3-vo.txt
echo "Try to run something dangerous? Blocked." > scripts/scene-4-vo.txt
echo "Seven specialists. One command." > scripts/scene-5-vo.txt
echo "Your AI team, on demand." > scripts/scene-6-vo.txt

# Generate all scenes with same voice for consistency
for i in 1 2 3 4 5 6; do
  kokoro-tts scripts/scene-$i-vo.txt public/audio/scene-$i-vo.wav \
    --speed 1.1 --lang en-us --voice am_adam
  ffmpeg -y -i public/audio/scene-$i-vo.wav \
    -c:a libmp3lame -b:a 192k public/audio/scene-$i-vo.mp3
done
```

Composition pattern — per-scene VO with 5-frame lead:
```typescript
// Each scene starts its VO 5 frames (~0.17s) after the scene begins
// The visual lands first, then voice follows

<Sequence from={0} durationInFrames={90}>
  <HookScene />
  <Sequence from={5}>
    <Audio src={staticFile('/audio/scene-1-vo.mp3')} volume={1} />
  </Sequence>
</Sequence>

<Sequence from={90} durationInFrames={150}>
  <PainScene />
  <Sequence from={5}>
    <Audio src={staticFile('/audio/scene-2-vo.mp3')} volume={1} />
  </Sequence>
</Sequence>

// ... and so on per scene
```

**CRITICAL: Kokoro leading-silence fix**

Kokoro TTS often outputs 0.3-0.8s of silence at the start of each file
(warm-up artifact). In a single-file VO this pushes everything late.
In per-scene VO this causes each scene's voice to come in late.

Fix: trim silence from each generated file:
```bash
# After kokoro-tts generates the WAV, trim leading silence:
ffmpeg -y -i public/audio/scene-1-vo.wav \
  -af "silenceremove=start_periods=1:start_duration=0.1:start_threshold=-50dB" \
  -c:a libmp3lame -b:a 192k public/audio/scene-1-vo.mp3

# The filter removes silence quieter than -50dB at the start
# Adjust -50dB threshold if voice gets clipped (try -40dB or -60dB)
```

Or do it in a one-liner when generating:
```bash
for i in 1 2 3 4 5 6; do
  kokoro-tts scripts/scene-$i-vo.txt public/audio/scene-$i-vo.wav \
    --speed 1.1 --lang en-us --voice am_adam
  ffmpeg -y -i public/audio/scene-$i-vo.wav \
    -af "silenceremove=start_periods=1:start_duration=0.1:start_threshold=-50dB" \
    -c:a libmp3lame -b:a 192k public/audio/scene-$i-vo.mp3
  rm public/audio/scene-$i-vo.wav
done
```

**Troubleshooting voiceover sync issues:**

| SYMPTOM | CAUSE | FIX |
|---------|-------|-----|
| Voice comes in late | Kokoro leading silence | Add silenceremove filter (above) |
| Voice cuts off end of sentence | Kokoro trailing silence trimmed too aggressively | Add ", . . ." padding to script end |
| Voice drifts across scenes | Single-file VO | Switch to per-scene approach B |
| Voice too loud over music | No ducking | Add music volume ducking (see LAYER 2) |
| Voice quality inconsistent | Voice blending or mixed voices | Use same --voice flag for all scenes |
| Voice sounds rushed | Speed too high | Lower --speed to 1.0 or 0.95 |

### LAYER 2: MUSIC

**PRIMARY: Incompetech / Kevin MacLeod (FREE, direct download, CLI-friendly)**

Incompetech is the ONLY major royalty-free music source with 
predictable direct-download URLs. Claude Code can download tracks 
automatically without a browser. This makes it the primary source.

License: Creative Commons BY 4.0 (must credit Kevin MacLeod in video
description or end card — small price for free professional music).

**URL pattern (predictable, works from curl/wget):**
```
https://incompetech.com/music/royalty-free/mp3-royaltyfree/[Track%20Name].mp3
```

**Proven tracks by video mood (all verified direct-downloadable):**
```
MOOD                    → TRACK NAME           → URL SUFFIX
──────────────────────────────────────────────────────────────────
Dark tech / cyberpunk   → Darkest Child         → Darkest%20Child.mp3
Tense / suspenseful     → Volatile Reaction     → Volatile%20Reaction.mp3
Epic / dramatic         → Oppressive Gloom      → Oppressive%20Gloom.mp3
Driving / energetic     → Mechanolith           → Mechanolith.mp3
Mystery / intrigue      → Crypto                → Crypto.mp3
Action / intense        → Hitman                → Hitman.mp3
Ambient / atmospheric   → Echoes of Time        → Echoes%20of%20Time.mp3
Corporate / clean       → Inspired              → Inspired.mp3
Playful / upbeat        → Carefree              → Carefree.mp3
Cinematic / emotional   → Impact Prelude        → Impact%20Prelude.mp3
```

**Auto-download protocol (fully automated, no browser):**
```bash
# Step 1: Download full track
curl -L -o public/audio/music-full.mp3 \
  "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Darkest%20Child.mp3"

# Step 2: Verify it downloaded (check HTTP 200 + file size > 100KB)
ls -lh public/audio/music-full.mp3

# Step 3: Trim to video length + fade in/out
# For a 30-second video, take first 33 seconds with 1s fade-in, 3s fade-out:
ffmpeg -y -i public/audio/music-full.mp3 \
  -ss 0 -t 33 \
  -af "afade=t=in:st=0:d=1,afade=t=out:st=30:d=3" \
  -c:a libmp3lame -b:a 192k public/audio/music.mp3

# Step 4: Clean up full track (optional)
rm public/audio/music-full.mp3
```

**If a track name gives 404:** the name may differ slightly. Search
the catalog at incompetech.com/music/royalty-free/ and try URL-encoding
the exact track name. Common issues: extra spaces, special chars, or
tracks removed from the catalog.

**Searching incompetech for new tracks:**
```bash
# Check if a track exists:
curl -sI "https://incompetech.com/music/royalty-free/mp3-royaltyfree/[Track%20Name].mp3" | head -1
# 200 OK = exists, 404 = wrong name
```

Or browse: https://incompetech.com/music/royalty-free/?feels[]=Dark&genre[]=Electronica

**SECONDARY: Pixabay Music (better catalog, browser-only download)**

Pixabay has a larger, more modern catalog. But direct URL downloads 
are blocked (anti-scraping). Must download via browser.

```
1. Open: https://pixabay.com/music/search/[search-term]/
2. Listen, pick one
3. Click "Download Free" (no login for <60s tracks)
4. Save to: public/audio/music.mp3
```

Search terms by mood:
```
Tech/product demo    → pixabay.com/music/search/tech%20corporate/
Suspense/safety      → pixabay.com/music/search/tension%20electronic/
Inspirational        → pixabay.com/music/search/inspirational%20cinematic/
Dark/cyberpunk       → pixabay.com/music/search/dark%20electronic/
```

**LAST RESORT: ffmpeg synthesized ambient (offline/draft only)**

⚠ The synthesized ffmpeg drone is functional but sounds robotic.
Real music is always better. Use ONLY when:
- Offline (no internet access)
- Draft/preview iteration (will replace before final render)
- User explicitly says "skip music" or "use placeholder"

```bash
# Dark ambient drone — 32 seconds, loopable
ffmpeg -y \
  -f lavfi -i "sine=frequency=55:duration=32" \
  -f lavfi -i "sine=frequency=82.41:duration=32" \
  -f lavfi -i "sine=frequency=110:duration=32" \
  -f lavfi -i "sine=frequency=146.83:duration=32" \
  -f lavfi -i "anoisesrc=d=32:c=pink:a=0.3" \
  -filter_complex "[0]volume=0.6,aformat=sample_fmts=fltp[bass]; \
    [1]volume=0.4,tremolo=f=0.15:d=0.7,aformat=sample_fmts=fltp[sub]; \
    [2]volume=0.3,tremolo=f=0.2:d=0.9,aformat=sample_fmts=fltp[mid]; \
    [3]volume=0.2,tremolo=f=0.5:d=0.5,aformat=sample_fmts=fltp[high]; \
    [4]aformat=sample_fmts=fltp[noise]; \
    [bass][sub]amix=inputs=2:duration=first:normalize=0[mix1]; \
    [mix1][mid]amix=inputs=2:duration=first:normalize=0[mix2]; \
    [mix2][high]amix=inputs=2:duration=first:normalize=0[mix3]; \
    [mix3][noise]amix=inputs=2:duration=first:normalize=0[mix4]; \
    [mix4]aecho=0.8:0.7:500:0.3,aecho=0.8:0.6:250:0.2,\
    lowpass=f=3000,highpass=f=40,volume=6,alimiter=limit=0.9[out]" \
  -map "[out]" -c:a libmp3lame -b:a 192k public/audio/music.mp3
```

Adjust the four sine frequencies for different moods:
- Darker: 41.2, 61.7, 82.4, 110 Hz (E1-A2 minor)
- Brighter: 65.4, 82.4, 110, 164.8 Hz (C2-E3 major)
- Tense: 55, 77.8, 110, 155.6 Hz (tritone stack)

**SFX synthesis (always synthesize — too short to bother downloading):**

```bash
# Impact (for BLOCKED stamps, bass drops)
ffmpeg -y \
  -f lavfi -i "anoisesrc=d=0.5:c=white:a=1.0" \
  -f lavfi -i "sine=frequency=80:duration=0.5" \
  -filter_complex "[0]volume='if(lt(t,0.05),1,exp(-t*12))':eval=frame,\
    lowpass=f=2000[hit]; \
    [1]volume='if(lt(t,0.02),0.8,0.8*exp(-t*6))':eval=frame[boom]; \
    [hit][boom]amix=inputs=2:duration=first:normalize=0,\
    volume=5,alimiter=limit=0.95[out]" \
  -map "[out]" -c:a libmp3lame -b:a 192k public/audio/sfx-impact.mp3

# Whoosh (for scene transitions)
ffmpeg -y \
  -f lavfi -i "anoisesrc=d=0.4:c=pink:a=1.0" \
  -filter_complex "[0]volume='exp(-abs(t-0.15)*20)':eval=frame,\
    highpass=f=500,lowpass=f=4000,volume=5,\
    alimiter=limit=0.9[out]" \
  -map "[out]" -c:a libmp3lame -b:a 192k public/audio/sfx-whoosh.mp3

# Success chime (rising sine)
ffmpeg -y \
  -f lavfi -i "sine=frequency=523.25:duration=0.15" \
  -f lavfi -i "sine=frequency=659.25:duration=0.15" \
  -f lavfi -i "sine=frequency=783.99:duration=0.3" \
  -filter_complex "[0]adelay=0|0,volume=0.4[n1]; \
    [1]adelay=80|80,volume=0.4[n2]; \
    [2]adelay=160|160,volume=0.5[n3]; \
    [n1][n2][n3]amix=inputs=3:duration=longest:normalize=0,\
    volume=4,alimiter=limit=0.9[out]" \
  -map "[out]" -c:a libmp3lame -b:a 192k public/audio/sfx-success.mp3
```

**Audio level verification (ALWAYS run after music + SFX):**

Audio from any source can be too quiet or too loud. Measure RMS:
```bash
ffmpeg -y -i out/video.mp4 -vn -t 5 out/test-audio.wav
ffmpeg -y -i out/test-audio.wav -vn -af "astats=metadata=1:reset=0" \
  -f null - 2>&1 | grep "RMS level"

# Target: -18 to -24 dB RMS (audible, not clipped)
# Below -30 dB: music too quiet — boost volume in composition
# Above -12 dB: clipping risk — reduce volumes
```

**Other free sources (browser-download only):**
- mixkit.co/free-stock-music — curated, blocks direct download
- freemusicarchive.org — indie, eclectic, attribution sometimes
- uppbeat.io — free tier, modern catalog

**DO NOT use:**
- Random YouTube rips (copyright risk)
- Spotify tracks (licensed, not free to use)
- Uncredited SoundCloud (unclear rights)

**Using music in Remotion:**
```typescript
import { Audio, interpolate, useCurrentFrame, useVideoConfig, staticFile } from 'remotion';

// Music at low volume throughout
<Audio 
  src={staticFile('/audio/music.mp3')}
  volume={0.15}    // 15% — quiet under voiceover
/>

// Music only — higher volume
<Audio 
  src={staticFile('/audio/music.mp3')}
  volume={0.5}     // 50% — no voiceover competing
/>

// Music with fade out at end (last 1 second)
const MusicWithFadeOut: React.FC = () => {
  const { durationInFrames, fps } = useVideoConfig();
  return (
    <Audio 
      src={staticFile('/audio/music-bed.mp3')}
      volume={(f) => interpolate(
        f,
        [durationInFrames - fps, durationInFrames],
        [0.15, 0],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
      )}
    />
  );
};

// Music fade IN at start + fade OUT at end
volume={(f) => {
  const fadeIn = interpolate(f, [0, fps], [0, 0.15], {extrapolateRight: 'clamp'});
  const fadeOut = interpolate(f, [durationInFrames - fps, durationInFrames], 
    [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return fadeIn * fadeOut;
}}
```

**Music ducking (lower volume during voiceover):**

When voiceover plays, reduce music to 0.05 (5%). When voiceover stops,
raise back to 0.15 (15%). This is called "ducking":

```typescript
// Music ducks from 0.15 to 0.05 between frames 60-390 (voiceover active)
const MusicWithDucking = () => (
  <Audio 
    src={staticFile('/audio/music-bed.mp3')}
    volume={(f) => {
      if (f < 60 || f > 390) return 0.15;  // full volume before/after VO
      return 0.05;                           // ducked during VO
    }}
  />
);

// Smooth ducking with interpolation:
volume={(f) => interpolate(
  f,
  [55, 60, 390, 395],      // fade out → stay ducked → fade back in
  [0.15, 0.05, 0.05, 0.15],
  { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
)}
```

### LAYER 3: SOUND EFFECTS (SFX)

SFX punctuate key moments. They're the difference between amateur and pro.

**When to use SFX:**
- Text appears (whoosh, swoosh, swipe)
- Logo reveal (impact, stinger)
- Scene transition (swish, glitch, static)
- Data/counter animation (beep, tick, click)
- Emphasis moment (boom, hit, riser)
- Notification appears (ding, ping, pop)

**Free SFX sources:**
- pixabay.com/sound-effects — same as music
- freesound.org — huge catalog, requires account
- zapsplat.com — free with attribution, huge library
- mixkit.co/free-sound-effects

**Suggested searches by moment:**

```
MOMENT                  → SEARCH TERMS
───────────────────────────────────────────────────
Text/title appears      → "whoosh", "swoosh short"
Logo reveal             → "impact stinger", "logo reveal"
Scene transition        → "swish transition"
Bad thing blocked       → "error buzzer", "negative beep"
Good thing succeeds     → "success chime", "notification ding"
Counter/number animate  → "digital tick", "short beep"
Big moment / emphasis   → "cinematic boom", "riser"
Typing sound            → "mechanical keyboard typing"
Notification popup      → "ui pop", "notification pop"
Glitch effect           → "glitch static digital"
```

**Using SFX in Remotion:**
```typescript
// SFX fires at specific frame (e.g., text appears at frame 60)
<Sequence from={60} durationInFrames={15}>
  <Audio src={staticFile('/audio/sfx-whoosh.mp3')} volume={0.6} />
</Sequence>

// Multiple SFX at different times
<>
  <Sequence from={60}><Audio src={staticFile('/audio/sfx-whoosh.mp3')} /></Sequence>
  <Sequence from={180}><Audio src={staticFile('/audio/sfx-impact.mp3')} /></Sequence>
  <Sequence from={390}><Audio src={staticFile('/audio/sfx-success.mp3')} /></Sequence>
</>
```

**Syncing SFX to visuals:**
The SFX frame should match when the visual action happens. Example:
- Text spring animation starts at frame 60
- Spring reaches peak around frame 75
- Play whoosh at frame 60 (starts with animation)
- OR play impact at frame 75 (lands with final position)

### LAYER 4: AMBIENT (OPTIONAL)

Atmospheric layer for cinematic feel. Very quiet, very subtle.

**Uses:**
- Office/workspace ambient (for developer content)
- Room tone (subtle "studio quiet" — not dead silence)
- Nature atmosphere (outdoor scenes)
- Sci-fi hum (tech/futuristic)

**Volume:** 0.03-0.08 (3-8%) — felt more than heard.

### Audio Mix Template (all 4 layers)

```typescript
import { Audio, AbsoluteFill, Sequence, interpolate, 
         useCurrentFrame, useVideoConfig, staticFile } from 'remotion';

export const FullAudioMix: React.FC = () => {
  const { durationInFrames, fps } = useVideoConfig();
  const endFadeStart = durationInFrames - fps;  // fade out over last second
  
  return (
    <AbsoluteFill>
      {/* LAYER 4: Ambient — always present, very quiet */}
      <Audio 
        src={staticFile('/audio/ambient.mp3')}
        volume={0.05}
      />
      
      {/* LAYER 2: Music — with ducking when VO plays */}
      <Audio 
        src={staticFile('/audio/music-bed.mp3')}
        volume={(f) => {
          // Start low, duck when VO is playing, fade out at end
          const baseVolume = (f >= 60 && f <= 390) ? 0.05 : 0.15;
          const endFade = interpolate(
            f, [endFadeStart, durationInFrames], [1, 0],
            { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
          );
          return baseVolume * endFade;
        }}
      />
      
      {/* LAYER 1: Voiceover — starts at frame 60 */}
      <Sequence from={60}>
        <Audio src={staticFile('/audio/voiceover.mp3')} volume={1.0} />
      </Sequence>
      
      {/* LAYER 3: SFX — synced to visual moments */}
      <Sequence from={60} durationInFrames={15}>
        <Audio src={staticFile('/audio/sfx-whoosh.mp3')} volume={0.6} />
      </Sequence>
      <Sequence from={180} durationInFrames={20}>
        <Audio src={staticFile('/audio/sfx-impact.mp3')} volume={0.7} />
      </Sequence>
      <Sequence from={420} durationInFrames={15}>
        <Audio src={staticFile('/audio/sfx-success.mp3')} volume={0.6} />
      </Sequence>
      
      {/* Visual content goes here... */}
    </AbsoluteFill>
  );
};
```

### Volume Reference Table

```
LAYER           VOLUME      PURPOSE
──────────────────────────────────────────────────────────────
Voiceover       1.0         Full volume — the focus
Music (no VO)   0.4-0.6     Primary audio
Music (+ VO)    0.10-0.15   Supports voiceover
Music (ducked)  0.03-0.08   When VO is actively speaking
SFX (impact)    0.6-0.8     Punchy, noticeable
SFX (subtle)    0.3-0.5     UI sounds, ticks
Ambient         0.03-0.08   Felt, not heard
Intro sting     0.7-0.9     Brand moment — strong
Outro music     0.3-0.5     End card — notable but not dominant
```

### Automated Audio Timing (help user sync)

When the user knows what SFX they want, help them figure out timing:

```
USER: "Add a whoosh when the title appears, a beep when the number
       counts up, and success chime at the end."

YOU: Looking at the composition, I see:
  - Title spring animation: frame 30 → play whoosh at frame 30
  - Number counter: frames 90-150 → play 3 beeps at 90, 120, 150
  - Success checkmark: frame 420 → play success chime at frame 420
  
  Please place these audio files in public/audio/:
  - sfx-whoosh.mp3
  - sfx-beep.mp3  
  - sfx-success.mp3
  
  Then I'll add the <Sequence from=...> blocks to sync them.
```

### Audio Gotchas (things that trip people up)

```
✗ DON'T: Use <audio> HTML tag — use Remotion's <Audio>
✗ DON'T: Set volume > 1.0 — causes clipping
✗ DON'T: Start VO at frame 0 — gives no breathing room (start at fps=30 min)
✗ DON'T: Use MP3 with missing metadata — can cause sync issues
✗ DON'T: Load audio from external URLs (slow, unreliable) — use staticFile()
✗ DON'T: Forget to trim silence at start of VO file (pushes timing off)

✓ DO: Always use staticFile() for audio assets
✓ DO: Keep VO normalized to -3dB peak (no clipping, no quiet parts)
✓ DO: Test audio sync at low playback speed in Studio preview
✓ DO: Use <Sequence> to control when audio starts (not trimBefore unless trimming)
✓ DO: Fade music in/out — abrupt start/stop feels amateur
✓ DO: Duck music under voiceover — automatic feels pro
```

### Audio QA Checklist (before final render)

Before rendering the final video, check:
```
☐ Voiceover starts at least 0.5s into video (not frame 0)
☐ Voiceover ends at least 0.3s before video ends
☐ Music volume ≤ 0.15 when voiceover is playing
☐ Music fades out in last 0.5-1.0s
☐ SFX are synced within 1-2 frames of their visual moments
☐ No two sounds compete for the same emotional moment
☐ End card music (if any) starts at same time as end card visual
☐ Total audio levels don't exceed 0dB (no clipping)
```

### NotebookLM Audio Overview — Detailed Protocol

For free AI voiceover via NotebookLM (the recommended path):

**Script length guidelines:**
- 15-second video: 30-40 words (2.5 words/second = natural pace)
- 30-second video: 60-80 words
- 60-second video: 120-160 words

**Custom instruction templates:**

```
For energetic/punchy videos (TikTok, hooks):
  "Create a [N]-second explanation. ONE voice only (not two-host 
  podcast). Energetic developer tone, like showing a friend 
  something cool. Start with: '[specific hook line]'."

For calm/educational (explainers):
  "Create a [N]-second explanation. Calm, clear, educational. 
  Like a teacher explaining to a student. One voice only."

For professional/corporate:
  "Create a [N]-second explanation. Professional, measured pace. 
  Like a product launch presentation. One voice only."

For dramatic/cinematic:
  "Create a [N]-second explanation. Dramatic pauses, emphasis 
  on key words. Like a movie trailer voiceover. One voice only."
```

**Quality issues and fixes:**

```
PROBLEM                          → FIX
───────────────────────────────────────────────────────────────
Two AI hosts instead of one      → Add "ONE voice only" to instructions
Too slow                         → Add "energetic, fast pace"
Sounds robotic                   → Use your own voice, or try ElevenLabs
Wrong pronunciations             → Spell phonetically: "A-T-L-A-S"
Too long / too short             → Regenerate with specific word count:
                                    "Exactly 40 words"
Doesn't match video tone         → Provide a reference:
                                    "Like a tech influencer on TikTok"
```

### Step 4: PREVIEW & RENDER
After writing code:
1. Verify with still frame: npx remotion still [CompositionId] --frame=[key_frame]
2. Tell user: "Check preview in Remotion Studio (localhost:3000)"
3. When approved, render: npx remotion render [CompositionId] out/[name].mp4
4. Report: file path, size, duration

## FORMAT PRESETS

### TikTok / Instagram Reel
```
width: 1080, height: 1920, fps: 30
Duration: 15-30 seconds (15s optimal for algorithmic reach)
Safe zone: 150px top, 170px bottom, 60px sides
Text: bold, large, center-weighted
Pacing: hook in first 2 seconds, new visual every 3-4 seconds
Audio: trending sounds or voiceover (80% watch muted — text overlays mandatory)
```

### YouTube Short
```
width: 1080, height: 1920, fps: 30
Duration: up to 60 seconds
Safe zone: same as TikTok
Pacing: can be slightly slower, more detail
```

### YouTube
```
width: 1920, height: 1080, fps: 30
Duration: unlimited (1-10 min common)
No safe zone issues
Can use smaller text, more detail
```

### Product Demo
```
Use screen recordings in public/ folder
<OffthreadVideo> for embedding real footage
Text overlays for callouts
Zoom effects: scale + translate to focus on UI elements
```

## BRAND MANAGEMENT — CONSISTENCY ACROSS ALL VIDEOS

Video series need consistent look. Before making any video, check for a brand kit.

### Brand Kit Location (standardize on this)
```
[project-root]/src/brand.ts          ← brand config (code, versionable)
[project-root]/public/brand/         ← brand assets (images, audio)
  ├── logo.png              ← main logo (transparent PNG, 1024x1024)
  ├── logo-mark.png         ← square icon version (512x512)
  ├── logo-wordmark.png     ← horizontal text version
  ├── intro-sound.mp3       ← optional: brand audio sting (1-2s)
  ├── outro-music.mp3       ← optional: end card music
  ├── watermark.png         ← optional: corner watermark
  └── bg-texture.png        ← optional: grain/noise overlay
```

### Brand Setup Protocol (run ONCE per project or brand)

Trigger: user asks for a brand, OR no brand.ts exists when making a video.

**Step 1: Check existing brand AND existing compositions:**
```bash
ls src/brand.ts public/brand/ 2>/dev/null
ls src/Composition.tsx src/*.tsx 2>/dev/null | grep -v Root
```

If src/Composition.tsx exists with hardcoded colors (not importing from
'../brand'), this is an UNBRANDED existing composition. Ask user:

```
I see you already have working video compositions without a brand kit.
Options:
  A. Refactor existing compositions to use the brand kit (I'll do it)
  B. Keep existing as-is, brand only applies to NEW videos
  C. Skip brand setup for now, just build this video with defaults

Which? (A/B/C)
```

Default if unclear: B (non-destructive).

**Step 2: If brand doesn't exist, walk user through setup:**

Present this checklist to the user:

```
BRAND KIT SETUP — One-time. Reused in all future videos.

I'll guide you through creating a consistent brand for this project.
You can skip anything and I'll use sensible defaults.

REQUIRED (brand core):
  1. Brand name? (e.g., "ATLAS", "MyProduct")
  2. Primary color? (hex, or say "default" → I'll suggest)
  3. Accent color? (hex, or "default")
  4. Background preference? (dark / light / gradient)

ASSETS (I'll tell you what to create):
  5. Logo — do you have one?
     - YES → place at public/brand/logo.png (1024x1024, transparent)
     - NO → I can suggest a text-based mark (brand name in a font)
     - SKIP → videos will use text-only branding

  6. Intro sound — 1-2 second audio sting at start of videos?
     - YES → place at public/brand/intro-sound.mp3
     - NO → skip

  7. End card music — background track for final 3-5 seconds?
     - YES → place at public/brand/outro-music.mp3
     - Suggested free sources: pixabay.com/music, mixkit.co
     - NO → silent end card

TYPOGRAPHY:
  8. Display font? (titles, hooks)
     - Options: DM Sans, Poppins, Montserrat, Space Grotesk,
       Archivo, Plus Jakarta Sans, Bebas Neue (condensed)
     - Or say "default" → I pick based on brand tone

  9. Code font? (if making dev content)
     - Options: JetBrains Mono, Fira Code, Source Code Pro
     - Or "none" if not making dev content

STYLE:
  10. Motion style?
      - bouncy (playful, consumer-y)
      - snappy (tech, energetic)
      - smooth (professional, corporate)
      - brutal (hard cuts, no easing)
```

**Step 3: Wait for user answers.**

For logo/audio items user said YES to: wait for confirmation they placed the file.

**Step 4: Generate brand.ts file:**

```typescript
// src/brand.ts — AUTO-GENERATED by ATLAS video-production skill
// Edit freely. Used by all videos in this project.

import { staticFile } from 'remotion';

export const BRAND = {
  name: '[NAME]',
  
  colors: {
    primary: '[PRIMARY_HEX]',
    accent: '[ACCENT_HEX]',
    background: '[BG_HEX]',
    backgroundAlt: '[BG_ALT_HEX]',  // for contrast sections
    text: '[TEXT_HEX]',
    textDim: '[TEXT_DIM_HEX]',
    success: '#34d399',
    danger: '#E74C3C',
    warning: '#F59E0B',
    codeBg: '#111827',              // dark code block background
  },
  
  fonts: {
    display: '[DISPLAY_FONT]',       // used for titles, hooks
    code: '[CODE_FONT]',             // used for code blocks
  },
  
  // Motion configuration (applied to spring() animations)
  motion: {
    entrance: { damping: [D], stiffness: [S], mass: [M] },
    // bouncy:  { damping: 8,  stiffness: 100, mass: 0.5 }
    // snappy:  { damping: 15, stiffness: 200, mass: 0.6 }
    // smooth:  { damping: 20, stiffness: 80,  mass: 1 }
  },
  
  // Asset paths (use with <Img src={BRAND.assets.logo} />)
  assets: {
    logo: staticFile('/brand/logo.png'),
    logoMark: staticFile('/brand/logo-mark.png'),
    logoWordmark: staticFile('/brand/logo-wordmark.png'),
    introSound: staticFile('/brand/intro-sound.mp3'),
    outroMusic: staticFile('/brand/outro-music.mp3'),
    watermark: staticFile('/brand/watermark.png'),
  },
  
  // Flags — which assets are available
  has: {
    logo: [true|false],
    logoMark: [true|false],
    introSound: [true|false],
    outroMusic: [true|false],
    watermark: [true|false],
  },
  
  // Layout defaults
  layout: {
    safeZone: { top: 150, bottom: 170, sides: 60 },  // TikTok/Reel
    minFontSize: { headline: 56, body: 36, label: 28 },
    letterSpacing: { title: 4, body: 0 },
  },
};
```

**Step 5: Create a reusable BrandProvider component:**

Write `src/components/BrandKit.tsx`:
```typescript
import { BRAND } from '../brand';
import { loadFont as loadDisplay } from '@remotion/google-fonts/[DisplayFont]';
import { loadFont as loadCode } from '@remotion/google-fonts/[CodeFont]';

// Load fonts once at module level
const { fontFamily: displayFont } = loadDisplay('normal', {
  weights: ['400', '700'],
  subsets: ['latin'],
});
const { fontFamily: codeFont } = loadCode('normal', {
  weights: ['400'],
  subsets: ['latin'],
});

export const FONTS = { display: displayFont, code: codeFont };

// Reusable branded components
export const BrandBackground: React.FC<{children: React.ReactNode}> = ({children}) => (
  <AbsoluteFill style={{ backgroundColor: BRAND.colors.background }}>
    {children}
  </AbsoluteFill>
);

export const BrandLogo: React.FC<{size?: number; variant?: 'mark'|'full'|'wordmark'}> = 
  ({size = 200, variant = 'full'}) => {
    if (!BRAND.has.logo) {
      return <div style={{
        fontSize: size * 0.5, fontFamily: FONTS.display,
        fontWeight: 700, color: BRAND.colors.accent, letterSpacing: 6
      }}>{BRAND.name}</div>;
    }
    const src = variant === 'mark' ? BRAND.assets.logoMark
              : variant === 'wordmark' ? BRAND.assets.logoWordmark
              : BRAND.assets.logo;
    return <Img src={src} style={{height: size}} />;
  };

export const Watermark: React.FC = () => {
  if (!BRAND.has.watermark) return null;
  return <Img src={BRAND.assets.watermark} style={{
    position: 'absolute', bottom: 180, right: 60,
    width: 80, opacity: 0.6
  }} />;
};

export const EndCard: React.FC = () => (
  <BrandBackground>
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      <BrandLogo size={300} />
      <div style={{
        marginTop: 32, fontSize: 36, color: BRAND.colors.textDim,
        fontFamily: FONTS.display,
      }}>
        Link in bio
      </div>
      {BRAND.has.outroMusic && <Audio src={BRAND.assets.outroMusic} volume={0.3} />}
    </AbsoluteFill>
  </BrandBackground>
);
```

**Step 6: Report what was created:**
```
✓ Brand kit created:
  - src/brand.ts (config — edit anytime)
  - src/components/BrandKit.tsx (reusable components)

Next steps:
  1. Place logo at: public/brand/logo.png
  2. Place intro sound at: public/brand/intro-sound.mp3 (optional)
  3. Place outro music at: public/brand/outro-music.mp3 (optional)

All future videos will import from './brand' and './components/BrandKit'
automatically. Edit src/brand.ts to change brand anytime.
```

### Using the Brand Kit in Videos

Every new video composition should import the brand:

```typescript
import { BRAND } from '../brand';
import { FONTS, BrandBackground, BrandLogo, EndCard, Watermark } 
  from '../components/BrandKit';

export const MyVideo = () => {
  return (
    <BrandBackground>
      <AbsoluteFill style={{
        justifyContent: 'center', alignItems: 'center',
        fontFamily: FONTS.display
      }}>
        <div style={{ color: BRAND.colors.accent, fontSize: 72 }}>
          Scene content...
        </div>
      </AbsoluteFill>
      <Watermark />
    </BrandBackground>
  );
};
```

### Consistency Rules (enforce automatically)

When generating a new video, ALWAYS:
- Import from `../brand` instead of hardcoding colors
- Import fonts from `../components/BrandKit` (no duplicate loadFont calls)
- Use <BrandBackground> wrapper for background color consistency
- Use <EndCard> for last 2-3 seconds (unless user says no CTA)
- Respect BRAND.layout.safeZone (all text inside safe area)
- Respect BRAND.layout.minFontSize (never below these)
- Use BRAND.motion.entrance for spring() entrance animations
- If BRAND.has.introSound: play it in first 2 seconds
- If BRAND.has.watermark: include <Watermark /> in all videos

### ATLAS Brand Preset (example)

If the user says "use ATLAS brand" or this is an ATLAS marketing video:

```typescript
// Pre-configured ATLAS brand — can be used as-is or adapted
export const BRAND = {
  name: 'ATLAS',
  colors: {
    primary: '#1B3A5C',      // navy
    accent: '#D4A84B',       // gold
    background: '#0a0e1a',   // near-black navy
    backgroundAlt: '#111827',// dark gray for code blocks
    text: '#e2e8f0',         // light
    textDim: '#64748b',      // muted
    success: '#34d399',
    danger: '#E74C3C',
    warning: '#F59E0B',
    codeBg: '#111827',
  },
  fonts: {
    display: 'DM Sans',      // @remotion/google-fonts/DMSans
    code: 'JetBrains Mono',  // @remotion/google-fonts/JetBrainsMono
  },
  motion: {
    entrance: { damping: 12, stiffness: 100, mass: 0.8 },  // snappy-smooth
  },
  // ... rest as above
};
```

### Brand Asset Creation Guidance

If user says NO to having a logo but wants one:

```
OPTION A — Text-based logo (free, instant):
  I can generate a text mark using your brand name in your display font.
  Just big bold text in the accent color. Works for most tech brands.
  No file needed — handled in code.

OPTION B — AI-generated logo (free with your Gemini Pro):
  1. Open Gemini / Imagen
  2. Paste this prompt:
     "Minimalist logo for [BRAND_NAME]. [STYLE]. Single icon on
      transparent background. Flat design, no gradients, suitable
      for dark AND light backgrounds. 1024x1024."
  3. Download → save as public/brand/logo.png
  4. Tell me "logo ready" and I'll set BRAND.has.logo = true

OPTION C — Commission or design yourself:
  Tools: Canva (free), Figma (free), LogoMakr
  Export as PNG with transparent background, 1024x1024.
  Save to public/brand/logo.png.
```

If user says NO to music but wants it:
```
Free royalty-free music sources:
  - pixabay.com/music (no attribution needed)
  - mixkit.co/free-stock-music
  - uppbeat.io (free tier)
  
Suggested searches for tech/product videos:
  - "tech corporate" / "electronic minimal"
  - "inspirational upbeat" (feature showcase)
  - "suspense drop" (safety/security content)
  - "ambient" (calm explainers)

Download → save to public/brand/outro-music.mp3
  (or create a /public/music/ folder for multiple tracks)
```

### Multi-Brand Projects

If the project serves multiple brands (agency use case):
```
public/brands/
  ├── brand-a/
  │   ├── logo.png
  │   └── brand.json
  ├── brand-b/
  │   └── ...
```

Load brand dynamically via props: `<Composition defaultProps={{brand: 'brand-a'}}>`
See Remotion's parameterized rendering for the pattern.

## VIDEO TYPES & TEMPLATES

### Terminal Demo (dev tools, CLI products)
Hook: dramatic text or question (0-2s)
Demo: screen recording or typed terminal simulation (2-10s)
Result: show the output/effect (10-13s)
CTA: product name + "link in bio" (13-15s)

### Before/After (transformations, improvements)
Split screen or sequential comparison
Left/top: the problem (red tones, messy)
Right/bottom: the solution (green/gold tones, clean)
Transition: slide, wipe, or morph between states

### Feature Showcase (product highlights)
Sequence of 3-5 features, 3 seconds each
Each: icon/visual + short text + spring entrance
Consistent layout, varying content
End card with logo

### Explainer (educational, how-it-works)
Animated diagrams, step-by-step reveal
Use numbered steps with staggered entrance
Arrows, connections between elements
Voiceover-friendly pacing (slower)

### Social Proof / Stats
Big numbers with counting animation
Use interpolate to animate from 0 to target number
Spring scale on the number for impact
Source citation in small text below

## TYPING EFFECT HELPER (for terminal demos)
```typescript
const TypingText: React.FC<{text: string; startFrame: number; speed?: number}> = 
  ({text, startFrame, speed = 2}) => {
    const frame = useCurrentFrame();
    const charsVisible = Math.min(
      text.length,
      Math.max(0, Math.floor((frame - startFrame) / speed))
    );
    const showCursor = Math.floor(frame / 15) % 2 === 0;
    return (
      <span>
        {text.slice(0, charsVisible)}
        {showCursor && charsVisible < text.length ? '▋' : ''}
      </span>
    );
  };
```

## BATCH PRODUCTION
For producing multiple videos from the same template:
1. Create a parameterized composition with props (title, content, etc.)
2. Pass different props via --props flag or JSON file
3. Loop render: for each variant, npx remotion render --props='{"title":"X"}'
4. Output: multiple MP4s from one codebase

## AI-GENERATED BACKGROUNDS (for cinematic depth)

Flat colored backgrounds look like ads. Cinematic AI-generated
backgrounds make videos feel premium. Use this when CONTEXT.md
says "premium/cinematic" or user explicitly asks for it.

### When to use AI backgrounds

USE for:
- Viral content where visual polish matters
- Hero/launch videos
- Product demos promoting premium pricing
- Any scene that currently feels "flat"

SKIP for:
- Terminal-dominant scenes (background distracts from code)
- Fast-paced scenes where background can't be seen clearly
- Budget/time constrained first drafts
- When CONTEXT.md brand says "minimal / flat" aesthetic

### Architecture pattern — toggleable backgrounds

Always implement backgrounds with a feature flag so you can toggle
them on/off without code changes:

```typescript
// Top of src/AtlasViralPromo.tsx
const USE_BG_IMAGES = false;  // Set to true after images are generated

// Per scene
const SceneWithBackground: React.FC<{sceneNum: number; children: React.ReactNode}> = 
  ({sceneNum, children}) => (
    <AbsoluteFill>
      {USE_BG_IMAGES && (
        <>
          <Img 
            src={staticFile(`/backgrounds/scene-${sceneNum}.jpg`)}
            style={{width: '100%', height: '100%', objectFit: 'cover'}}
          />
          {/* Dark overlay ensures text readability */}
          <AbsoluteFill style={{backgroundColor: 'rgba(10,14,26,0.65)'}} />
        </>
      )}
      {children}
    </AbsoluteFill>
  );
```

The 65% dark overlay is critical — it lets text/terminal stay readable
regardless of what's in the generated image.

### Generation protocol

Step 1 — Generate prompts (one per scene):

Structure every prompt with these 5 elements:
1. **Subject** (abstract digital, workshop, shield, command center, etc.)
2. **Palette** (dark navy + accent from BRAND.colors)
3. **Mood** (stressful, cinematic, protective, premium)
4. **Composition** (vertical 9:16, center area clear for text overlay)
5. **Constraint** (dark dominant, no text, minimal/cinematic)

Template:
```
[SUBJECT]. [PALETTE from brand]. [MOOD]. Vertical 9:16
composition. Very dark, minimal, cinematic. No text. 
Focus on [center/edges/specific area] where [text/terminal/etc]
will overlay.
```

Example prompts (proven to work — from ATLAS first video):

```
Scene 1 — Hook (public/backgrounds/scene-1.jpg)
Dark abstract digital space, deep navy blue and black. Subtle glowing
golden neural network nodes connected by thin luminous lines. Faint
particle dust floating. Vertical 9:16 composition. Very dark, minimal,
cinematic. No text. Focus on center where text will overlay.

Scene 2 — Pain (public/backgrounds/scene-2.jpg)
Dark chaotic digital environment. Fragmented broken code lines floating
in space, red and orange warning glows in the background. Shattered
glass or broken circuit board aesthetic. Dark dominant with subtle red
tones. Vertical 9:16. Feels stressful, overwhelming. No text.

Scene 3 — Factory (public/backgrounds/scene-3.jpg)
Dark futuristic workshop or forge. Blue-gold ambient lighting. Abstract
assembly line of AI agents being constructed — glowing wireframe humanoid
silhouettes in various stages of formation. Dark navy background with
warm gold accents. Vertical 9:16. Cinematic, creative energy. No text.

Scene 4 — Safety (public/backgrounds/scene-4.jpg)
Dark imposing digital shield or barrier. Red energy field blocking a
destructive force. Think force field protecting a city at night. Dark
dominant with deep red and crimson accents. Vertical 9:16 composition.
Dramatic, protective feeling. No text.

Scene 5 — Roster (public/backgrounds/scene-5.jpg)
Dark futuristic command center. Multiple holographic screens arranged
in a semicircle, each showing a different specialist silhouette. Navy
blue and gold color scheme. Subtle grid lines on floor. Vertical 9:16.
Team coordination aesthetic. No text.

Scene 6 — CTA (public/backgrounds/scene-6.jpg)
Dark elegant abstract background with a single powerful golden radial
light burst from center. Subtle dark navy particles and dust. Premium,
luxurious feel. Very clean, minimal. Vertical 9:16. The gold light
should leave the center area open for a logo. No text.
```

Step 2 — User generates images with their tool of choice

Recommend in this order:
1. **Gemini Imagen** — best for dark cinematic aesthetics, free tier
2. **Midjourney** — highest quality, subscription
3. **DALL-E 3** (via ChatGPT Plus) — good, strict content filter
4. **Flux.1** (free on fal.ai, replicate.com) — open, high quality
5. **Leonardo AI** — free tier, good for iteration

Always generate at 1080x1920 (9:16 vertical). If tool only outputs
square, generate at max resolution and crop in code.

Step 3 — User saves files

```
public/backgrounds/
  scene-1.jpg    (hook)
  scene-2.jpg    (pain)
  scene-3.jpg    (factory)
  scene-4.jpg    (safety)
  scene-5.jpg    (roster)
  scene-6.jpg    (cta)
```

Step 4 — User flips the flag

```typescript
const USE_BG_IMAGES = true;  // was false
```

Step 5 — Re-render

```bash
npx remotion render CompositionId out/video.mp4
```

### Quality checks for generated backgrounds

Before flipping the flag, verify each image:
- ☐ Is it dark enough? (text must be readable over it)
- ☐ Is the focal text area free of busy elements?
- ☐ Does it match the brand palette?
- ☐ Is it 1080x1920 vertical?
- ☐ Does the mood match the scene's story beat?
- ☐ Are there any accidental text/watermarks? (regenerate if yes)

If a background fails any check, regenerate just that scene.
Don't batch-regenerate — per-scene iteration is cheaper.

### Image optimization (before render)

Large JPGs slow down render. Optimize each:
```bash
# Target: 300-500KB per image (1080x1920 @ 80% quality)
for i in 1 2 3 4 5 6; do
  ffmpeg -y -i public/backgrounds/scene-$i.jpg \
    -vf "scale=1080:1920:flags=lanczos" \
    -q:v 3 public/backgrounds/scene-$i-opt.jpg
  mv public/backgrounds/scene-$i-opt.jpg public/backgrounds/scene-$i.jpg
done
```

### Animating backgrounds

Static backgrounds look cheap. Add subtle motion in Remotion:

```typescript
// Slow zoom (Ken Burns effect)
const zoom = interpolate(frame, [0, durationInFrames], [1, 1.05], {
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
});

<Img 
  src={staticFile(`/backgrounds/scene-${sceneNum}.jpg`)}
  style={{
    width: '100%', height: '100%', objectFit: 'cover',
    transform: `scale(${zoom})`,
  }}
/>

// Slow pan (x or y direction)
const panX = interpolate(frame, [0, durationInFrames], [0, -20]);
transform: `translateX(${panX}px) scale(1.1)`

// Slow rotation (very subtle, 1-2 degrees)
const rotate = interpolate(frame, [0, durationInFrames], [0, 1]);
transform: `rotate(${rotate}deg) scale(1.05)`
```

Subtle motion = cinematic. Avoid fast/jumpy motion — it competes with
your main content.

## ASSET PIPELINE

### Three-Tier (for AI-generated assets)
Check at start of each video task:

TIER 1 — Modal Cloud GPU (check: modal app list):
  If configured: use FLUX.2 for images, Qwen3-TTS for voice
  
TIER 2 — Local GPU (check: nvidia-smi, VRAM >= 6GB):
  If available: use local Piper-TTS for voice
  
TIER 3 — Manual Assets (no GPU):
  Generate asset list with exact prompts:
  - For screenshots: exact commands to run + what to capture
  - For AI images: exact Gemini/Imagen prompt + dimensions
  - For voiceover: exact notebooklm generate audio command
  - For music: suggest free download from pixabay.com with search terms
  
  Write asset list to: public/ASSET-LIST.md
  WAIT for user to place assets in public/
  Validate: check all listed files exist before rendering.

### NotebookLM Integration (for voiceover scripts)
If notebooklm CLI is available:
  1. Generate script: notebooklm ask "Write a [duration] script about [topic]" --notebook [id]
  2. Generate audio: notebooklm generate audio --instructions "[custom]" --wait
  3. Download: place in public/voiceover.mp3
  4. Use in composition: <Audio src={staticFile('/voiceover.mp3')} />

## SCREENSHOT CAPTURE & ANALYSIS

For product demo videos, app promos, and terminal-based content, 
screenshots of the actual product are the hero content. Three paths:

### PATH A: Automated capture via Playwright (best for web apps)

**PRIORITY NOTE:** If an @[app-name]-app-expert exists for this app, 
USE THAT AGENT instead of writing a one-off Playwright script here. 
The app expert has flow scripts, redaction rules, and test credentials
already catalogued. Path A below is the GENERIC fallback for apps 
without a dedicated expert.

If the product is a website or web app, Claude Code can capture 
screenshots automatically using Playwright.

Setup (one-time):
```bash
npm install -D @playwright/test
npx playwright install chromium
```

Capture protocol — write a helper script:
```typescript
// scripts/capture-screenshots.ts
import { chromium } from 'playwright';

const captures = [
  { url: 'http://localhost:3000', name: 'homepage', viewport: {w:1080, h:1920} },
  { url: 'http://localhost:3000/dashboard', name: 'dashboard', viewport: {w:1080, h:1920} },
  { url: 'http://localhost:3000/settings', name: 'settings', viewport: {w:1080, h:1920} },
];

(async () => {
  const browser = await chromium.launch();
  for (const c of captures) {
    const page = await browser.newPage({ viewport: c.viewport });
    await page.goto(c.url);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ 
      path: `public/screenshots/${c.name}.png`,
      fullPage: false 
    });
    console.log(`Captured: ${c.name}.png`);
  }
  await browser.close();
})();
```

Run:
```bash
npx tsx scripts/capture-screenshots.ts
```

Output: public/screenshots/*.png ready for Remotion import.

### PATH B: Terminal/CLI capture (for dev tools, CLI products)

For terminal content, Playwright can record terminal emulator 
sessions, OR use native OS screenshots.

Native screenshot commands:

Windows:
```bash
# Snipping tool (manual):
# Win + Shift + S → save to public/screenshots/

# PowerShell automated (captures active window):
powershell -Command "Add-Type -AssemblyName System.Windows.Forms; \
  [System.Windows.Forms.Screen]::PrimaryScreen.Bounds | ..."
```

macOS:
```bash
# Full screen:
screencapture public/screenshots/terminal.png

# Rectangular selection (interactive):
screencapture -s public/screenshots/terminal.png

# Specific window by ID:
screencapture -l <windowID> public/screenshots/terminal.png
```

Linux:
```bash
# Requires scrot or gnome-screenshot
scrot -s public/screenshots/terminal.png       # selection
gnome-screenshot -w -f public/screenshots/terminal.png  # active window
```

For TikTok terminal demos, the simplest workflow:
```
1. Increase terminal font size (30pt+)
2. Use dark theme (better contrast on video)
3. Run the commands you want to show
4. Screenshot each key moment with Snipping Tool / screencapture
5. Save to public/screenshots/ with descriptive names
```

### PATH C: User-provided screenshots (always works)

Most flexible path — user takes screenshots manually:

```
ATLAS protocol:
1. Based on the spec, generate a shot list:
   "I need these screenshots — please capture and save to public/screenshots/:
     - hook-problem.png — [description of what to capture]
     - demo-step-1.png — [description]
     - demo-step-2.png — [description]
     - result-success.png — [description]
   
   Recommended: 1080px wide for vertical videos
   Format: PNG (preserves UI detail) or JPG (smaller)"

2. WAIT for user: 'screenshots ready'

3. Validate each file exists in public/screenshots/

4. Move to next step (analysis)
```

### SCREENSHOT ANALYSIS (Claude's vision)

Once screenshots exist, Claude analyzes them to determine:

```
1. CONTENT — what's shown on screen?
   Claude reads the screenshot with Read tool.
   Extracts: text visible, UI elements, layout, colors.

2. FOCAL POINT — what should the viewer look at?
   Identifies the hero element (button, result, error message).
   
3. CROP STRATEGY — does it need cropping?
   Full screenshot: use as-is for establishing shots.
   Zoomed: crop to focal area for emphasis shots.
   Highlight: overlay a spotlight/blur on non-focal areas.

4. ANIMATION HINT — how should it enter/exit?
   Static UI: fade in, subtle scale
   Active UI (button click): spring + pulse
   Error/success: shake or bounce
```

Example analysis request in Remotion generation:

```typescript
// Claude reads: public/screenshots/hook-problem.png
// Analyzes: "Shows VS Code with 47 tabs open, messy sidebar"
// Decides: crop to tabs area, add "47 TABS" overlay text
// Generates:
<Img 
  src={staticFile('/screenshots/hook-problem.png')}
  style={{
    width: '120%',         // zoom in
    objectFit: 'cover',
    objectPosition: 'top center',  // focus on tabs
    transform: `scale(${scale})`,
  }}
/>
<div style={{ 
  position: 'absolute', top: '15%', right: '8%',
  background: 'rgba(231, 76, 60, 0.9)',
  color: 'white', padding: '12px 24px',
  fontSize: 72, fontWeight: 900, fontFamily: FONTS.display,
  transform: `rotate(-3deg) scale(${callout})`,
}}>
  47 TABS
</div>
```

### SCREENSHOT EMBED PATTERNS

#### Pattern 1: Full-frame (establishing shot)
Screenshot fills entire frame. Text overlay on top.
```typescript
<AbsoluteFill>
  <Img src={staticFile('/screenshots/app-homepage.png')} 
       style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
  <AbsoluteFill style={{ 
    background: 'linear-gradient(180deg, transparent 60%, rgba(0,0,0,0.8))',
    justifyContent: 'flex-end', padding: 60
  }}>
    <div style={{ color: 'white', fontSize: 72, fontWeight: 700 }}>
      Text on top
    </div>
  </AbsoluteFill>
</AbsoluteFill>
```

#### Pattern 2: Phone mockup (make it feel mobile)
Screenshot inside a phone frame for vertical video emphasis.
```typescript
// Option: use free iPhone mockup PNG from public/brand/phone-frame.png
<AbsoluteFill style={{ 
  justifyContent: 'center', alignItems: 'center',
  background: BRAND.colors.background 
}}>
  <div style={{ position: 'relative', width: 440, height: 900 }}>
    <Img src={staticFile('/screenshots/app-screen.png')} 
         style={{ 
           position: 'absolute', top: 60, left: 40,
           width: 360, borderRadius: 40 
         }} />
    <Img src={staticFile('/brand/phone-frame.png')} 
         style={{ width: '100%' }} />
  </div>
</AbsoluteFill>
```

#### Pattern 3: Before/After split
Two screenshots side-by-side or stacked.
```typescript
<AbsoluteFill style={{ display: 'flex', flexDirection: 'column' }}>
  <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
    <Img src={staticFile('/screenshots/before.png')} 
         style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    <div style={{ 
      position: 'absolute', top: 20, left: 20,
      background: '#E74C3C', color: 'white', 
      padding: '8px 16px', fontSize: 32, fontWeight: 700
    }}>BEFORE</div>
  </div>
  <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
    <Img src={staticFile('/screenshots/after.png')} 
         style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    <div style={{ 
      position: 'absolute', top: 20, left: 20,
      background: '#27AE60', color: 'white', 
      padding: '8px 16px', fontSize: 32, fontWeight: 700
    }}>AFTER</div>
  </div>
</AbsoluteFill>
```

#### Pattern 4: Zoom + highlight
Zoom into a specific UI element with animated callout.
```typescript
const frame = useCurrentFrame();
const zoom = spring({ fps, frame, config: { damping: 15 } });
const arrowOpacity = interpolate(frame, [30, 40], [0, 1], {
  extrapolateRight: 'clamp'
});

<AbsoluteFill>
  <Img src={staticFile('/screenshots/dashboard.png')} 
       style={{
         width: `${100 + zoom * 100}%`,      // zoom from 100% to 200%
         objectFit: 'cover',
         objectPosition: '70% 30%',          // focus on top-right
         transition: 'none'
       }} />
  {/* Animated arrow pointing to element */}
  <div style={{
    position: 'absolute', top: '25%', left: '55%',
    fontSize: 100, opacity: arrowOpacity,
    transform: `translateX(${-20 + zoom * 20}px)`
  }}>👉</div>
</AbsoluteFill>
```

#### Pattern 5: Stacked cards (feature showcase)
Multiple screenshots as layered cards animating in sequence.
```typescript
const screenshots = [
  { src: '/screenshots/feature-1.png', label: 'Fast' },
  { src: '/screenshots/feature-2.png', label: 'Beautiful' },
  { src: '/screenshots/feature-3.png', label: 'Smart' },
];

// Each card animates in with 20-frame stagger
{screenshots.map((shot, i) => {
  const delay = i * 20;
  const y = spring({ 
    fps, frame: frame - delay, 
    config: { damping: 12 } 
  });
  return (
    <div key={i} style={{
      position: 'absolute',
      top: `${20 + i * 28}%`,
      left: '50%',
      transform: `translateX(-50%) translateY(${(1 - y) * 100}px)`,
      width: '80%',
      boxShadow: '0 20px 40px rgba(0,0,0,0.3)',
      borderRadius: 24,
      overflow: 'hidden'
    }}>
      <Img src={staticFile(shot.src)} style={{ width: '100%' }} />
      <div style={{
        position: 'absolute', bottom: 20, left: 20,
        background: BRAND.colors.accent, color: 'white',
        padding: '8px 16px', fontSize: 28, fontWeight: 700,
        borderRadius: 8
      }}>{shot.label}</div>
    </div>
  );
})}
```

### SCREENSHOT OPTIMIZATION

Before embedding, screenshots should be optimized:

```
DIMENSIONS:
  Vertical videos (9:16):  1080px wide minimum
  Horizontal (16:9):       1920px wide minimum
  Avoid tiny screenshots — they look blurry when scaled up

FORMAT:
  PNG — for UI screenshots (preserves text clarity)
  JPG — for photos/realistic images (smaller)
  WebP — for web (best compression, but not all tools support)

FILE SIZE:
  Under 500KB per screenshot (Remotion loads fast)
  If larger: compress with: npx @squoosh/cli --optimize
  OR: ffmpeg -i input.png -vf "scale=1080:-1" output.png

SENSITIVE DATA:
  Before any recording/capture, audit for:
  - API keys visible in terminal
  - Personal info (emails, names)
  - Internal project names
  - Production URLs
  Replace or blur before embedding.
```

### SCREENSHOT WORKFLOW (complete, automated)

When the video spec requires screenshots, follow this protocol:

```
STEP 1: ATLAS generates shot list from spec
  Reads the JSON spec from specialist
  For each scene with "assets_needed" of type "screenshot":
    - Note the filename (e.g., public/screenshots/demo-step-1.png)
    - Note the description (what should be captured)
    - Note dimensions needed

STEP 2: ATLAS determines capture method
  Is the app a web app with a localhost URL?
    YES → offer Path A (Playwright automation)
    NO  → continue
  Is it a VS Code / Terminal / Desktop app?
    YES → offer Path B (OS native screenshot commands)
    NO  → continue
  Default → Path C (user captures manually)

STEP 3: Capture
  Path A: Run Playwright script automatically
  Path B: Provide exact commands for user to run
  Path C: Provide shot list with descriptions, user does manually

STEP 4: Validate
  Check each listed file exists in public/screenshots/
  Read each image to verify it's valid
  If ambiguous: ask user "Is [filename] the right screenshot?"

STEP 5: Analyze
  For each screenshot, use Read tool on the image:
    - Identify focal point
    - Suggest crop/zoom strategy
    - Propose overlay text based on content
  Present analysis to user for confirmation before coding

STEP 6: Generate composition
  Use appropriate pattern (full-frame, phone mockup, before/after, etc.)
  Apply brand overlay styles
  Sync to scene timings from spec

STEP 7: Render preview
  Render still frame at each screenshot moment
  User confirms screenshots look right
  Proceed to full render
```

### EXAMPLE: Complete screenshot flow

User: "Make a 20-second TikTok showing my VS Code productivity extension"

ATLAS:
```
I'll need screenshots for this video. Based on the viral-tiktok-producer 
spec, here's what I need:

  1. public/screenshots/chaos-before.png
     Capture: VS Code with 20+ tabs open, messy sidebar, 
     many notifications. Use your real messy setup.
     
  2. public/screenshots/extension-panel.png
     Capture: Your extension's main UI panel open, showing controls.
     
  3. public/screenshots/clean-after.png
     Capture: VS Code after extension runs — organized, focused.

Capture method options:
  A. Windows Snipping Tool (Win+Shift+S) — simplest
  B. I can write a Playwright script if the UI has a web view
  C. Use the PowerShell screenshot command below

Recommend: Take all 3 screenshots at 1920x1080 or larger.
Save to public/screenshots/ with the exact filenames above.

Tell me when ready.
```

User: "ready"

ATLAS:
```
[Reads each image]

Analysis:
  chaos-before.png: 25 tabs visible, sidebar has 40+ files, 
                    error count badge shows 47. Focal point: 
                    the tab bar (top of window).
                    → Crop: top 30% of image, zoom 1.2x
                    → Overlay: "47 TABS 😱" in red
                    
  extension-panel.png: Clean panel with 3 buttons and a graph.
                       Focal point: the big "Organize" button.
                       → Full frame, slight zoom on button click
                       → Overlay: arrow pointing to button
                       
  clean-after.png: 5 tabs, organized folders, 0 errors.
                   → Full frame, animated from faded to full
                   → Overlay: "0 errors ✓" in green

Proceeding to composition generation...
```

This turns screenshots from passive assets into active storytelling elements.
