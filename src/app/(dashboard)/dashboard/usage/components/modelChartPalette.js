const PRIMARY_HUES = [0, 30, 60, 150, 180, 215, 270];
const VARIANTS = [
  [0, 88, 58],
  [-12, 94, 64],
  [12, 92, 52],
  [-7, 84, 70],
  [7, 96, 46],
  [-18, 90, 60],
  [18, 86, 66],
  [-24, 80, 68],
  [24, 96, 54],
  [-10, 72, 74],
  [10, 84, 44],
  [-30, 90, 62],
];

export const DELETED_MODEL_COLOR = "hsl(220 8% 58%)";
const stableAssignments = new Map();

function normalizeHue(hue) {
  return ((hue % 360) + 360) % 360;
}

export function getVividModelColor(index) {
  const normalizedIndex = Math.max(0, Math.floor(index || 0));
  const familyIndex = normalizedIndex % PRIMARY_HUES.length;
  const variantIndex = Math.floor(normalizedIndex / PRIMARY_HUES.length) % VARIANTS.length;
  const [hueOffset, saturation, lightness] = VARIANTS[variantIndex];
  const hue = normalizeHue(PRIMARY_HUES[familyIndex] + hueOffset);
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

export function assignModelColors(keys, previousAssignments = new Map(), deletedKeys = new Set()) {
  const uniqueKeys = [...new Set(keys)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const assignments = new Map();
  const usedIndexes = new Set();
  const unassigned = [];

  for (const key of uniqueKeys) {
    const previousIndex = previousAssignments.get(key);
    if (Number.isInteger(previousIndex) && previousIndex >= 0) {
      assignments.set(key, previousIndex);
      usedIndexes.add(previousIndex);
    } else {
      unassigned.push(key);
    }
  }

  let nextIndex = 0;
  for (const key of unassigned) {
    while (usedIndexes.has(nextIndex)) nextIndex += 1;
    assignments.set(key, nextIndex);
    usedIndexes.add(nextIndex);
    nextIndex += 1;
  }

  const colors = new Map();
  for (const key of uniqueKeys) {
    const index = assignments.get(key);
    colors.set(key, {
      index,
      color: deletedKeys.has(key) ? DELETED_MODEL_COLOR : getVividModelColor(index),
    });
  }
  return colors;
}

export function assignStableModelColors(keys, deletedKeys = new Set()) {
  const colors = assignModelColors(keys, stableAssignments, deletedKeys);
  for (const [key, entry] of colors) stableAssignments.set(key, entry.index);
  return colors;
}
