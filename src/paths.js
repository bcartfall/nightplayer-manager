import { isAbsolute, relative } from 'node:path';

/** True when `target` is strictly inside `root` (no traversal, not root itself). */
export function isInside(root, target) {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
