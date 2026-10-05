import { annotationActivity, groupMissedActivity, type ActivityGroup, type PublishedAnnotations } from './activity';
import type { AnnotationVisits } from './visits';

interface ActivityTrackerOptions {
  visits: AnnotationVisits;
  pageName: string;
  oldid: number;
  viewer: string;
  read(revision: number): Promise<PublishedAnnotations>;
  show(group: ActivityGroup): void;
  error(error: unknown): void;
}

/** The viewed marker advances only after the mounted view accepts a committed revision. */
export function activityTracker(options: ActivityTrackerOptions) {
  let latest: PublishedAnnotations | undefined, closed = false;
  let queue: Promise<void> = Promise.resolve();
  const accept = async (current: PublishedAnnotations) => {
    if (closed || (latest && current.revision <= latest.revision)) return;
    const initial = latest === undefined;
    let previous = latest;
    if (initial) {
      try {
        const viewed = options.visits.get(options.oldid)?.viewedRevision;
        if (viewed !== undefined && viewed < current.revision) previous = viewed === 0
          ? { revision: 0, generation: current.generation, records: {} } : await options.read(viewed);
      } catch (error) { options.error(error); }
    }
    if (closed) return;
    if (previous) {
      const actions = annotationActivity(previous, current, options.viewer);
      const groups = initial ? groupMissedActivity(actions, current.records) : actions.map(action => ({ actions: [action], target: action }));
      for (const group of groups) options.show(group);
    }
    latest = current;
    try { options.visits.viewed(options.pageName, options.oldid, current.revision); }
    catch (error) { options.error(error); }
  };
  return {
    receive(current: PublishedAnnotations): Promise<void> {
      queue = queue.then(() => accept(current)).catch(error => { if (!closed) options.error(error); });
      return queue;
    },
    destroy() { closed = true; },
  };
}
