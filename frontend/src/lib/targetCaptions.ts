/** Plain-language captions for the five demo targets — facts only from app catalogs. */

export const TARGET_CAPTIONS: Record<
  string,
  { text: string; cite: string }
> = {
  wise0855: {
    text: "WISE 0855 is a cold Y dwarf with large proper motion (~8″/yr). Watch the circled position shift between visits.",
    cite: "Luhman 2014, ApJ 786 L18 Table 1 (PM in demo pm_table.json)",
  },
  barnards_star: {
    text: "Barnard's Star is a nearby high-PM star. The yellow ring follows its Gaia-based motion to each SPHEREx visit.",
    cite: "Gaia DR3 source 4472832130942575872 (demo pm_table.json)",
  },
  epsilon_indi_b: {
    text: "Epsilon Indi B is a brown-dwarf companion; the demo uses the ε Indi system proper motion when object-specific PM is unavailable.",
    cite: "SIMBAD / Gaia DR3 family PM (demo pm_table.json)",
  },
  rw_aurigae: {
    text: "RW Aurigae is a variable young star used as a control — little/no proper motion, so it should stay put while the blink runs.",
    cite: "Demo classification: variable control (pm_table.json)",
  },
  r_draconis: {
    text: "R Draconis is a variable star control with no proper motion on record — useful to contrast with true movers.",
    cite: "Demo classification: variable control (pm_table.json)",
  },
};

export function captionForTarget(targetId: string | undefined): {
  text: string;
  cite: string;
} | null {
  if (!targetId) return null;
  return TARGET_CAPTIONS[targetId] ?? null;
}
