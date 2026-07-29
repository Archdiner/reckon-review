/**
 * Exclusions.
 *
 * The protocol drops dependency bumps, generated files, lockfiles, formatting-only changes
 * and anything under ~20 changed lines, on the grounds that they have no mechanism to
 * explain and would wash out the signal. That reasoning is sound but it cuts both ways: an
 * over-eager filter that also drops, say, every test-only change would quietly redefine
 * what the headline number is about.
 *
 * So the filter works at two levels and reports what it removed:
 *
 *   FILE level  — machine-maintained files are removed from the diff and do not count
 *                 toward changed lines. A PR that adds one real function next to a 4000-line
 *                 regenerated client should be measured on the function.
 *   PR level    — after file filtering, a PR is dropped if it is a dependency bump, is
 *                 formatting-only, is documentation-only, or falls under the size floor.
 *
 * Every drop is counted by reason and reported at the end of stage 1, because "we sampled
 * 500 PRs" means nothing without "out of how many, and what went where".
 */

export interface DiffFile {
  path: string;
  added: number;
  deleted: number;
  /** The file's section of the unified diff, verbatim. */
  patch: string;
}

export type DropReason =
  | 'dependency-bump'
  | 'dependency-manifest-only'
  | 'formatting-only'
  | 'docs-only'
  | 'below-size-floor'
  | 'no-surviving-files'
  | 'diff-unavailable';

export const SIZE_FLOOR = 20;

const GENERATED_PATH =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|Gemfile\.lock|go\.sum|composer\.lock|uv\.lock|requirements\.txt\.lock)$/i;

const GENERATED_DIR =
  /(^|\/)(vendor|third_party|node_modules|dist|build|\.next|__generated__|generated|__snapshots__|testdata\/generated|\.yarn)\//i;

const GENERATED_SUFFIX =
  /(\.min\.(js|css)|\.pb\.go|\.pb\.cc|\.pb\.h|_pb2\.py|_pb2_grpc\.py|\.generated\.(ts|tsx|js|go|cs)|\.snap|\.g\.dart|\.designer\.cs)$/i;

const GENERATED_HINT = /(^|\/)(schema\.graphql|openapi\.(json|yaml)|swagger\.(json|yaml))$/i;

const DOC_PATH = /\.(md|mdx|rst|txt|adoc)$/i;

/**
 * Dependency manifests. A change confined to these is a version-constraint edit whatever the
 * title says, and it has no mechanism to explain.
 *
 * The title-pattern check below only catches conventionally-named bumps ("chore(deps): bump
 * x"). Reading the pilot corpus by hand surfaced the miss it cannot catch: an Airflow PR
 * titled "Remove obsolete pandas specification for pre-python 3.9" that edits nothing but
 * version constraints across thirteen provider.yaml files. Nothing in the title marks it as a
 * dependency change; only the file set does. That is precisely the class the protocol wanted
 * excluded, and precisely the kind of bug that only shows up when you read the output.
 */
const DEPENDENCY_MANIFEST =
  /(^|\/)(package\.json|provider\.yaml|pyproject\.toml|requirements[^/]*\.txt|constraints[^/]*\.txt|go\.mod|Cargo\.toml|Gemfile|setup\.py|setup\.cfg|build\.gradle(\.kts)?|pom\.xml|composer\.json|Pipfile|environment\.ya?ml)$/i;

const DEP_BUMP_TITLE =
  /^(chore(\(deps[^)]*\))?|build\(deps[^)]*\)|deps?)\s*:?\s*(bump|update|upgrade|pin)\b|^bump\s+\S+\s+from\s+\S+\s+to\s+\S+|^update\s+dependenc/i;

export function isGeneratedPath(path: string): boolean {
  return (
    GENERATED_PATH.test(path) ||
    GENERATED_DIR.test(path) ||
    GENERATED_SUFFIX.test(path) ||
    GENERATED_HINT.test(path)
  );
}

export function isDocPath(path: string): boolean {
  return DOC_PATH.test(path);
}

export function isDependencyBump(subject: string): boolean {
  return DEP_BUMP_TITLE.test(subject.trim());
}

/**
 * Whitespace-insensitive comparison of the added and removed line multisets. If they match,
 * nothing changed but layout — a reformat, an import sort, a prettier run. Such a change has
 * no mechanism, so a record that says nothing about mechanism is not evidence of anything.
 */
export function isFormattingOnly(files: DiffFile[]): boolean {
  const norm = (l: string) => l.slice(1).replace(/\s+/g, '');
  const added: string[] = [];
  const removed: string[] = [];
  for (const f of files) {
    for (const line of f.patch.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        const n = norm(line);
        if (n) added.push(n);
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        const n = norm(line);
        if (n) removed.push(n);
      }
    }
  }
  if (added.length === 0 || removed.length === 0) return false;
  if (added.length !== removed.length) return false;
  added.sort();
  removed.sort();
  return added.every((v, i) => v === removed[i]);
}

export interface FilterOutcome {
  keep: boolean;
  reason?: DropReason;
  files: DiffFile[];
  changedLines: number;
}

export function applyExclusions(subject: string, allFiles: DiffFile[]): FilterOutcome {
  if (isDependencyBump(subject)) {
    return { keep: false, reason: 'dependency-bump', files: [], changedLines: 0 };
  }

  const files = allFiles.filter((f) => !isGeneratedPath(f.path));
  if (files.length === 0) {
    return { keep: false, reason: 'no-surviving-files', files: [], changedLines: 0 };
  }

  if (files.every((f) => isDocPath(f.path))) {
    return { keep: false, reason: 'docs-only', files, changedLines: 0 };
  }

  if (files.every((f) => DEPENDENCY_MANIFEST.test(f.path))) {
    return { keep: false, reason: 'dependency-manifest-only', files, changedLines: 0 };
  }

  // Documentation accompanying a code change is legitimate content and stays in the diff;
  // it is only the docs-ONLY case above that is dropped.
  const changedLines = files.reduce((n, f) => n + f.added + f.deleted, 0);

  if (isFormattingOnly(files)) {
    return { keep: false, reason: 'formatting-only', files, changedLines };
  }

  if (changedLines < SIZE_FLOOR) {
    return { keep: false, reason: 'below-size-floor', files, changedLines };
  }

  return { keep: true, files, changedLines };
}
