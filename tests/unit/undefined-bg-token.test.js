// Tailwind v4 resolves colour utilities from the --color-* tokens declared in
// src/app/globals.css (base themes + `@theme inline`). A class naming a token
// that was never defined emits NO css rule at all, so the element silently loses
// that style — most visibly a panel that renders fully transparent and lets the
// page show through.
//
// That is how the pricing dialog shipped see-through; the same mistake had also
// spread to segmented controls, table headers, hover rows, every text input, and
// the error styling (bg-bg-base / bg-bg-subtle / bg-bg-hover / bg-background /
// bg-input / bg-error / text-error / border-error / text-text-primary / …).
//
// Scope: class attributes only. A utility is checked when it names one of the
// project's semantic colour families; Tailwind's built-in palette (bg-red-50,
// bg-gray-900) and non-colour utilities (bg-cover, shadow-sm, text-xs) need no
// project token and are skipped.
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");
const GLOBALS = fs.readFileSync(path.join(ROOT, "src/app/globals.css"), "utf8");

function definedTokens() {
  const set = new Set();
  for (const m of GLOBALS.matchAll(/--color-([a-z0-9-]+)\s*:/g)) set.add(m[1]);
  return set;
}

// Colour families the project uses. Non-colour utilities of the same prefix
// (text-xs, text-center, border-b, ring-2, shadow-sm, …) are excluded by
// requiring the value to look like a colour name, not a size/shape keyword.
const FAMILIES = ["bg", "text", "border", "ring", "fill", "stroke", "divide", "outline", "accent", "caret"];
const NOT_COLOURS = new Set([
  "xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl",
  "left", "center", "right", "justify", "start", "end", "top", "bottom", "middle",
  "wrap", "nowrap", "balance", "pretty", "ellipsis", "clip",
  "solid", "dashed", "dotted", "double", "none", "hidden", "collapse", "separate",
  "b", "t", "l", "r", "x", "y", "0", "2", "4", "8",
  "auto", "full", "px", "transparent", "current", "inherit", "initial",
]);

// Tailwind palette: colour-<shade>.
const PALETTE = new Set(["red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose", "slate", "gray", "grey", "zinc", "neutral", "stone"]);

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

// Collect class strings from className="..." / className={`...`} / cn("...")
function classStrings(text) {
  const out = [];
  for (const m of text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    if (m[1] !== undefined) out.push(m[1]);
    if (m[2] !== undefined) out.push(m[2]);
  }
  for (const m of text.matchAll(/className=\{[^}]*?"([^"]*)"[^}]*?\}/g)) out.push(m[1]);
  return out;
}

describe("no undefined project colour tokens in src/", () => {
  const tokens = definedTokens();

  it("declares the canonical surface/text/border tokens", () => {
    for (const t of ["surface", "surface-2", "surface-3", "bg", "bg-alt", "text-main", "text-muted", "border", "danger"]) {
      expect(tokens.has(t), `missing --color-${t}`).toBe(true);
    }
  });

  it("every colour utility in a className names a defined token", () => {
    const offenders = [];
    for (const file of jsFiles(SRC)) {
      for (const cls of classStrings(fs.readFileSync(file, "utf8"))) {
        for (const raw of cls.split(/\s+/)) {
          if (!raw) continue;
          const utility = raw.replace(/^(?:[a-z-]+:)+/, ""); // strip variants
          const m = /^(bg|text|border|ring|fill|stroke|divide|outline|accent|caret)-([a-z][a-z0-9-]*?)(?:\/\d+)?$/.exec(utility);
          if (!m) continue;
          const value = m[2];
          if (tokens.has(value)) continue;
          if (NOT_COLOURS.has(value)) continue;
          if (PALETTE.has(value) || PALETTE.has(value.replace(/-\d+$/, ""))) continue;
          // Project classes use the colour keywords bg-surface / bg-bg-*, which
          // are the ones worth flagging.
          if (/^(surface|bg|text|border|danger|success|warning|info|primary|accent)/.test(value)) {
            offenders.push(`${path.relative(ROOT, file)} → ${utility}`);
          }
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("the pricing dialog panel paints an opaque surface", () => {
    const src = fs.readFileSync(path.join(SRC, "shared/components/PricingModal.js"), "utf8");
    expect(src).toMatch(/className="bg-surface border border-border rounded-lg shadow-xl/);
    expect(src).not.toMatch(/bg-bg-base/);
  });
});
