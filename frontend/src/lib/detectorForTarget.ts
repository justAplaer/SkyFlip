/** Match backend DEFAULT_DETECTOR_BY_TARGET — never leave a sticky D5 on a D1 star. */
export function detectorForTarget(targetId: string | undefined | null): number {
  if (targetId === "wise0855" || targetId === "epsilon_indi_b") return 5;
  return 1;
}
