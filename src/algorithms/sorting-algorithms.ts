/**
 * Classic Sorting Algorithms
 *
 * Learning-oriented implementations of comparison-based sorting algorithms.
 * Each method returns a new sorted array (does not mutate input).
 *
 * Algorithms implemented:
 * - Bubble sort    O(n²) — educational, avoid in production
 * - Insertion sort O(n²) — good for small or nearly sorted data
 * - Selection sort O(n²) — simple, always n²
 * - Merge sort     O(n log n) — stable, predictable (single reusable buffer,
 *                  skips merges of already-ordered halves)
 * - Quick sort     O(n log n) worst case — introsort: median-of-three pivot,
 *                  3-way partition, insertion sort for small ranges, and a
 *                  heapsort fallback at depth 2·log2(n) (Musser 1997)
 * - Heap sort      O(n log n) — in-place, no worst-case quicksort blowup
 */

/** Comparator: return negative if a < b, zero if equal, positive if a > b. */
export type CompareFn<T> = (a: T, b: T) => number;

/** In-place sort signature used internally (mutates array, no return). */
export type InPlaceSortFn<T> = (arr: T[], compare: CompareFn<T>) => void;

const defaultCompare: CompareFn<number> = (a, b) => a - b;

/**
 * Copy array and run sort in-place on the copy; return the copy.
 */
function sortCopy<T>(arr: T[], compare: CompareFn<T>, sortFn: InPlaceSortFn<T>): T[] {
  const out = arr.slice();
  sortFn(out, compare);
  return out;
}

function defaultCompareOr<T>(compare: CompareFn<T> | undefined): CompareFn<T> {
  return (compare ?? defaultCompare) as CompareFn<T>;
}

/** Below this size, insertion sort beats the O(n log n) sorts on real hardware. */
const SMALL_RANGE_CUTOFF = 24;

/** Insertion sort on a[lo..hi] inclusive (in place). */
function insertionSortRange<T>(a: T[], lo: number, hi: number, cmp: CompareFn<T>): void {
  for (let i = lo + 1; i <= hi; i++) {
    const v = a[i];
    let j = i - 1;
    while (j >= lo && cmp(a[j], v) > 0) {
      a[j + 1] = a[j];
      j--;
    }
    a[j + 1] = v;
  }
}

/** Heap sort on a[lo..hi] inclusive (in place). Iterative sift-down: O(1) stack. */
function heapSortRange<T>(a: T[], lo: number, hi: number, cmp: CompareFn<T>): void {
  const n = hi - lo + 1;
  const siftDown = (start: number, size: number): void => {
    let root = start;
    for (;;) {
      const left = 2 * root + 1;
      if (left >= size) break;
      const right = left + 1;
      let largest = root;
      if (cmp(a[lo + left], a[lo + largest]) > 0) largest = left;
      if (right < size && cmp(a[lo + right], a[lo + largest]) > 0) largest = right;
      if (largest === root) break;
      const t = a[lo + root];
      a[lo + root] = a[lo + largest];
      a[lo + largest] = t;
      root = largest;
    }
  };
  for (let i = Math.floor(n / 2) - 1; i >= 0; i--) siftDown(i, n);
  for (let size = n - 1; size > 0; size--) {
    const t = a[lo];
    a[lo] = a[lo + size];
    a[lo + size] = t;
    siftDown(0, size);
  }
}

/**
 * Median-of-three pivot: sorts a[lo], a[mid], a[hi] in place and returns the
 * median value (now at a[mid]). Defeats the classic sorted/reverse-sorted
 * quicksort killer inputs that a fixed first/last pivot suffers from.
 */
function medianOfThree<T>(a: T[], lo: number, hi: number, cmp: CompareFn<T>): T {
  const mid = lo + ((hi - lo) >> 1);
  let t: T;
  if (cmp(a[mid], a[lo]) < 0) {
    t = a[lo];
    a[lo] = a[mid];
    a[mid] = t;
  }
  if (cmp(a[hi], a[lo]) < 0) {
    t = a[lo];
    a[lo] = a[hi];
    a[hi] = t;
  }
  if (cmp(a[hi], a[mid]) < 0) {
    t = a[mid];
    a[mid] = a[hi];
    a[hi] = t;
  }
  return a[mid];
}

export class SortingAlgorithms {
  /**
   * Bubble sort
   *
   * Why: Simplest sort; repeatedly swap adjacent pairs until no swaps needed.
   * When: Learning only. Use merge/quick/heap for real data.
   * Complexity: O(n²) time, O(1) space (on the copy).
   */
  static bubbleSort(arr: number[]): number[];
  static bubbleSort<T>(arr: T[], compare: CompareFn<T>): T[];
  static bubbleSort<T>(arr: T[], compare?: CompareFn<T>): T[] {
    return sortCopy(arr, defaultCompareOr(compare), (a, cmp) => {
      for (let i = 0; i < a.length; i++) {
        let swapped = false;
        for (let j = 0; j < a.length - 1 - i; j++) {
          if (cmp(a[j], a[j + 1]) > 0) {
            [a[j], a[j + 1]] = [a[j + 1], a[j]];
            swapped = true;
          }
        }
        if (!swapped) break;
      }
    });
  }

  /**
   * Insertion sort
   *
   * Why: Build sorted region one element at a time; efficient for small n or nearly sorted.
   * When: Small arrays (< ~50), or when input is almost sorted (e.g. re-sorting after small changes).
   * Complexity: O(n²) worst, O(n) when nearly sorted; O(1) extra space.
   */
  static insertionSort(arr: number[]): number[];
  static insertionSort<T>(arr: T[], compare: CompareFn<T>): T[];
  static insertionSort<T>(arr: T[], compare?: CompareFn<T>): T[] {
    return sortCopy(arr, defaultCompareOr(compare), (a, cmp) => {
      for (let i = 1; i < a.length; i++) {
        const v = a[i];
        let j = i - 1;
        while (j >= 0 && cmp(a[j], v) > 0) {
          a[j + 1] = a[j];
          j--;
        }
        a[j + 1] = v;
      }
    });
  }

  /**
   * Selection sort
   *
   * Why: Find min of unsorted region, swap to front; simple but always Θ(n²).
   * When: Learning or when writes are expensive (minimal swaps).
   * Complexity: O(n²) time, O(1) extra space.
   */
  static selectionSort(arr: number[]): number[];
  static selectionSort<T>(arr: T[], compare: CompareFn<T>): T[];
  static selectionSort<T>(arr: T[], compare?: CompareFn<T>): T[] {
    return sortCopy(arr, defaultCompareOr(compare), (a, cmp) => {
      for (let i = 0; i < a.length - 1; i++) {
        let minIdx = i;
        for (let j = i + 1; j < a.length; j++) {
          if (cmp(a[j], a[minIdx]) < 0) minIdx = j;
        }
        if (minIdx !== i) [a[i], a[minIdx]] = [a[minIdx], a[i]];
      }
    });
  }

  /**
   * Merge sort
   *
   * Why: Divide and conquer; merge two sorted halves. Stable and predictable O(n log n).
   * When: When you need stable sort or guaranteed n log n (e.g. avoid quicksort worst case).
   * Complexity: O(n log n) time, O(n) extra space — ONE buffer allocated up
   * front and reused by every merge (the naive version allocates two fresh
   * slices per merge, ~n·log n total allocation churn). Already-ordered
   * halves are detected (a[mid] <= a[mid+1]) and skipped, making sorted and
   * nearly sorted input close to O(n). Small ranges use insertion sort.
   * Stability is preserved: ties always take from the left half first.
   */
  static mergeSort(arr: number[]): number[];
  static mergeSort<T>(arr: T[], compare: CompareFn<T>): T[];
  static mergeSort<T>(arr: T[], compare?: CompareFn<T>): T[] {
    const cmp = defaultCompareOr(compare);
    const out = arr.slice();
    if (out.length < 2) return out;
    const aux: T[] = new Array<T>(out.length);
    const merge = (a: T[], lo: number, mid: number, hi: number): void => {
      // Copy only the left half into the buffer; merge right half in place.
      for (let i = lo; i <= mid; i++) aux[i] = a[i];
      let i = lo,
        j = mid + 1,
        k = lo;
      while (i <= mid && j <= hi) {
        // <= keeps the sort stable: on ties the left-half element wins.
        if (cmp(aux[i], a[j]) <= 0) a[k++] = aux[i++];
        else a[k++] = a[j++];
      }
      while (i <= mid) a[k++] = aux[i++];
      // Right-half leftovers are already in place.
    };
    const rec = (a: T[], lo: number, hi: number): void => {
      if (hi - lo < SMALL_RANGE_CUTOFF) {
        insertionSortRange(a, lo, hi, cmp);
        return;
      }
      const mid = lo + ((hi - lo) >> 1);
      rec(a, lo, mid);
      rec(a, mid + 1, hi);
      // Halves already in order? The whole range is sorted — skip the merge.
      if (cmp(a[mid], a[mid + 1]) <= 0) return;
      merge(a, lo, mid, hi);
    };
    rec(out, 0, out.length - 1);
    return out;
  }

  /**
   * Quick sort — implemented as introsort (Musser 1997), the same scheme
   * behind GNU libstdc++'s std::sort and .NET's Array.Sort.
   *
   * Why: Plain quicksort with a fixed last-element pivot degrades to O(n²)
   * time AND O(n) recursion depth on sorted, reverse-sorted, and all-equal
   * input — exactly the shapes real data takes — which means it doesn't just
   * get slow, it throws RangeError (stack overflow) on arrays as small as
   * ~10k elements. This version keeps quicksort's fast average case and
   * removes the failure modes:
   *   - median-of-three pivot (first/middle/last) defeats sorted/reversed input
   *   - 3-way partition (Dutch national flag) makes all-equal runs O(n)
   *     instead of O(n²) — Lomuto shoves equal keys onto one side every pass
   *   - insertion sort below SMALL_RANGE_CUTOFF elements
   *   - already-sorted input is detected in one pass and returned directly
   *   - depth limit of 2·floor(log2 n): if partitioning goes pathological
   *     anyway, the range falls back to in-place heapsort
   * When: General-purpose in-memory sort when you don't need stability.
   * Complexity: O(n log n) worst case, O(n) on sorted or all-equal input;
   * O(log n) stack.
   */
  static quickSort(arr: number[]): number[];
  static quickSort<T>(arr: T[], compare: CompareFn<T>): T[];
  static quickSort<T>(arr: T[], compare?: CompareFn<T>): T[] {
    const cmp = defaultCompareOr(compare);
    const out = arr.slice();
    if (out.length < 2) return out;
    // Pattern-defeating touch (pdqsort): already-sorted input is common in
    // practice; detect it in one O(n) pass and skip partitioning entirely.
    if (SortingAlgorithms.isSorted(out, cmp)) return out;
    const rec = (a: T[], lo: number, hi: number, depthLeft: number): void => {
      while (hi - lo >= SMALL_RANGE_CUTOFF) {
        if (depthLeft === 0) {
          // Partitioning degenerated (adversarial input): guaranteed n log n.
          heapSortRange(a, lo, hi, cmp);
          return;
        }
        depthLeft--;
        const pivot = medianOfThree(a, lo, hi, cmp);
        // 3-way partition: a[lo..lt-1] < pivot, a[lt..gt] == pivot, a[gt+1..hi] > pivot.
        // Plain temp-variable swaps: destructuring swaps allocate a temp array
        // per swap in generic (comparator-driven) code and measurably slow the
        // hot loop.
        let lt = lo,
          i = lo,
          gt = hi;
        while (i <= gt) {
          const v = a[i];
          const c = cmp(v, pivot);
          if (c < 0) {
            if (lt !== i) {
              a[i] = a[lt];
              a[lt] = v;
            }
            lt++;
            i++;
          } else if (c > 0) {
            a[i] = a[gt];
            a[gt] = v;
            gt--;
          } else {
            i++;
          }
        }
        // Recurse into the smaller side, loop on the larger: stack stays O(log n).
        if (lt - lo < hi - gt) {
          rec(a, lo, lt - 1, depthLeft);
          lo = gt + 1;
        } else {
          rec(a, gt + 1, hi, depthLeft);
          hi = lt - 1;
        }
      }
      insertionSortRange(a, lo, hi, cmp);
    };
    const depthLimit = 2 * Math.floor(Math.log2(out.length));
    rec(out, 0, out.length - 1, depthLimit);
    return out;
  }

  /**
   * Heap sort
   *
   * Why: Build max-heap, repeatedly extract max to end of array. In-place, no worst-case quicksort.
   * When: When you need O(n log n) guaranteed and in-place (e.g. limited memory).
   * Complexity: O(n log n) time, O(1) extra space.
   */
  static heapSort(arr: number[]): number[];
  static heapSort<T>(arr: T[], compare: CompareFn<T>): T[];
  static heapSort<T>(arr: T[], compare?: CompareFn<T>): T[] {
    const compareFn = defaultCompareOr(compare);
    const out = arr.slice();
    const cmp = (a: T[], i: number, j: number): number => compareFn(a[i], a[j]);
    const swap = (a: T[], i: number, j: number): void => {
      [a[i], a[j]] = [a[j], a[i]];
    };
    const heapifyDown = (a: T[], n: number, i: number): void => {
      let largest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && cmp(a, left, largest) > 0) largest = left;
      if (right < n && cmp(a, right, largest) > 0) largest = right;
      if (largest !== i) {
        swap(a, i, largest);
        heapifyDown(a, n, largest);
      }
    };
    const n = out.length;
    for (let i = Math.floor(n / 2) - 1; i >= 0; i--) heapifyDown(out, n, i);
    for (let size = n - 1; size > 0; size--) {
      swap(out, 0, size);
      heapifyDown(out, size, 0);
    }
    return out;
  }

  /**
   * Returns true if the array is sorted according to compare.
   */
  static isSorted(arr: number[]): boolean;
  static isSorted<T>(arr: T[], compare: CompareFn<T>): boolean;
  static isSorted<T>(arr: T[], compare?: CompareFn<T>): boolean {
    const cmp = defaultCompareOr(compare);
    for (let i = 1; i < arr.length; i++) {
      if (cmp(arr[i - 1], arr[i]) > 0) return false;
    }
    return true;
  }
}
