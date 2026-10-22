import { useEffect, useState } from 'react';

/**
 * A countdown that does not trust the counter's wall clock.
 *
 * The server says "N seconds left" in each response. We turn that into a deadline on
 * performance.now(), a monotonic timer that only measures elapsed time since the page loaded:
 * it does not care what time the device thinks it is, and it does not jump if the clock is
 * changed. Every poll replaces the deadline with a fresh server value, so any drift is corrected.
 * Date.now() is never used.
 */
export function deadlineFrom(serverSecondsLeft: number): number {
  return performance.now() + serverSecondsLeft * 1000;
}

export function useSecondsLeft(deadline: number | null): number {
  const [left, setLeft] = useState(() => compute(deadline));
  useEffect(() => {
    setLeft(compute(deadline));
    if (deadline === null) return;
    const t = setInterval(() => setLeft(compute(deadline)), 250);
    return () => clearInterval(t);
  }, [deadline]);
  return left;
}

function compute(deadline: number | null): number {
  if (deadline === null) return 0;
  return Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
}
