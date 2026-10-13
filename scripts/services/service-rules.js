/**
 * Checks shared by every service venue (clinics, tech shops): Cyberpunk RED's
 * STAT + Skill + 1d10 against a DV. Pure apart from rolling dice.
 */

/**
 * Chance that base + 1d10 beats the DV, with CPR criticals: a 10 adds a second d10,
 * a 1 subtracts one (CRB p.130). Ties fail (p.129).
 */
export function chance(base, dv) {
  let wins = 0;
  for (let first = 1; first <= 10; first++) {
    if (first === 1 || first === 10) {
      for (let second = 1; second <= 10; second++) {
        const total = base + first + (first === 10 ? second : -second);
        if (total > dv) wins += 1;
      }
    } else if (base + first > dv) {
      wins += 10;
    }
  }
  return wins / 100;
}

/** Roll base + 1d10 against a DV, CPR style. Returns the rolls too, so the chat card can carry them. */
export async function rollCheck(base, dv) {
  const first = await new Roll("1d10").evaluate();
  const rolls = [first];
  let crit = 0;
  if (first.total === 10 || first.total === 1) {
    const second = await new Roll("1d10").evaluate();
    rolls.push(second);
    crit = first.total === 10 ? second.total : -second.total;
  }
  const total = base + first.total + crit;
  return { base, dv, die: first.total, crit, total, success: total > dv, rolls };
}

/**
 * The best way to do a job: each candidate is { skill, dv, bonus? }; the one with the best odds wins.
 * Skills the staff lack (base 0) are skipped. `bases` maps skill keys to STAT + Skill.
 */
export function bestPlan(bases, candidates) {
  const usable = candidates
    .filter((c) => c.dv > 0 && (Number(bases[c.skill]) || 0) > 0)
    .map((c) => {
      const base = (Number(bases[c.skill]) || 0) + (Number(c.bonus) || 0);
      return { ...c, base, chance: chance(base, c.dv) };
    });
  usable.sort((a, b) => b.chance - a.chance || a.dv - b.dv);
  return usable[0] ?? null;
}
