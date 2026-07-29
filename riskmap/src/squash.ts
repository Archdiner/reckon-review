/**
 * Step 5 — squash-convention detection.
 *
 * THIS IS THE FAILURE THAT WOULD DISCREDIT THE MAP FASTEST, because the reader knows their own
 * merge settings and this tool does not.
 *
 * Some repositories squash every pull request to its title. The description the author wrote
 * lives on GitHub and never enters git, so a record dimension computed from commit messages
 * measures the merge button rather than any author. Reporting that as a documentation
 * catastrophe would be confidently, checkably wrong on the first thing the reader looks at.
 *
 * The study already measured this across nine repositories and rejected three of them for it:
 * home-assistant and n8n squash with the title alone (0% non-trivial bodies), django and
 * kubernetes never let the description enter git at all. Astro was rejected at 17%. That is
 * where the thresholds below come from — they are not invented for this file.
 *
 * SO THE DIMENSION IS MARKED UNAVAILABLE RATHER THAN REPORTED AS ZERO. An absent measurement
 * that says it is absent costs nothing. A fake catastrophe costs the reader.
 *
 * Note what is NOT inferred from this: nothing about the quality of the team's documentation.
 * A repo that squashes may write excellent descriptions that this tool cannot see. The verdict
 * is strictly about whether the INSTRUMENT works here.
 */

import { classifyRecord } from './vendor/triviality.js';
import type { Commit, SquashVerdict } from './types.js';

/** Below this share of substantive bodies, commit messages carry no record worth scoring. */
export const UNAVAILABLE_BELOW = 0.1;
/** Between the two, the dimension is computed but reported as weak evidence. */
export const LOW_CONFIDENCE_BELOW = 0.25;

export const SAMPLE_SIZE = 200;

/**
 * Sample the most recent commits and measure how many carry a body beyond the subject.
 *
 * Most recent rather than random: merge conventions change, and what matters is the convention
 * in force over the window being reported, not the one a project used in 2016.
 */
export function detectSquashConvention(commits: Commit[], sampleSize = SAMPLE_SIZE): SquashVerdict {
  const sample = [...commits].sort((a, b) => b.at - a.at).slice(0, sampleSize);
  if (sample.length === 0) {
    return {
      availability: 'unavailable',
      substantiveBodyShare: 0,
      sampled: 0,
      note: 'No commits available to sample, so the record dimension could not be tested and is not reported.',
    };
  }

  let substantive = 0;
  for (const c of sample) {
    if (classifyRecord(`${c.subject}\n${c.body}`).tier === 'substantive') substantive++;
  }
  const share = substantive / sample.length;

  if (share < UNAVAILABLE_BELOW) {
    return {
      availability: 'unavailable',
      substantiveBodyShare: share,
      sampled: sample.length,
      note:
        `Only ${(share * 100).toFixed(1)}% of the last ${sample.length} commits carry any body beyond ` +
        'their subject line. That is the signature of squash-on-merge: the description the author ' +
        'wrote stayed on the pull request and never entered git. Record coverage would measure ' +
        'this repository’s merge settings rather than anything its authors did, so it is not ' +
        'reported and does not contribute to any flag.',
    };
  }

  if (share < LOW_CONFIDENCE_BELOW) {
    return {
      availability: 'low-confidence',
      substantiveBodyShare: share,
      sampled: sample.length,
      note:
        `${(share * 100).toFixed(1)}% of the last ${sample.length} commits carry a body beyond their ` +
        'subject. That is low enough that the merge convention is doing some of the work, so record ' +
        'coverage is shown for context but is treated as weak evidence and is not used to flag a region.',
    };
  }

  return {
    availability: 'available',
    substantiveBodyShare: share,
    sampled: sample.length,
    note:
      `${(share * 100).toFixed(1)}% of the last ${sample.length} commits carry a body beyond their ` +
      'subject, so descriptions survive into git here and the record dimension is measuring authors ' +
      'rather than merge settings.',
  };
}

/** Whether the record dimension may contribute to flagging. */
export function recordUsableForFlags(v: SquashVerdict): boolean {
  return v.availability === 'available';
}
