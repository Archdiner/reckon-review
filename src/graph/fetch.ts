/**
 * Fetch a repo's source files for the ephemeral per-PR graph (docs/CODEBASE-GRAPH.md §5).
 *
 * ONE request: download the repo tarball at the PR head, gunzip + untar in memory, keep only the
 * files an extractor supports, discard everything else. No checkout, no persistent index, nothing
 * stored — the files live only for the duration of building the graph, then are dropped. This is
 * what lets Reckon read a change's neighborhood without maintaining a per-repo index.
 *
 * Bounded on purpose (file count + total bytes): a runaway-large repo degrades to "no graph"
 * (the caller falls back to diff-only gating) rather than eating memory. Best-effort: any failure
 * returns [] and the gate proceeds exactly as before.
 */
import { gunzipSync } from 'node:zlib';
import { extract } from 'tar-stream';
import { Readable } from 'node:stream';
import type { RepoFile } from './repo-map.js';
import { extractorFor } from './extractor.js';

const SKIP_DIR = /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.git|__pycache__)(\/|$)/;
const MAX_FILES = 1500;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024; // 8 MB of source is plenty for the graph
const MAX_FILE_BYTES = 256 * 1024; // skip individually huge files (minified bundles etc.)

export interface FetchResult {
  files: RepoFile[];
  truncated: boolean; // hit a cap → the graph is partial (disclosed, never silent)
}

/** Download + untar the repo tarball at `ref`, returning only extractor-supported source files. */
export async function fetchRepoSources(octokit: any, owner: string, repo: string, ref: string): Promise<FetchResult> {
  const res = await octokit.request('GET /repos/{owner}/{repo}/tarball/{ref}', { owner, repo, ref });
  const gz = Buffer.from(res.data as ArrayBuffer);
  const tarBuf = gunzipSync(gz);

  const files: RepoFile[] = [];
  let total = 0;
  let truncated = false;

  await new Promise<void>((resolve, reject) => {
    const ex = extract();
    ex.on('entry', (header, stream, next) => {
      // Tarball paths are prefixed with "<owner>-<repo>-<sha>/"; strip the first segment.
      const rel = header.name.replace(/^[^/]+\//, '');
      const supported = header.type === 'file' && !SKIP_DIR.test(rel) && !!extractorFor(rel);
      const tooBig = (header.size ?? 0) > MAX_FILE_BYTES;

      if (!supported || tooBig || files.length >= MAX_FILES || total >= MAX_TOTAL_BYTES) {
        if ((files.length >= MAX_FILES || total >= MAX_TOTAL_BYTES) && supported && !tooBig) truncated = true;
        stream.resume(); // drain and skip
        stream.on('end', next);
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        const content = Buffer.concat(chunks).toString('utf8');
        total += content.length;
        files.push({ path: rel, content });
        next();
      });
      stream.on('error', next);
    });
    ex.on('finish', resolve);
    ex.on('error', reject);
    Readable.from(tarBuf).pipe(ex);
  });

  return { files, truncated };
}
