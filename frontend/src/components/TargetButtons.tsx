import { TEST_TARGETS, type TestTarget } from "../types";
import { api } from "../lib/api";

interface Props {
  onSelect: (t: TestTarget & { ra: number; dec: number }) => void;
}

export function TargetButtons({ onSelect }: Props) {
  const pick = async (t: TestTarget) => {
    if (t.ra != null && t.dec != null) {
      onSelect({ ...t, ra: t.ra, dec: t.dec });
      return;
    }
    const r = await api.resolve(t.name);
    onSelect({ ...t, ra: r.ra, dec: r.dec });
  };

  return (
    <div className="targets" role="group" aria-label="Official test targets">
      {TEST_TARGETS.map((t) => (
        <button
          key={t.id}
          type="button"
          data-testid={`target-${t.id}`}
          data-target-id={t.id}
          onClick={() => void pick(t)}
        >
          {t.name}
        </button>
      ))}
    </div>
  );
}
