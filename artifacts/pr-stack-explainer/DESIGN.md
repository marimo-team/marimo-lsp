---
name: Causal Proof Sheet
description: An interactive architecture explainer where event traces prove or disprove ownership claims.
colors:
  proof-paper: "#f4f6f3"
  proof-surface: "#ffffff"
  proof-ink: "#14211b"
  proof-muted: "#52635a"
  proof-line: "#c5d0c8"
  proof-blue: "#2251cc"
  proof-green: "#087a55"
  proof-red: "#bd2c2c"
  proof-amber: "#a45b08"
typography:
  display:
    fontFamily: "Arial Narrow, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(2.8rem, 8vw, 5.8rem)"
    fontWeight: 800
    lineHeight: 0.92
    letterSpacing: "-0.035em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.65
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.55
rounded:
  control: "6px"
  panel: "10px"
spacing:
  xs: "6px"
  sm: "12px"
  md: "20px"
  lg: "36px"
  xl: "64px"
components:
  action:
    backgroundColor: "{colors.proof-ink}"
    textColor: "{colors.proof-paper}"
    rounded: "{rounded.control}"
    padding: "10px 14px"
  proof-node:
    backgroundColor: "{colors.proof-surface}"
    textColor: "{colors.proof-ink}"
    rounded: "{rounded.panel}"
    padding: "16px"
---

# Design System: Causal Proof Sheet

## Overview

**Creative North Star: "The Causal Proof Sheet"**

The artifact borrows its structure from proof trees, logic-analyzer traces, and annotated code review. Architecture claims are treated as propositions: the reader sees their premises, follows the event sequence, and watches the conclusion either hold or fail. The page is a working sheet rather than a gallery of diagrams.

The visual world is precise but not sterile. Dense evidence uses monospaced text only where exact identity, state, or code matters; explanations remain in a highly readable system sans. Blue marks the proposed stack, green marks a guarantee that holds, red marks a counterexample, and amber marks an assumption that still needs proof.

**Key Characteristics:**

- Long horizontal traces for causality and ownership.
- Open, editorial sections instead of a grid of interchangeable cards.
- Code and state treated as evidence, never decoration.
- Controls that change the proof in place.
- Conclusions visibly attached to the premises that justify them.

## Colors

The palette resembles a cool engineering worksheet under normal office light, with semantic inks used sparingly.

### Primary

- **Proof Blue** (`#2251cc`): proposed architecture, active controls, and selected paths.

### Secondary

- **Verified Green** (`#087a55`): gains and invariants demonstrated by the current stack.
- **Counterexample Red** (`#bd2c2c`): broken causal chains and blocking risks.
- **Assumption Amber** (`#a45b08`): guarantees that depend on undocumented ordering or protocol behavior.

### Neutral

- **Proof Paper** (`#f4f6f3`): page background.
- **Proof Surface** (`#ffffff`): code sheets and focused comparison panes.
- **Proof Ink** (`#14211b`): primary text and structural controls.
- **Proof Muted** (`#52635a`): secondary explanation.
- **Proof Line** (`#c5d0c8`): rules, trace rails, and inactive structure.

**The Semantic Ink Rule.** Blue, green, red, and amber always communicate architectural state; they are not ornamental accents.

## Typography

**Display Font:** Arial Narrow / Helvetica Neue / Arial

**Body Font:** platform system sans

**Label/Mono Font:** platform UI monospace

**Character:** Headings are compressed and declarative, like section titles on a technical plate. Body text stays conversational. Monospace is reserved for Interfaces, event identities, state, and measurements.

### Hierarchy

- **Display:** 800, responsive 2.8–5.8rem, 0.92 line height; the conceptual delta in the first viewport.
- **Headline:** 750, responsive 1.8–3rem, 1.05 line height; major conclusions.
- **Title:** 700, 1.1–1.35rem; modules and proof steps.
- **Body:** 400, 1rem, 1.65 line height, maximum 72ch.
- **Label:** 650, 0.72rem, modest letter spacing; trace metadata and state labels.

**The Evidence Type Rule.** If text can be paraphrased without losing truth, it is body text; only exact facts earn monospace.

## Layout

The page uses a reading column for explanation and breaks into the full viewport for architecture maps and timelines. A narrow sticky index shows progress on wide screens and becomes a compact top rail on mobile. Dense comparisons use aligned columns above 860px and a before-then-after sequence below it.

Spacing follows a 6/12/20/36/64px rhythm. Major sections are separated by at least 96px; related proof steps stay tightly grouped.

## Elevation & Depth

The system is flat by default. Hierarchy comes from rules, tonal fields, scale, and clipping. Only the sticky navigator and an actively lifted trace token use a soft offset shadow.

**The Structural Depth Rule.** Depth appears only when an element is physically detached by scrolling or interaction.

## Shapes

Panels use 10px corners; controls use 6px. Trace rails, proof bars, and code selections stay rectilinear. Pills are restricted to compact state labels. Borders are one pixel and never doubled with a panel shadow.

## Components

### Architecture switch

A two-state segmented control changes all synchronized comparisons between previous and proposed architecture. It uses text, color, and a moving underline so state remains clear without color.

### Event trace

Events sit on horizontal rails for editor, runtime, reducer, and VS Code. Advancing the trace moves one token, updates state, and reveals the resulting claim. Counterexample mode introduces a deliberate race and marks where causal identity is lost.

### Code sheet

Code appears with line numbers, highlighted Interface facts, and plain-language annotations. Tabs switch between the previous and proposed sketches without changing scroll position.

### Proof conclusion

A proposition bar connects premises to a conclusion. Verified conclusions use green; unearned conclusions use amber; demonstrated failures use red and name the missing fact.

## Do's and Don'ts

### Do:

- **Do** synchronize controls so the same conceptual choice updates diagrams, code, and explanations.
- **Do** keep explanations adjacent to the exact state or event they interpret.
- **Do** expose counterexamples as replayable sequences.
- **Do** preserve content and keyboard operation under reduced motion.

### Don't:

- **Don't** use decorative diagrams whose arrows cannot be explained as events or ownership.
- **Don't** hide the unresolved risks in footnotes or a final caveat section.
- **Don't** use equal-weight cards as the page's organizing structure.
- **Don't** imply the recommended future architecture is already implemented.
