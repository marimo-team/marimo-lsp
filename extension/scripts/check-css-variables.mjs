// @ts-check
/** biome-ignore-all lint/suspicious/noUselessEscapeInString: Easier to copy styles from VS Code DevTools */

/**
 * @module check-css-variables
 *
 * Validates that CSS variables we override in styles.css (to map VS Code theme
 * variables to marimo variables) actually exist in marimo's frontend globals.css.
 * This ensures theme compatibility between VS Code and embedded marimo notebooks.
 */

import * as fs from "node:fs";

/**
 * Extract all CSS variable names from a CSS string
 *
 * @param {string} css -CSS content to analyze
 * @returns {{ definitions: Set<string>, uses: Set<string> }}
 */
function extractCSSVariables(css) {
  /** @type {Set<string>} */
  const allVariables = new Set();
  /** @type {Set<string>} */
  const definitions = new Set();

  // First pass: find all CSS variables (both definitions and uses)
  const allVarPattern = /--[\w-]+/g;
  /** @type {RegExpExecArray | null | undefined} */
  let match;
  // biome-ignore lint/suspicious/noAssignInExpressions: implementation is clear
  while ((match = allVarPattern.exec(css)) !== null) {
    allVariables.add(match[0].substring(2)); // Remove the -- prefix
  }

  // Second pass: find only definitions (--var: value)
  const definitionPattern = /--([\w-]+):/g;
  // biome-ignore lint/suspicious/noAssignInExpressions: implementation is clear
  while ((match = definitionPattern.exec(css)) !== null) {
    definitions.add(match[1]);
  }

  // Calculate uses (all variables minus definitions)
  /** @type {Set<string>} */
  const uses = new Set();
  for (const variable of allVariables) {
    if (!definitions.has(variable)) {
      uses.add(variable);
    }
  }

  return { definitions, uses };
}

/**
 * @typedef Diagnostic
 * @prop {"definition" | "use"} type
 * @prop {string} variable
 * @prop {string} message
 */

/**
 * Report diagnostics in a linter-like format
 * @param {Array<Diagnostic>} diagnostics
 * @param {number} total -otal number of variables checked
 */
function reportDiagnostics(diagnostics, total) {
  const reset = "\x1b[0m";
  const bold = "\x1b[1m";
  const red = "\x1b[31m";
  const green = "\x1b[32m";
  const yellow = "\x1b[33m";
  const cyan = "\x1b[36m";

  const valid = total - diagnostics.length;

  console.log();
  if (diagnostics.length === 0) {
    console.log(`${green}${bold}All ${total} variables are valid${reset}`);
    console.log();
    return;
  }

  const percentage = Math.round((valid / total) * 100);
  const statusColor =
    percentage === 100 ? green : percentage >= 80 ? yellow : red;

  console.log(
    `${statusColor}${valid} valid${reset} / ${total} total (${statusColor}${percentage}%${reset})`,
  );
  console.log();
  console.log(
    `${red}${bold}${diagnostics.length} error${diagnostics.length === 1 ? "" : "s"}:${reset}`,
  );
  console.log();

  diagnostics.forEach((diagnostic) => {
    console.log(
      `  ${red}error${reset}  ${diagnostic.message}: ${cyan}--${diagnostic.variable}${reset}`,
    );
  });

  console.log();
}

function check() {
  const dim = "\x1b[2m";
  const reset = "\x1b[0m";

  const target = new URL("../src/renderer/styles.css", import.meta.url);
  console.log(`${dim}Checking ${target}...${reset}`);

  const customVars = extractCSSVariables(
    fs.readFileSync(target, {
      encoding: "utf8",
    }),
  );
  const marimoVars = extractCSSVariables(
    fs.readFileSync(
      new URL(
        "../node_modules/@marimo-team/frontend/src/css/globals.css",
        import.meta.url,
      ),
      { encoding: "utf8" },
    ),
  );
  const vscodeVars = extractCSSVariables(vscodeThemeVariables);

  /** @type {Array<Diagnostic>} */
  const diagnostics = [];

  for (const def of customVars.definitions) {
    if (!marimoVars.definitions.has(def)) {
      diagnostics.push({
        type: "definition",
        variable: def,
        message: "Variable not found in marimo",
      });
    }
  }

  for (const use of customVars.uses) {
    if (
      !(
        (
          vscodeVars.definitions.has(use) ||
          marimoVars.definitions.has(use) ||
          marimoVars.uses.has(use)
        ) // Assumes defined somewhere else in marimo
      )
    ) {
      diagnostics.push({
        type: "use",
        variable: use,
        message: "Variable not available",
      });
    }
  }

  const total = customVars.definitions.size + customVars.uses.size;
  reportDiagnostics(diagnostics, total);

  if (diagnostics.length > 0) {
    process.exit(1);
  }
}

/**
 * VS Code CSS Variables Reference
 *
 * This is a snapshot of CSS variables available in VS Code's webview environment,
 * captured from the browser DevTools console while running the extension.
 *
 * ⚠️ NOTE: This is NOT a perfect representation and may change between VS Code versions.
 * Last updated: 2025-09-25
 *
 * These variables are injected by VS Code into all webviews and represent the current
 * theme colors, fonts, and other UI properties. We use these to ensure our extension's
 * UI matches the user's VS Code theme.
 */
const vscodeThemeVariables = `
element.style {
    --vscode-font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    --vscode-font-weight: normal;
    --vscode-font-size: 13px;
    --vscode-editor-font-family: Menlo, Monaco, 'Courier New', monospace;
    --vscode-editor-font-weight: normal;
    --vscode-editor-font-size: 12px;
    --text-link-decoration: none;
    --vscode-foreground: #3b3b3b;
    --vscode-disabledForeground: rgba(97, 97, 97, 0.5);
    --vscode-errorForeground: #f85149;
    --vscode-descriptionForeground: #3b3b3b;
    --vscode-icon-foreground: #3b3b3b;
    --vscode-focusBorder: #005fb8;
    --vscode-textLink-foreground: #005fb8;
    --vscode-textLink-activeForeground: #005fb8;
    --vscode-textSeparator-foreground: #21262d;
    --vscode-textPreformat-foreground: #3b3b3b;
    --vscode-textPreformat-background: rgba(0, 0, 0, 0.12);
    --vscode-textBlockQuote-background: #f8f8f8;
    --vscode-textBlockQuote-border: #e5e5e5;
    --vscode-textCodeBlock-background: #f8f8f8;
    --vscode-sash-hoverBorder: #005fb8;
    --vscode-badge-background: #cccccc;
    --vscode-badge-foreground: #3b3b3b;
    --vscode-activityWarningBadge-foreground: #ffffff;
    --vscode-activityWarningBadge-background: #bf8803;
    --vscode-activityErrorBadge-foreground: #ffffff;
    --vscode-activityErrorBadge-background: #e51400;
    --vscode-scrollbar-shadow: #dddddd;
    --vscode-scrollbarSlider-background: rgba(100, 100, 100, 0.4);
    --vscode-scrollbarSlider-hoverBackground: rgba(100, 100, 100, 0.7);
    --vscode-scrollbarSlider-activeBackground: rgba(0, 0, 0, 0.6);
    --vscode-progressBar-background: #005fb8;
    --vscode-chart-line: #236b8e;
    --vscode-chart-axis: rgba(0, 0, 0, 0.6);
    --vscode-chart-guide: rgba(0, 0, 0, 0.2);
    --vscode-editor-background: #ffffff;
    --vscode-editor-foreground: #3b3b3b;
    --vscode-editorStickyScroll-background: #ffffff;
    --vscode-editorStickyScrollGutter-background: #ffffff;
    --vscode-editorStickyScrollHover-background: #f0f0f0;
    --vscode-editorStickyScroll-shadow: #dddddd;
    --vscode-editorWidget-background: #f8f8f8;
    --vscode-editorWidget-foreground: #3b3b3b;
    --vscode-editorWidget-border: #c8c8c8;
    --vscode-editorError-foreground: #e51400;
    --vscode-editorWarning-foreground: #bf8803;
    --vscode-editorInfo-foreground: #1a85ff;
    --vscode-editorHint-foreground: #6c6c6c;
    --vscode-editorLink-activeForeground: #0000ff;
    --vscode-editor-selectionBackground: #add6ff;
    --vscode-editor-inactiveSelectionBackground: #e5ebf1;
    --vscode-editor-selectionHighlightBackground: rgba(173, 214, 255, 0.5);
    --vscode-editor-compositionBorder: #000000;
    --vscode-editor-findMatchBackground: #a8ac94;
    --vscode-editor-findMatchHighlightBackground: rgba(234, 92, 0, 0.33);
    --vscode-editor-findRangeHighlightBackground: rgba(180, 180, 180, 0.3);
    --vscode-editor-hoverHighlightBackground: rgba(173, 214, 255, 0.15);
    --vscode-editorHoverWidget-background: #f8f8f8;
    --vscode-editorHoverWidget-foreground: #3b3b3b;
    --vscode-editorHoverWidget-border: #c8c8c8;
    --vscode-editorHoverWidget-statusBarBackground: #ececec;
    --vscode-editorInlayHint-foreground: #969696;
    --vscode-editorInlayHint-background: rgba(204, 204, 204, 0.1);
    --vscode-editorInlayHint-typeForeground: #969696;
    --vscode-editorInlayHint-typeBackground: rgba(204, 204, 204, 0.1);
    --vscode-editorInlayHint-parameterForeground: #969696;
    --vscode-editorInlayHint-parameterBackground: rgba(204, 204, 204, 0.1);
    --vscode-editorLightBulb-foreground: #ddb100;
    --vscode-editorLightBulbAutoFix-foreground: #007acc;
    --vscode-editorLightBulbAi-foreground: #ddb100;
    --vscode-editor-snippetTabstopHighlightBackground: rgba(10, 50, 100, 0.2);
    --vscode-editor-snippetFinalTabstopHighlightBorder: rgba(10, 50, 100, 0.5);
    --vscode-diffEditor-insertedTextBackground: rgba(156, 204, 44, 0.25);
    --vscode-diffEditor-removedTextBackground: rgba(255, 0, 0, 0.2);
    --vscode-diffEditor-insertedLineBackground: rgba(155, 185, 85, 0.2);
    --vscode-diffEditor-removedLineBackground: rgba(255, 0, 0, 0.2);
    --vscode-diffEditor-diagonalFill: rgba(34, 34, 34, 0.2);
    --vscode-diffEditor-unchangedRegionBackground: #f8f8f8;
    --vscode-diffEditor-unchangedRegionForeground: #3b3b3b;
    --vscode-diffEditor-unchangedCodeBackground: rgba(184, 184, 184, 0.16);
    --vscode-widget-shadow: rgba(0, 0, 0, 0.16);
    --vscode-widget-border: #e5e5e5;
    --vscode-toolbar-hoverBackground: rgba(184, 184, 184, 0.31);
    --vscode-toolbar-activeBackground: rgba(166, 166, 166, 0.31);
    --vscode-breadcrumb-foreground: rgba(59, 59, 59, 0.8);
    --vscode-breadcrumb-background: #ffffff;
    --vscode-breadcrumb-focusForeground: #2f2f2f;
    --vscode-breadcrumb-activeSelectionForeground: #2f2f2f;
    --vscode-breadcrumbPicker-background: #f8f8f8;
    --vscode-merge-currentHeaderBackground: rgba(64, 200, 174, 0.5);
    --vscode-merge-currentContentBackground: rgba(64, 200, 174, 0.2);
    --vscode-merge-incomingHeaderBackground: rgba(64, 166, 255, 0.5);
    --vscode-merge-incomingContentBackground: rgba(64, 166, 255, 0.2);
    --vscode-merge-commonHeaderBackground: rgba(96, 96, 96, 0.4);
    --vscode-merge-commonContentBackground: rgba(96, 96, 96, 0.16);
    --vscode-editorOverviewRuler-currentContentForeground: rgba(64, 200, 174, 0.5);
    --vscode-editorOverviewRuler-incomingContentForeground: rgba(64, 166, 255, 0.5);
    --vscode-editorOverviewRuler-commonContentForeground: rgba(96, 96, 96, 0.4);
    --vscode-editorOverviewRuler-findMatchForeground: rgba(209, 134, 22, 0.49);
    --vscode-editorOverviewRuler-selectionHighlightForeground: rgba(160, 160, 160, 0.8);
    --vscode-problemsErrorIcon-foreground: #e51400;
    --vscode-problemsWarningIcon-foreground: #bf8803;
    --vscode-problemsInfoIcon-foreground: #1a85ff;
    --vscode-minimap-findMatchHighlight: #d18616;
    --vscode-minimap-selectionOccurrenceHighlight: #c9c9c9;
    --vscode-minimap-selectionHighlight: #add6ff;
    --vscode-minimap-infoHighlight: #1a85ff;
    --vscode-minimap-warningHighlight: #bf8803;
    --vscode-minimap-errorHighlight: rgba(255, 18, 18, 0.7);
    --vscode-minimap-foregroundOpacity: #000000;
    --vscode-minimapSlider-background: rgba(100, 100, 100, 0.2);
    --vscode-minimapSlider-hoverBackground: rgba(100, 100, 100, 0.35);
    --vscode-minimapSlider-activeBackground: rgba(0, 0, 0, 0.3);
    --vscode-charts-foreground: #3b3b3b;
    --vscode-charts-lines: rgba(59, 59, 59, 0.5);
    --vscode-charts-red: #e51400;
    --vscode-charts-blue: #1a85ff;
    --vscode-charts-yellow: #bf8803;
    --vscode-charts-orange: #d18616;
    --vscode-charts-green: #388a34;
    --vscode-charts-purple: #652d90;
    --vscode-input-background: #ffffff;
    --vscode-input-foreground: #3b3b3b;
    --vscode-input-border: #cecece;
    --vscode-inputOption-activeBorder: #005fb8;
    --vscode-inputOption-hoverBackground: rgba(184, 184, 184, 0.31);
    --vscode-inputOption-activeBackground: #bed6ed;
    --vscode-inputOption-activeForeground: #000000;
    --vscode-input-placeholderForeground: #767676;
    --vscode-inputValidation-infoBackground: #d6ecf2;
    --vscode-inputValidation-infoBorder: #007acc;
    --vscode-inputValidation-warningBackground: #f6f5d2;
    --vscode-inputValidation-warningBorder: #b89500;
    --vscode-inputValidation-errorBackground: #f2dede;
    --vscode-inputValidation-errorBorder: #be1100;
    --vscode-dropdown-background: #ffffff;
    --vscode-dropdown-listBackground: #ffffff;
    --vscode-dropdown-foreground: #3b3b3b;
    --vscode-dropdown-border: #cecece;
    --vscode-button-foreground: #ffffff;
    --vscode-button-separator: rgba(255, 255, 255, 0.4);
    --vscode-button-background: #005fb8;
    --vscode-button-hoverBackground: #0258a8;
    --vscode-button-border: rgba(0, 0, 0, 0.1);
    --vscode-button-secondaryForeground: #3b3b3b;
    --vscode-button-secondaryBackground: #e5e5e5;
    --vscode-button-secondaryHoverBackground: #cccccc;
    --vscode-radio-activeForeground: #000000;
    --vscode-radio-activeBackground: #bed6ed;
    --vscode-radio-activeBorder: #005fb8;
    --vscode-radio-inactiveBorder: rgba(0, 0, 0, 0.2);
    --vscode-radio-inactiveHoverBackground: rgba(184, 184, 184, 0.31);
    --vscode-checkbox-background: #f8f8f8;
    --vscode-checkbox-selectBackground: #f8f8f8;
    --vscode-checkbox-foreground: #3b3b3b;
    --vscode-checkbox-border: #cecece;
    --vscode-checkbox-selectBorder: #3b3b3b;
    --vscode-checkbox-disabled\.background: #b9b9b9;
    --vscode-checkbox-disabled\.foreground: #797979;
    --vscode-keybindingLabel-background: rgba(221, 221, 221, 0.4);
    --vscode-keybindingLabel-foreground: #3b3b3b;
    --vscode-keybindingLabel-border: rgba(204, 204, 204, 0.4);
    --vscode-keybindingLabel-bottomBorder: rgba(187, 187, 187, 0.4);
    --vscode-list-focusOutline: #005fb8;
    --vscode-list-focusAndSelectionOutline: #005fb8;
    --vscode-list-activeSelectionBackground: #e8e8e8;
    --vscode-list-activeSelectionForeground: #000000;
    --vscode-list-activeSelectionIconForeground: #000000;
    --vscode-list-inactiveSelectionBackground: #e4e6f1;
    --vscode-list-hoverBackground: #f2f2f2;
    --vscode-list-dropBackground: #d6ebff;
    --vscode-list-dropBetweenBackground: #3b3b3b;
    --vscode-list-highlightForeground: #0066bf;
    --vscode-list-focusHighlightForeground: #0066bf;
    --vscode-list-invalidItemForeground: #b89500;
    --vscode-list-errorForeground: #b01011;
    --vscode-list-warningForeground: #855f00;
    --vscode-listFilterWidget-background: #f8f8f8;
    --vscode-listFilterWidget-outline: rgba(0, 0, 0, 0);
    --vscode-listFilterWidget-noMatchesOutline: #be1100;
    --vscode-listFilterWidget-shadow: rgba(0, 0, 0, 0.16);
    --vscode-list-filterMatchBackground: rgba(234, 92, 0, 0.33);
    --vscode-list-deemphasizedForeground: #8e8e90;
    --vscode-tree-indentGuidesStroke: #a9a9a9;
    --vscode-tree-inactiveIndentGuidesStroke: rgba(169, 169, 169, 0.4);
    --vscode-tree-tableColumnsBorder: rgba(97, 97, 97, 0.13);
    --vscode-tree-tableOddRowsBackground: rgba(59, 59, 59, 0.04);
    --vscode-editorActionList-background: #f8f8f8;
    --vscode-editorActionList-foreground: #3b3b3b;
    --vscode-editorActionList-focusForeground: #000000;
    --vscode-editorActionList-focusBackground: #e8e8e8;
    --vscode-menu-border: #cecece;
    --vscode-menu-foreground: #3b3b3b;
    --vscode-menu-background: #ffffff;
    --vscode-menu-selectionForeground: #ffffff;
    --vscode-menu-selectionBackground: #005fb8;
    --vscode-menu-separatorBackground: #d4d4d4;
    --vscode-quickInput-background: #f8f8f8;
    --vscode-quickInput-foreground: #3b3b3b;
    --vscode-quickInputTitle-background: rgba(0, 0, 0, 0.06);
    --vscode-pickerGroup-foreground: #8b949e;
    --vscode-pickerGroup-border: #e5e5e5;
    --vscode-quickInputList-focusForeground: #000000;
    --vscode-quickInputList-focusIconForeground: #000000;
    --vscode-quickInputList-focusBackground: #e8e8e8;
    --vscode-search-resultsInfoForeground: #3b3b3b;
    --vscode-searchEditor-findMatchBackground: rgba(234, 92, 0, 0.22);
    --vscode-editor-lineHighlightBorder: #eeeeee;
    --vscode-editor-rangeHighlightBackground: rgba(253, 255, 0, 0.2);
    --vscode-editor-symbolHighlightBackground: rgba(234, 92, 0, 0.33);
    --vscode-editorCursor-foreground: #000000;
    --vscode-editorMultiCursor-primary\.foreground: #000000;
    --vscode-editorMultiCursor-secondary\.foreground: #000000;
    --vscode-editorWhitespace-foreground: rgba(51, 51, 51, 0.2);
    --vscode-editorLineNumber-foreground: #6e7681;
    --vscode-editorIndentGuide-background: rgba(51, 51, 51, 0.2);
    --vscode-editorIndentGuide-activeBackground: rgba(51, 51, 51, 0.2);
    --vscode-editorIndentGuide-background1: #d3d3d3;
    --vscode-editorIndentGuide-background2: rgba(0, 0, 0, 0);
    --vscode-editorIndentGuide-background3: rgba(0, 0, 0, 0);
    --vscode-editorIndentGuide-background4: rgba(0, 0, 0, 0);
    --vscode-editorIndentGuide-background5: rgba(0, 0, 0, 0);
    --vscode-editorIndentGuide-background6: rgba(0, 0, 0, 0);
    --vscode-editorIndentGuide-activeBackground1: #939393;
    --vscode-editorIndentGuide-activeBackground2: rgba(0, 0, 0, 0);
    --vscode-editorIndentGuide-activeBackground3: rgba(0, 0, 0, 0);
    --vscode-editorIndentGuide-activeBackground4: rgba(0, 0, 0, 0);
    --vscode-editorIndentGuide-activeBackground5: rgba(0, 0, 0, 0);
    --vscode-editorIndentGuide-activeBackground6: rgba(0, 0, 0, 0);
    --vscode-editorActiveLineNumber-foreground: #0b216f;
    --vscode-editorLineNumber-activeForeground: #171184;
    --vscode-editorRuler-foreground: #d3d3d3;
    --vscode-editorCodeLens-foreground: #919191;
    --vscode-editorBracketMatch-background: rgba(0, 100, 0, 0.1);
    --vscode-editorBracketMatch-border: #b9b9b9;
    --vscode-editorOverviewRuler-border: #e5e5e5;
    --vscode-editorGutter-background: #ffffff;
    --vscode-editorUnnecessaryCode-opacity: rgba(0, 0, 0, 0.47);
    --vscode-editorGhostText-foreground: rgba(0, 0, 0, 0.47);
    --vscode-editorOverviewRuler-rangeHighlightForeground: rgba(0, 122, 204, 0.6);
    --vscode-editorOverviewRuler-errorForeground: rgba(255, 18, 18, 0.7);
    --vscode-editorOverviewRuler-warningForeground: #bf8803;
    --vscode-editorOverviewRuler-infoForeground: #1a85ff;
    --vscode-editorBracketHighlight-foreground1: #0431fa;
    --vscode-editorBracketHighlight-foreground2: #319331;
    --vscode-editorBracketHighlight-foreground3: #7b3814;
    --vscode-editorBracketHighlight-foreground4: rgba(0, 0, 0, 0);
    --vscode-editorBracketHighlight-foreground5: rgba(0, 0, 0, 0);
    --vscode-editorBracketHighlight-foreground6: rgba(0, 0, 0, 0);
    --vscode-editorBracketHighlight-unexpectedBracket\.foreground: rgba(255, 18, 18, 0.8);
    --vscode-editorBracketPairGuide-background1: rgba(0, 0, 0, 0);
    --vscode-editorBracketPairGuide-background2: rgba(0, 0, 0, 0);
    --vscode-editorBracketPairGuide-background3: rgba(0, 0, 0, 0);
    --vscode-editorBracketPairGuide-background4: rgba(0, 0, 0, 0);
    --vscode-editorBracketPairGuide-background5: rgba(0, 0, 0, 0);
    --vscode-editorBracketPairGuide-background6: rgba(0, 0, 0, 0);
    --vscode-editorBracketPairGuide-activeBackground1: rgba(0, 0, 0, 0);
    --vscode-editorBracketPairGuide-activeBackground2: rgba(0, 0, 0, 0);
    --vscode-editorBracketPairGuide-activeBackground3: rgba(0, 0, 0, 0);
    --vscode-editorBracketPairGuide-activeBackground4: rgba(0, 0, 0, 0);
    --vscode-editorBracketPairGuide-activeBackground5: rgba(0, 0, 0, 0);
    --vscode-editorBracketPairGuide-activeBackground6: rgba(0, 0, 0, 0);
    --vscode-editorUnicodeHighlight-border: #bf8803;
    --vscode-diffEditor-move\.border: rgba(139, 139, 139, 0.61);
    --vscode-diffEditor-moveActive\.border: #ffa500;
    --vscode-diffEditor-unchangedRegionShadow: rgba(115, 115, 115, 0.75);
    --vscode-editorOverviewRuler-bracketMatchForeground: #a0a0a0;
    --vscode-actionBar-toggledBackground: #dddddd;
    --vscode-symbolIcon-arrayForeground: #3b3b3b;
    --vscode-symbolIcon-booleanForeground: #3b3b3b;
    --vscode-symbolIcon-classForeground: #d67e00;
    --vscode-symbolIcon-colorForeground: #3b3b3b;
    --vscode-symbolIcon-constantForeground: #3b3b3b;
    --vscode-symbolIcon-constructorForeground: #652d90;
    --vscode-symbolIcon-enumeratorForeground: #d67e00;
    --vscode-symbolIcon-enumeratorMemberForeground: #007acc;
    --vscode-symbolIcon-eventForeground: #d67e00;
    --vscode-symbolIcon-fieldForeground: #007acc;
    --vscode-symbolIcon-fileForeground: #3b3b3b;
    --vscode-symbolIcon-folderForeground: #3b3b3b;
    --vscode-symbolIcon-functionForeground: #652d90;
    --vscode-symbolIcon-interfaceForeground: #007acc;
    --vscode-symbolIcon-keyForeground: #3b3b3b;
    --vscode-symbolIcon-keywordForeground: #3b3b3b;
    --vscode-symbolIcon-methodForeground: #652d90;
    --vscode-symbolIcon-moduleForeground: #3b3b3b;
    --vscode-symbolIcon-namespaceForeground: #3b3b3b;
    --vscode-symbolIcon-nullForeground: #3b3b3b;
    --vscode-symbolIcon-numberForeground: #3b3b3b;
    --vscode-symbolIcon-objectForeground: #3b3b3b;
    --vscode-symbolIcon-operatorForeground: #3b3b3b;
    --vscode-symbolIcon-packageForeground: #3b3b3b;
    --vscode-symbolIcon-propertyForeground: #3b3b3b;
    --vscode-symbolIcon-referenceForeground: #3b3b3b;
    --vscode-symbolIcon-snippetForeground: #3b3b3b;
    --vscode-symbolIcon-stringForeground: #3b3b3b;
    --vscode-symbolIcon-structForeground: #3b3b3b;
    --vscode-symbolIcon-textForeground: #3b3b3b;
    --vscode-symbolIcon-typeParameterForeground: #3b3b3b;
    --vscode-symbolIcon-unitForeground: #3b3b3b;
    --vscode-symbolIcon-variableForeground: #007acc;
    --vscode-peekViewTitle-background: #f3f3f3;
    --vscode-peekViewTitleLabel-foreground: #000000;
    --vscode-peekViewTitleDescription-foreground: #616161;
    --vscode-peekView-border: #1a85ff;
    --vscode-peekViewResult-background: #ffffff;
    --vscode-peekViewResult-lineForeground: #646465;
    --vscode-peekViewResult-fileForeground: #1e1e1e;
    --vscode-peekViewResult-selectionBackground: rgba(51, 153, 255, 0.2);
    --vscode-peekViewResult-selectionForeground: #6c6c6c;
    --vscode-peekViewEditor-background: #f2f8fc;
    --vscode-peekViewEditorGutter-background: #f2f8fc;
    --vscode-peekViewEditorStickyScroll-background: #f2f8fc;
    --vscode-peekViewEditorStickyScrollGutter-background: #f2f8fc;
    --vscode-peekViewResult-matchHighlightBackground: rgba(187, 128, 9, 0.4);
    --vscode-peekViewEditor-matchHighlightBackground: rgba(187, 128, 9, 0.4);
    --vscode-editor-foldBackground: rgba(173, 214, 255, 0.3);
    --vscode-editor-foldPlaceholderForeground: #808080;
    --vscode-editorGutter-foldingControlForeground: #3b3b3b;
    --vscode-editorSuggestWidget-background: #f8f8f8;
    --vscode-editorSuggestWidget-border: #c8c8c8;
    --vscode-editorSuggestWidget-foreground: #3b3b3b;
    --vscode-editorSuggestWidget-selectedForeground: #000000;
    --vscode-editorSuggestWidget-selectedIconForeground: #000000;
    --vscode-editorSuggestWidget-selectedBackground: #e8e8e8;
    --vscode-editorSuggestWidget-highlightForeground: #0066bf;
    --vscode-editorSuggestWidget-focusHighlightForeground: #0066bf;
    --vscode-editorSuggestWidgetStatus-foreground: rgba(59, 59, 59, 0.5);
    --vscode-inlineEdit-originalBackground: rgba(255, 0, 0, 0.04);
    --vscode-inlineEdit-modifiedBackground: rgba(156, 204, 44, 0.07);
    --vscode-inlineEdit-originalChangedLineBackground: rgba(255, 0, 0, 0.16);
    --vscode-inlineEdit-originalChangedTextBackground: rgba(255, 0, 0, 0.16);
    --vscode-inlineEdit-modifiedChangedLineBackground: rgba(155, 185, 85, 0.14);
    --vscode-inlineEdit-modifiedChangedTextBackground: rgba(156, 204, 44, 0.18);
    --vscode-inlineEdit-gutterIndicator\.primaryForeground: #ffffff;
    --vscode-inlineEdit-gutterIndicator\.primaryBorder: #005fb8;
    --vscode-inlineEdit-gutterIndicator\.primaryBackground: rgba(0, 95, 184, 0.5);
    --vscode-inlineEdit-gutterIndicator\.secondaryForeground: #3b3b3b;
    --vscode-inlineEdit-gutterIndicator\.secondaryBorder: #e5e5e5;
    --vscode-inlineEdit-gutterIndicator\.secondaryBackground: #e5e5e5;
    --vscode-inlineEdit-gutterIndicator\.successfulForeground: #ffffff;
    --vscode-inlineEdit-gutterIndicator\.successfulBorder: #005fb8;
    --vscode-inlineEdit-gutterIndicator\.successfulBackground: #005fb8;
    --vscode-inlineEdit-gutterIndicator\.background: rgba(95, 95, 95, 0.09);
    --vscode-inlineEdit-originalBorder: rgba(255, 0, 0, 0.2);
    --vscode-inlineEdit-modifiedBorder: rgba(62, 81, 18, 0.25);
    --vscode-inlineEdit-tabWillAcceptModifiedBorder: rgba(62, 81, 18, 0.25);
    --vscode-inlineEdit-tabWillAcceptOriginalBorder: rgba(255, 0, 0, 0.2);
    --vscode-editorMarkerNavigationError-background: #e51400;
    --vscode-editorMarkerNavigationError-headerBackground: rgba(229, 20, 0, 0.1);
    --vscode-editorMarkerNavigationWarning-background: #bf8803;
    --vscode-editorMarkerNavigationWarning-headerBackground: rgba(191, 136, 3, 0.1);
    --vscode-editorMarkerNavigationInfo-background: #1a85ff;
    --vscode-editorMarkerNavigationInfo-headerBackground: rgba(26, 133, 255, 0.1);
    --vscode-editorMarkerNavigation-background: #ffffff;
    --vscode-editor-linkedEditingBackground: rgba(255, 0, 0, 0.3);
    --vscode-editor-wordHighlightBackground: rgba(87, 87, 87, 0.25);
    --vscode-editor-wordHighlightStrongBackground: rgba(14, 99, 156, 0.25);
    --vscode-editor-wordHighlightTextBackground: rgba(87, 87, 87, 0.25);
    --vscode-editorOverviewRuler-wordHighlightForeground: rgba(160, 160, 160, 0.8);
    --vscode-editorOverviewRuler-wordHighlightStrongForeground: rgba(192, 160, 192, 0.8);
    --vscode-editorOverviewRuler-wordHighlightTextForeground: rgba(160, 160, 160, 0.8);
    --vscode-editorHoverWidget-highlightForeground: #0066bf;
    --vscode-editor-placeholder\.foreground: rgba(0, 0, 0, 0.47);
    --vscode-tab-activeBackground: #ffffff;
    --vscode-tab-unfocusedActiveBackground: #ffffff;
    --vscode-tab-inactiveBackground: #f8f8f8;
    --vscode-tab-unfocusedInactiveBackground: #f8f8f8;
    --vscode-tab-activeForeground: #3b3b3b;
    --vscode-tab-inactiveForeground: #868686;
    --vscode-tab-unfocusedActiveForeground: rgba(59, 59, 59, 0.7);
    --vscode-tab-unfocusedInactiveForeground: rgba(134, 134, 134, 0.5);
    --vscode-tab-hoverBackground: #ffffff;
    --vscode-tab-unfocusedHoverBackground: #f8f8f8;
    --vscode-tab-border: #e5e5e5;
    --vscode-tab-lastPinnedBorder: #d4d4d4;
    --vscode-tab-activeBorder: #f8f8f8;
    --vscode-tab-unfocusedActiveBorder: #f8f8f8;
    --vscode-tab-activeBorderTop: #005fb8;
    --vscode-tab-unfocusedActiveBorderTop: #e5e5e5;
    --vscode-tab-selectedBorderTop: #68a3da;
    --vscode-tab-selectedBackground: rgba(255, 255, 255, 0.65);
    --vscode-tab-selectedForeground: rgba(51, 51, 51, 0.7);
    --vscode-tab-dragAndDropBorder: #3b3b3b;
    --vscode-tab-activeModifiedBorder: #33aaee;
    --vscode-tab-inactiveModifiedBorder: rgba(51, 170, 238, 0.5);
    --vscode-tab-unfocusedActiveModifiedBorder: rgba(51, 170, 238, 0.7);
    --vscode-tab-unfocusedInactiveModifiedBorder: rgba(51, 170, 238, 0.25);
    --vscode-editorPane-background: #ffffff;
    --vscode-editorGroupHeader-tabsBackground: #f8f8f8;
    --vscode-editorGroupHeader-tabsBorder: #e5e5e5;
    --vscode-editorGroupHeader-noTabsBackground: #ffffff;
    --vscode-editorGroup-border: #e5e5e5;
    --vscode-editorGroup-dropBackground: rgba(38, 119, 203, 0.18);
    --vscode-editorGroup-dropIntoPromptForeground: #3b3b3b;
    --vscode-editorGroup-dropIntoPromptBackground: #f8f8f8;
    --vscode-sideBySideEditor-horizontalBorder: #e5e5e5;
    --vscode-sideBySideEditor-verticalBorder: #e5e5e5;
    --vscode-banner-background: #a2a2a2;
    --vscode-banner-foreground: #000000;
    --vscode-banner-iconForeground: #1a85ff;
    --vscode-statusBar-foreground: #3b3b3b;
    --vscode-statusBar-noFolderForeground: #3b3b3b;
    --vscode-statusBar-background: #f8f8f8;
    --vscode-statusBar-noFolderBackground: #f8f8f8;
    --vscode-statusBar-border: #e5e5e5;
    --vscode-statusBar-focusBorder: #005fb8;
    --vscode-statusBar-noFolderBorder: #e5e5e5;
    --vscode-statusBarItem-activeBackground: rgba(255, 255, 255, 0.18);
    --vscode-statusBarItem-focusBorder: #005fb8;
    --vscode-statusBarItem-hoverBackground: rgba(184, 184, 184, 0.31);
    --vscode-statusBarItem-hoverForeground: #3b3b3b;
    --vscode-statusBarItem-compactHoverBackground: #cccccc;
    --vscode-statusBarItem-prominentForeground: #3b3b3b;
    --vscode-statusBarItem-prominentBackground: rgba(110, 118, 129, 0.4);
    --vscode-statusBarItem-prominentHoverForeground: #3b3b3b;
    --vscode-statusBarItem-prominentHoverBackground: rgba(184, 184, 184, 0.31);
    --vscode-statusBarItem-errorBackground: #c72e0f;
    --vscode-statusBarItem-errorForeground: #ffffff;
    --vscode-statusBarItem-errorHoverForeground: #3b3b3b;
    --vscode-statusBarItem-errorHoverBackground: rgba(184, 184, 184, 0.31);
    --vscode-statusBarItem-warningBackground: #725102;
    --vscode-statusBarItem-warningForeground: #ffffff;
    --vscode-statusBarItem-warningHoverForeground: #3b3b3b;
    --vscode-statusBarItem-warningHoverBackground: rgba(184, 184, 184, 0.31);
    --vscode-activityBar-background: #f8f8f8;
    --vscode-activityBar-foreground: #1f1f1f;
    --vscode-activityBar-inactiveForeground: #616161;
    --vscode-activityBar-border: #e5e5e5;
    --vscode-activityBar-activeBorder: #005fb8;
    --vscode-activityBar-dropBorder: #1f1f1f;
    --vscode-activityBarBadge-background: #005fb8;
    --vscode-activityBarBadge-foreground: #ffffff;
    --vscode-activityBarTop-foreground: #424242;
    --vscode-activityBarTop-activeBorder: #424242;
    --vscode-activityBarTop-inactiveForeground: rgba(66, 66, 66, 0.75);
    --vscode-activityBarTop-dropBorder: #424242;
    --vscode-panel-background: #f8f8f8;
    --vscode-panel-border: #e5e5e5;
    --vscode-panelTitle-activeForeground: #3b3b3b;
    --vscode-panelTitle-inactiveForeground: #3b3b3b;
    --vscode-panelTitle-activeBorder: #005fb8;
    --vscode-panelTitleBadge-background: #005fb8;
    --vscode-panelTitleBadge-foreground: #ffffff;
    --vscode-panelInput-border: #e5e5e5;
    --vscode-panel-dropBorder: #3b3b3b;
    --vscode-panelSection-dropBackground: rgba(38, 119, 203, 0.18);
    --vscode-panelSectionHeader-background: rgba(128, 128, 128, 0.2);
    --vscode-panelSection-border: #e5e5e5;
    --vscode-panelStickyScroll-background: #f8f8f8;
    --vscode-panelStickyScroll-shadow: #dddddd;
    --vscode-profileBadge-background: #c4c4c4;
    --vscode-profileBadge-foreground: #333333;
    --vscode-statusBarItem-remoteBackground: #005fb8;
    --vscode-statusBarItem-remoteForeground: #ffffff;
    --vscode-statusBarItem-remoteHoverForeground: #3b3b3b;
    --vscode-statusBarItem-remoteHoverBackground: rgba(184, 184, 184, 0.31);
    --vscode-statusBarItem-offlineBackground: #6c1717;
    --vscode-statusBarItem-offlineForeground: #ffffff;
    --vscode-statusBarItem-offlineHoverForeground: #3b3b3b;
    --vscode-statusBarItem-offlineHoverBackground: rgba(184, 184, 184, 0.31);
    --vscode-extensionBadge-remoteBackground: #005fb8;
    --vscode-extensionBadge-remoteForeground: #ffffff;
    --vscode-sideBar-background: #f8f8f8;
    --vscode-sideBar-foreground: #3b3b3b;
    --vscode-sideBar-border: #e5e5e5;
    --vscode-sideBarTitle-background: #f8f8f8;
    --vscode-sideBarTitle-foreground: #3b3b3b;
    --vscode-sideBar-dropBackground: rgba(38, 119, 203, 0.18);
    --vscode-sideBarSectionHeader-background: #f8f8f8;
    --vscode-sideBarSectionHeader-foreground: #3b3b3b;
    --vscode-sideBarSectionHeader-border: #e5e5e5;
    --vscode-sideBarActivityBarTop-border: #e5e5e5;
    --vscode-sideBarStickyScroll-background: #f8f8f8;
    --vscode-sideBarStickyScroll-shadow: #dddddd;
    --vscode-titleBar-activeForeground: #1e1e1e;
    --vscode-titleBar-inactiveForeground: #8b949e;
    --vscode-titleBar-activeBackground: #f8f8f8;
    --vscode-titleBar-inactiveBackground: #f8f8f8;
    --vscode-titleBar-border: #e5e5e5;
    --vscode-menubar-selectionForeground: #1e1e1e;
    --vscode-menubar-selectionBackground: rgba(184, 184, 184, 0.31);
    --vscode-commandCenter-foreground: #1e1e1e;
    --vscode-commandCenter-activeForeground: #1e1e1e;
    --vscode-commandCenter-inactiveForeground: #8b949e;
    --vscode-commandCenter-background: rgba(0, 0, 0, 0.05);
    --vscode-commandCenter-activeBackground: rgba(0, 0, 0, 0.08);
    --vscode-commandCenter-border: rgba(30, 30, 30, 0.2);
    --vscode-commandCenter-activeBorder: rgba(30, 30, 30, 0.3);
    --vscode-commandCenter-inactiveBorder: rgba(139, 148, 158, 0.25);
    --vscode-notificationCenter-border: #e5e5e5;
    --vscode-notificationToast-border: #e5e5e5;
    --vscode-notifications-foreground: #3b3b3b;
    --vscode-notifications-background: #ffffff;
    --vscode-notificationLink-foreground: #005fb8;
    --vscode-notificationCenterHeader-foreground: #3b3b3b;
    --vscode-notificationCenterHeader-background: #ffffff;
    --vscode-notifications-border: #e5e5e5;
    --vscode-notificationsErrorIcon-foreground: #e51400;
    --vscode-notificationsWarningIcon-foreground: #bf8803;
    --vscode-notificationsInfoIcon-foreground: #1a85ff;
    --vscode-editorGutter-modifiedBackground: #005fb8;
    --vscode-editorGutter-modifiedSecondaryBackground: #3aa0ff;
    --vscode-editorGutter-addedBackground: #2ea043;
    --vscode-editorGutter-addedSecondaryBackground: #83db93;
    --vscode-editorGutter-deletedBackground: #f85149;
    --vscode-editorGutter-deletedSecondaryBackground: #fcaaa6;
    --vscode-minimapGutter-modifiedBackground: #005fb8;
    --vscode-minimapGutter-addedBackground: #2ea043;
    --vscode-minimapGutter-deletedBackground: #f85149;
    --vscode-editorOverviewRuler-modifiedForeground: rgba(0, 95, 184, 0.6);
    --vscode-editorOverviewRuler-addedForeground: rgba(46, 160, 67, 0.6);
    --vscode-editorOverviewRuler-deletedForeground: rgba(248, 81, 73, 0.6);
    --vscode-editorGutter-itemGlyphForeground: #3b3b3b;
    --vscode-editorGutter-itemBackground: #d5d8e9;
    --vscode-terminal-foreground: #3b3b3b;
    --vscode-terminalCursor-foreground: #005fb8;
    --vscode-terminal-selectionBackground: #add6ff;
    --vscode-terminal-inactiveSelectionBackground: #e5ebf1;
    --vscode-terminalCommandDecoration-defaultBackground: rgba(0, 0, 0, 0.25);
    --vscode-terminalCommandDecoration-successBackground: #2090d3;
    --vscode-terminalCommandDecoration-errorBackground: #e51400;
    --vscode-terminalOverviewRuler-cursorForeground: rgba(160, 160, 160, 0.8);
    --vscode-terminal-border: #e5e5e5;
    --vscode-terminalOverviewRuler-border: #e5e5e5;
    --vscode-terminal-findMatchBackground: #a8ac94;
    --vscode-terminal-hoverHighlightBackground: rgba(173, 214, 255, 0.07);
    --vscode-terminal-findMatchHighlightBackground: rgba(234, 92, 0, 0.33);
    --vscode-terminalOverviewRuler-findMatchForeground: rgba(209, 134, 22, 0.49);
    --vscode-terminal-dropBackground: rgba(38, 119, 203, 0.18);
    --vscode-terminal-tab\.activeBorder: #005fb8;
    --vscode-terminal-initialHintForeground: rgba(0, 0, 0, 0.47);
    --vscode-scmGraph-historyItemRefColor: #1a85ff;
    --vscode-scmGraph-historyItemRemoteRefColor: #652d90;
    --vscode-scmGraph-historyItemBaseRefColor: #ea5c00;
    --vscode-scmGraph-historyItemHoverDefaultLabelForeground: #3b3b3b;
    --vscode-scmGraph-historyItemHoverDefaultLabelBackground: #cccccc;
    --vscode-scmGraph-historyItemHoverLabelForeground: #ffffff;
    --vscode-scmGraph-historyItemHoverAdditionsForeground: #587c0c;
    --vscode-scmGraph-historyItemHoverDeletionsForeground: #ad0707;
    --vscode-scmGraph-foreground1: #ffb000;
    --vscode-scmGraph-foreground2: #dc267f;
    --vscode-scmGraph-foreground3: #994f00;
    --vscode-scmGraph-foreground4: #40b0a6;
    --vscode-scmGraph-foreground5: #b66dff;
    --vscode-commentsView-resolvedIcon: rgba(97, 97, 97, 0.5);
    --vscode-commentsView-unresolvedIcon: #005fb8;
    --vscode-editorCommentsWidget-replyInputBackground: #f3f3f3;
    --vscode-editorCommentsWidget-resolvedBorder: rgba(97, 97, 97, 0.5);
    --vscode-editorCommentsWidget-unresolvedBorder: #005fb8;
    --vscode-editorCommentsWidget-rangeBackground: rgba(0, 95, 184, 0.1);
    --vscode-editorCommentsWidget-rangeActiveBackground: rgba(0, 95, 184, 0.1);
    --vscode-editorGutter-commentRangeForeground: #d5d8e9;
    --vscode-editorOverviewRuler-commentForeground: #d5d8e9;
    --vscode-editorOverviewRuler-commentUnresolvedForeground: #d5d8e9;
    --vscode-editorGutter-commentGlyphForeground: #3b3b3b;
    --vscode-editorGutter-commentUnresolvedGlyphForeground: #3b3b3b;
    --vscode-ports-iconRunningProcessForeground: #369432;
    --vscode-editorWatermark-foreground: rgba(59, 59, 59, 0.68);
    --vscode-settings-headerForeground: #1f1f1f;
    --vscode-settings-settingsHeaderHoverForeground: rgba(31, 31, 31, 0.7);
    --vscode-settings-modifiedItemIndicator: rgba(187, 128, 9, 0.4);
    --vscode-settings-headerBorder: #e5e5e5;
    --vscode-settings-sashBorder: #e5e5e5;
    --vscode-settings-dropdownBackground: #ffffff;
    --vscode-settings-dropdownForeground: #3b3b3b;
    --vscode-settings-dropdownBorder: #cecece;
    --vscode-settings-dropdownListBorder: #c8c8c8;
    --vscode-settings-checkboxBackground: #f8f8f8;
    --vscode-settings-checkboxForeground: #3b3b3b;
    --vscode-settings-checkboxBorder: #cecece;
    --vscode-settings-textInputBackground: #ffffff;
    --vscode-settings-textInputForeground: #3b3b3b;
    --vscode-settings-textInputBorder: #cecece;
    --vscode-settings-numberInputBackground: #ffffff;
    --vscode-settings-numberInputForeground: #3b3b3b;
    --vscode-settings-numberInputBorder: #cecece;
    --vscode-settings-focusedRowBackground: rgba(242, 242, 242, 0.6);
    --vscode-settings-rowHoverBackground: rgba(242, 242, 242, 0.3);
    --vscode-settings-focusedRowBorder: #005fb8;
    --vscode-keybindingTable-headerBackground: rgba(59, 59, 59, 0.04);
    --vscode-keybindingTable-rowsBackground: rgba(59, 59, 59, 0.04);
    --vscode-extensionButton-background: #005fb8;
    --vscode-extensionButton-foreground: #ffffff;
    --vscode-extensionButton-hoverBackground: #0258a8;
    --vscode-extensionButton-separator: rgba(255, 255, 255, 0.4);
    --vscode-extensionButton-prominentBackground: #005fb8;
    --vscode-extensionButton-prominentForeground: #ffffff;
    --vscode-extensionButton-prominentHoverBackground: #0258a8;
    --vscode-debugToolBar-background: #f3f3f3;
    --vscode-debugIcon-startForeground: #388a34;
    --vscode-inlineChat-foreground: #3b3b3b;
    --vscode-inlineChat-background: #f8f8f8;
    --vscode-inlineChat-border: #c8c8c8;
    --vscode-inlineChat-shadow: rgba(0, 0, 0, 0.16);
    --vscode-inlineChatInput-border: #c8c8c8;
    --vscode-inlineChatInput-focusBorder: #005fb8;
    --vscode-inlineChatInput-placeholderForeground: #767676;
    --vscode-inlineChatInput-background: #ffffff;
    --vscode-inlineChatDiff-inserted: rgba(156, 204, 44, 0.13);
    --vscode-editorOverviewRuler-inlineChatInserted: rgba(156, 204, 44, 0.2);
    --vscode-editorMinimap-inlineChatInserted: rgba(156, 204, 44, 0.2);
    --vscode-inlineChatDiff-removed: rgba(255, 0, 0, 0.1);
    --vscode-editorOverviewRuler-inlineChatRemoved: rgba(255, 0, 0, 0.16);
    --vscode-extensionIcon-verifiedForeground: #005fb8;
    --vscode-extensionIcon-starForeground: #df6100;
    --vscode-extensionIcon-preReleaseForeground: #1d9271;
    --vscode-extensionIcon-sponsorForeground: #b51e78;
    --vscode-extensionIcon-privateForeground: rgba(0, 0, 0, 0.38);
    --vscode-chat-requestBorder: rgba(0, 0, 0, 0.1);
    --vscode-chat-requestBackground: rgba(255, 255, 255, 0.62);
    --vscode-chat-slashCommandBackground: rgba(173, 206, 255, 0.48);
    --vscode-chat-slashCommandForeground: #26569e;
    --vscode-chat-avatarBackground: #f2f2f2;
    --vscode-chat-avatarForeground: #3b3b3b;
    --vscode-chat-editedFileForeground: #895503;
    --vscode-chat-requestCodeBorder: rgba(14, 99, 156, 0.25);
    --vscode-chat-requestBubbleBackground: rgba(173, 214, 255, 0.3);
    --vscode-chat-requestBubbleHoverBackground: #add6ff;
    --vscode-chat-checkpointSeparator: #a9a9a9;
    --vscode-chat-linesAddedForeground: #107c10;
    --vscode-chat-linesRemovedForeground: #bc2f32;
    --vscode-notebook-cellBorderColor: #e5e5e5;
    --vscode-notebook-focusedEditorBorder: #005fb8;
    --vscode-notebookStatusSuccessIcon-foreground: #388a34;
    --vscode-notebookEditorOverviewRuler-runningCellForeground: #388a34;
    --vscode-notebookStatusErrorIcon-foreground: #f85149;
    --vscode-notebookStatusRunningIcon-foreground: #3b3b3b;
    --vscode-notebook-cellToolbarSeparator: rgba(128, 128, 128, 0.35);
    --vscode-notebook-selectedCellBackground: rgba(200, 221, 241, 0.31);
    --vscode-notebook-selectedCellBorder: #e5e5e5;
    --vscode-notebook-focusedCellBorder: #005fb8;
    --vscode-notebook-inactiveFocusedCellBorder: #e5e5e5;
    --vscode-notebook-cellStatusBarItemHoverBackground: rgba(0, 0, 0, 0.08);
    --vscode-notebook-cellInsertionIndicator: #005fb8;
    --vscode-notebookScrollbarSlider-background: rgba(100, 100, 100, 0.4);
    --vscode-notebookScrollbarSlider-hoverBackground: rgba(100, 100, 100, 0.7);
    --vscode-notebookScrollbarSlider-activeBackground: rgba(0, 0, 0, 0.6);
    --vscode-notebook-symbolHighlightBackground: rgba(253, 255, 0, 0.2);
    --vscode-notebook-cellEditorBackground: #f8f8f8;
    --vscode-notebook-editorBackground: #ffffff;
    --vscode-debugExceptionWidget-border: #a31515;
    --vscode-debugExceptionWidget-background: #f1dfde;
    --vscode-editor-inlineValuesForeground: rgba(0, 0, 0, 0.5);
    --vscode-editor-inlineValuesBackground: rgba(255, 200, 0, 0.2);
    --vscode-debugIcon-breakpointForeground: #e51400;
    --vscode-debugIcon-breakpointDisabledForeground: #848484;
    --vscode-debugIcon-breakpointUnverifiedForeground: #848484;
    --vscode-debugIcon-breakpointCurrentStackframeForeground: #be8700;
    --vscode-debugIcon-breakpointStackframeForeground: #89d185;
    --vscode-editor-stackFrameHighlightBackground: rgba(255, 255, 102, 0.45);
    --vscode-editor-focusedStackFrameHighlightBackground: rgba(206, 231, 206, 0.45);
    --vscode-multiDiffEditor-headerBackground: #f8f8f8;
    --vscode-multiDiffEditor-background: #ffffff;
    --vscode-multiDiffEditor-border: #cccccc;
    --vscode-minimap-chatEditHighlight: rgba(255, 255, 255, 0.6);
    --vscode-gauge-foreground: #007acc;
    --vscode-gauge-background: rgba(0, 122, 204, 0.3);
    --vscode-gauge-warningForeground: #b89500;
    --vscode-gauge-warningBackground: rgba(184, 149, 0, 0.3);
    --vscode-gauge-errorForeground: #be1100;
    --vscode-gauge-errorBackground: rgba(190, 17, 0, 0.3);
    --vscode-mcpIcon-starForeground: #df6100;
    --vscode-interactive-activeCodeBorder: #007acc;
    --vscode-interactive-inactiveCodeBorder: #e4e6f1;
    --vscode-testing-iconFailed: #f14c4c;
    --vscode-testing-iconErrored: #f14c4c;
    --vscode-testing-iconPassed: #73c991;
    --vscode-testing-runAction: #73c991;
    --vscode-testing-iconQueued: #cca700;
    --vscode-testing-iconUnset: #848484;
    --vscode-testing-iconSkipped: #848484;
    --vscode-testing-peekBorder: #e51400;
    --vscode-testing-messagePeekBorder: #1a85ff;
    --vscode-testing-peekHeaderBackground: rgba(229, 20, 0, 0.1);
    --vscode-testing-messagePeekHeaderBackground: rgba(26, 133, 255, 0.1);
    --vscode-testing-coveredBackground: rgba(156, 204, 44, 0.25);
    --vscode-testing-coveredBorder: rgba(156, 204, 44, 0.19);
    --vscode-testing-coveredGutterBackground: rgba(156, 204, 44, 0.15);
    --vscode-testing-uncoveredBranchBackground: #ff9999;
    --vscode-testing-uncoveredBackground: rgba(255, 0, 0, 0.2);
    --vscode-testing-uncoveredBorder: rgba(255, 0, 0, 0.15);
    --vscode-testing-uncoveredGutterBackground: rgba(255, 0, 0, 0.3);
    --vscode-testing-coverCountBadgeBackground: #cccccc;
    --vscode-testing-coverCountBadgeForeground: #3b3b3b;
    --vscode-testing-message\.error\.badgeBackground: #e51400;
    --vscode-testing-message\.error\.badgeBorder: #e51400;
    --vscode-testing-message\.error\.badgeForeground: #ffffff;
    --vscode-testing-message\.info\.decorationForeground: rgba(59, 59, 59, 0.5);
    --vscode-testing-iconErrored\.retired: rgba(241, 76, 76, 0.7);
    --vscode-testing-iconFailed\.retired: rgba(241, 76, 76, 0.7);
    --vscode-testing-iconPassed\.retired: rgba(115, 201, 145, 0.7);
    --vscode-testing-iconQueued\.retired: rgba(204, 167, 0, 0.7);
    --vscode-testing-iconUnset\.retired: rgba(132, 132, 132, 0.7);
    --vscode-testing-iconSkipped\.retired: rgba(132, 132, 132, 0.7);
    --vscode-searchEditor-textInputBorder: #cecece;
    --vscode-statusBar-debuggingBackground: #fd716c;
    --vscode-statusBar-debuggingForeground: #000000;
    --vscode-statusBar-debuggingBorder: #e5e5e5;
    --vscode-commandCenter-debuggingBackground: rgba(253, 113, 108, 0.26);
    --vscode-debugTokenExpression-name: #9b46b0;
    --vscode-debugTokenExpression-type: #4a90e2;
    --vscode-debugTokenExpression-value: rgba(108, 108, 108, 0.8);
    --vscode-debugTokenExpression-string: #a31515;
    --vscode-debugTokenExpression-boolean: #0000ff;
    --vscode-debugTokenExpression-number: #098658;
    --vscode-debugTokenExpression-error: #e51400;
    --vscode-debugView-exceptionLabelForeground: #ffffff;
    --vscode-debugView-exceptionLabelBackground: #a31515;
    --vscode-debugView-stateLabelForeground: #3b3b3b;
    --vscode-debugView-stateLabelBackground: rgba(136, 136, 136, 0.27);
    --vscode-debugView-valueChangedHighlight: #569cd6;
    --vscode-debugConsole-infoForeground: #1a85ff;
    --vscode-debugConsole-warningForeground: #bf8803;
    --vscode-debugConsole-errorForeground: #f85149;
    --vscode-debugConsole-sourceForeground: #3b3b3b;
    --vscode-debugConsoleInputIcon-foreground: #3b3b3b;
    --vscode-debugIcon-pauseForeground: #007acc;
    --vscode-debugIcon-stopForeground: #a1260d;
    --vscode-debugIcon-disconnectForeground: #a1260d;
    --vscode-debugIcon-restartForeground: #388a34;
    --vscode-debugIcon-stepOverForeground: #007acc;
    --vscode-debugIcon-stepIntoForeground: #007acc;
    --vscode-debugIcon-stepOutForeground: #007acc;
    --vscode-debugIcon-continueForeground: #007acc;
    --vscode-debugIcon-stepBackForeground: #007acc;
    --vscode-mergeEditor-change\.background: rgba(155, 185, 85, 0.2);
    --vscode-mergeEditor-change\.word\.background: rgba(156, 204, 44, 0.4);
    --vscode-mergeEditor-changeBase\.background: #ffcccc;
    --vscode-mergeEditor-changeBase\.word\.background: #ffa3a3;
    --vscode-mergeEditor-conflict\.unhandledUnfocused\.border: #ffa600;
    --vscode-mergeEditor-conflict\.unhandledFocused\.border: #ffa600;
    --vscode-mergeEditor-conflict\.handledUnfocused\.border: rgba(134, 134, 134, 0.29);
    --vscode-mergeEditor-conflict\.handledFocused\.border: rgba(193, 193, 193, 0.8);
    --vscode-mergeEditor-conflict\.handled\.minimapOverViewRuler: rgba(173, 172, 168, 0.93);
    --vscode-mergeEditor-conflict\.unhandled\.minimapOverViewRuler: #fcba03;
    --vscode-mergeEditor-conflictingLines\.background: rgba(255, 234, 0, 0.28);
    --vscode-mergeEditor-conflict\.input1\.background: rgba(64, 200, 174, 0.2);
    --vscode-mergeEditor-conflict\.input2\.background: rgba(64, 166, 255, 0.2);
    --vscode-terminal-ansiBlack: #000000;
    --vscode-terminal-ansiRed: #cd3131;
    --vscode-terminal-ansiGreen: #107c10;
    --vscode-terminal-ansiYellow: #949800;
    --vscode-terminal-ansiBlue: #0451a5;
    --vscode-terminal-ansiMagenta: #bc05bc;
    --vscode-terminal-ansiCyan: #0598bc;
    --vscode-terminal-ansiWhite: #555555;
    --vscode-terminal-ansiBrightBlack: #666666;
    --vscode-terminal-ansiBrightRed: #cd3131;
    --vscode-terminal-ansiBrightGreen: #14ce14;
    --vscode-terminal-ansiBrightYellow: #b5ba00;
    --vscode-terminal-ansiBrightBlue: #0451a5;
    --vscode-terminal-ansiBrightMagenta: #bc05bc;
    --vscode-terminal-ansiBrightCyan: #0598bc;
    --vscode-terminal-ansiBrightWhite: #a5a5a5;
    --vscode-simpleFindWidget-sashBorder: #c8c8c8;
    --vscode-terminalStickyScrollHover-background: #f0f0f0;
    --vscode-terminalCommandGuide-foreground: #e4e6f1;
    --vscode-terminalSymbolIcon-flagForeground: #d67e00;
    --vscode-terminalSymbolIcon-aliasForeground: #652d90;
    --vscode-terminalSymbolIcon-optionValueForeground: #007acc;
    --vscode-terminalSymbolIcon-methodForeground: #652d90;
    --vscode-terminalSymbolIcon-argumentForeground: #007acc;
    --vscode-terminalSymbolIcon-optionForeground: #d67e00;
    --vscode-terminalSymbolIcon-fileForeground: #3b3b3b;
    --vscode-terminalSymbolIcon-folderForeground: #3b3b3b;
    --vscode-terminalSymbolIcon-commitForeground: #3b3b3b;
    --vscode-terminalSymbolIcon-branchForeground: #3b3b3b;
    --vscode-terminalSymbolIcon-tagForeground: #3b3b3b;
    --vscode-terminalSymbolIcon-stashForeground: #3b3b3b;
    --vscode-terminalSymbolIcon-remoteForeground: #3b3b3b;
    --vscode-terminalSymbolIcon-pullRequestForeground: #3b3b3b;
    --vscode-terminalSymbolIcon-pullRequestDoneForeground: #3b3b3b;
    --vscode-terminalSymbolIcon-symbolicLinkFileForeground: #3b3b3b;
    --vscode-terminalSymbolIcon-symbolicLinkFolderForeground: #3b3b3b;
    --vscode-welcomePage-tileBackground: #f3f3f3;
    --vscode-welcomePage-tileHoverBackground: #dfdfdf;
    --vscode-welcomePage-tileBorder: rgba(0, 0, 0, 0.1);
    --vscode-welcomePage-progress\.background: #ffffff;
    --vscode-welcomePage-progress\.foreground: #005fb8;
    --vscode-walkthrough-stepTitle\.foreground: #000000;
    --vscode-walkThrough-embeddedEditorBackground: #f4f4f4;
    --vscode-profiles-sashBorder: #e5e5e5;
    --vscode-gitDecoration-addedResourceForeground: #587c0c;
    --vscode-gitDecoration-modifiedResourceForeground: #895503;
    --vscode-gitDecoration-deletedResourceForeground: #ad0707;
    --vscode-gitDecoration-renamedResourceForeground: #007100;
    --vscode-gitDecoration-untrackedResourceForeground: #007100;
    --vscode-gitDecoration-ignoredResourceForeground: #8e8e90;
    --vscode-gitDecoration-stageModifiedResourceForeground: #895503;
    --vscode-gitDecoration-stageDeletedResourceForeground: #ad0707;
    --vscode-gitDecoration-conflictingResourceForeground: #ad0707;
    --vscode-gitDecoration-submoduleResourceForeground: #1258a7;
    --vscode-git-blame\.editorDecorationForeground: #969696;
    --vscode-editor-font-feature-settings: "liga" off, "calt" off;
    --theme-input-border-width: 1px;
    --theme-button-primary-hover-shadow: none;
    --theme-button-secondary-hover-shadow: none;
    --theme-input-border-color: transparent;
    --theme-font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    --theme-font-weight: normal;
    --theme-font-size: 13px;
    --theme-code-font-family: Menlo, Monaco, 'Courier New', monospace;
    --theme-code-font-weight: normal;
    --theme-code-font-size: 12px;
    --theme-scrollbar-background: rgba(100, 100, 100, 0.4);
    --theme-scrollbar-hover-background: rgba(100, 100, 100, 0.7);
    --theme-scrollbar-active-background: rgba(0, 0, 0, 0.6);
    --theme-quote-background: #f8f8f8;
    --theme-quote-border: #e5e5e5;
    --theme-code-foreground: #3b3b3b;
    --theme-code-background: rgba(0, 0, 0, 0.12);
    --theme-background: #ffffff;
    --theme-foreground: #3b3b3b;
    --theme-ui-foreground: #3b3b3b;
    --theme-link: #005fb8;
    --theme-link-active: #005fb8;
    --theme-button-background: #005fb8;
    --theme-button-hover-background: #0258a8;
    --theme-button-foreground: #ffffff;
    --theme-button-secondary-background: #e5e5e5;
    --theme-button-secondary-hover-background: #cccccc;
    --theme-button-secondary-foreground: #3b3b3b;
    --theme-button-hover-foreground: #ffffff;
    --theme-button-focus-foreground: #ffffff;
    --theme-button-secondary-hover-foreground: #3b3b3b;
    --theme-button-secondary-focus-foreground: #3b3b3b;
    --theme-input-background: #ffffff;
    --theme-input-foreground: #3b3b3b;
    --theme-input-placeholder-foreground: #767676;
    --theme-input-focus-border-color: #005fb8;
    --theme-menu-background: #ffffff;
    --theme-menu-foreground: #3b3b3b;
    --theme-menu-hover-background: #005fb8;
    --theme-menu-focus-background: #005fb8;
    --theme-menu-hover-foreground: #ffffff;
    --theme-menu-focus-foreground: #ffffff;
    --theme-error-background: #f2dede;
    --theme-error-foreground: #3b3b3b;
    --theme-warning-background: #f6f5d2;
    --theme-warning-foreground: #3b3b3b;
    --theme-info-background: #d6ecf2;
    --theme-info-foreground: #3b3b3b;
    --theme-notebook-output-background: undefined;
    --theme-notebook-output-border: undefined;
    --theme-notebook-cell-selected-background: rgba(200, 221, 241, 0.31);
    --theme-notebook-symbol-highlight-background: rgba(253, 255, 0, 0.2);
    --theme-notebook-diff-removed-background: rgba(255, 0, 0, 0.2);
    --theme-notebook-diff-inserted-background: rgba(156, 204, 44, 0.25);
    --notebook-output-left-margin: 44px;
    --notebook-output-width: calc(100% - 60px);
    --notebook-output-node-padding: 8px;
    --notebook-run-gutter: 36px;
    --notebook-preview-node-padding: 8px;
    --notebook-markdown-left-margin: 44px;
    --notebook-output-node-left-padding: 8px;
    --notebook-markdown-min-height: 16px;
    --notebook-markup-font-size: calc(12px * 1.2);
    --notebook-markdown-line-height: normal;
    --notebook-cell-output-font-size: 12px;
    --notebook-cell-output-line-height: 18px;
    --notebook-cell-output-max-height: 542px;
    --notebook-cell-output-font-family: Menlo, Monaco, 'Courier New', monospace;
    --notebook-cell-markup-empty-content: Empty markdown cell, double-click or press enter to edit .;
    --notebook-cell-renderer-not-found-error: No renderer found for '$0';
    --notebook-cell-renderer-fallbacks-exhausted: Could not render content for '$0';
}
`;

if (import.meta.main) {
  check();
}
