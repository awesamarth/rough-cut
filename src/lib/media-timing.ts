/** Trim/rebase subtraction can leave a femtosecond below zero; muxers reject it. */
export function normalizePcmTimestamp(sample: { timestamp: number; setTimestamp(value: number): void }) {
  // Only numerical noise, not genuine negative media timing (or invalid input).
  if (sample.timestamp < 0 && sample.timestamp >= -1e-9) sample.setTimestamp(0);
}
