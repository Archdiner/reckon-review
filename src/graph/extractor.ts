/**
 * Symbol extraction — the swappable backend of the codebase graph (see docs/CODEBASE-GRAPH.md).
 *
 * A SymbolExtractor turns one file's source into its defined symbols + the symbols it references,
 * NAME-BASED (like Aider's tree-sitter tags), not type-resolved. The interface is deliberately
 * narrow so the backend can move build → buy later: TS-compiler now, tree-sitter (multi-language)
 * or SCIP (precise, type-aware) behind the same shape, without touching the graph engine.
 *
 * The first backend uses the TypeScript compiler's SYNTACTIC API (ts.createSourceFile, no
 * type-checker, no Program) — it is already a dependency, adds nothing, and is precise enough for
 * a name-based reference graph on TS/JS/TSX.
 */
import ts from 'typescript';

export type DefKind = 'function' | 'method' | 'class' | 'const';

export interface SymbolDef {
  name: string;
  kind: DefKind;
  line: number; // 1-indexed
  signature: string; // the declaration's first source line, trimmed
}

export interface SymbolRef {
  name: string;
  line: number;
}

export interface FileSymbols {
  path: string;
  defs: SymbolDef[];
  refs: SymbolRef[];
}

export interface SymbolExtractor {
  /** Whether this extractor handles the given file. */
  supports(path: string): boolean;
  /** Extract defs + refs from one file. Must not throw on malformed input (return best-effort). */
  extract(path: string, content: string): FileSymbols;
}

const TS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

function scriptKind(path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/i.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export class TsSymbolExtractor implements SymbolExtractor {
  supports(path: string): boolean {
    return TS_EXT.test(path);
  }

  extract(path: string, content: string): FileSymbols {
    const defs: SymbolDef[] = [];
    const refs: SymbolRef[] = [];
    let sf: ts.SourceFile;
    try {
      sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind(path));
    } catch {
      return { path, defs, refs }; // never throw: a parse failure just yields an empty file
    }
    const lines = content.split('\n');
    const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const sigOf = (node: ts.Node): string => (lines[lineOf(node) - 1] || '').trim().replace(/\s*\{?\s*$/, '');

    const pushDef = (name: string, kind: DefKind, node: ts.Node): void => {
      defs.push({ name, kind, line: lineOf(node), signature: sigOf(node) });
    };

    const walk = (n: ts.Node): void => {
      // Definitions
      if (ts.isFunctionDeclaration(n) && n.name) pushDef(n.name.text, 'function', n);
      else if (ts.isMethodDeclaration(n) && n.name && ts.isIdentifier(n.name)) pushDef(n.name.text, 'method', n);
      else if (ts.isClassDeclaration(n) && n.name) pushDef(n.name.text, 'class', n);
      // Top-level `const x = () => {}` / `const x = function(){}` (a common export shape)
      else if (
        ts.isVariableDeclaration(n) &&
        n.name &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
      ) {
        pushDef(n.name.text, 'const', n);
      }
      // References: call targets (foo(), obj.method())
      if (ts.isCallExpression(n)) {
        const e = n.expression;
        if (ts.isIdentifier(e)) refs.push({ name: e.text, line: lineOf(e) });
        else if (ts.isPropertyAccessExpression(e)) refs.push({ name: e.name.text, line: lineOf(e.name) });
      }
      // References: `new Foo()`
      if (ts.isNewExpression(n) && n.expression && ts.isIdentifier(n.expression)) {
        refs.push({ name: n.expression.text, line: lineOf(n.expression) });
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
    return { path, defs, refs };
  }
}

/** The default extractor set. Add tree-sitter / SCIP backends here later. */
export const DEFAULT_EXTRACTORS: SymbolExtractor[] = [new TsSymbolExtractor()];

export function extractorFor(path: string, extractors = DEFAULT_EXTRACTORS): SymbolExtractor | null {
  return extractors.find((e) => e.supports(path)) ?? null;
}
