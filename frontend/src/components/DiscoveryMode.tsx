import { useMemo, useState } from "react";
import { TEST_TARGETS } from "../types";
import { api } from "../lib/api";

type Vote = "moved" | "didnt" | "unsure";

interface Card {
  id: string;
  title: string;
  truth?: Vote;
  blurb: string;
}

const TUTORIAL: Card[] = [
  {
    id: "tut_wise",
    title: "WISE 0855",
    truth: "moved",
    blurb: "Fast-moving brown dwarf — expect a hop between epochs.",
  },
  {
    id: "tut_rw",
    title: "RW Aurigae",
    truth: "didnt",
    blurb: "Variable star — brightness may change, position should not (much).",
  },
  {
    id: "tut_noise",
    title: "Sparse field",
    truth: "unsure",
    blurb: "Hard call on purpose — unsure is a valid vote.",
  },
];

function loadVotes(): Record<string, Vote> {
  try {
    return JSON.parse(localStorage.getItem("skyflip_votes") || "{}");
  } catch {
    return {};
  }
}

function saveVotes(v: Record<string, Vote>) {
  localStorage.setItem("skyflip_votes", JSON.stringify(v));
}

export function DiscoveryMode() {
  const cards = useMemo<Card[]>(
    () => [
      ...TUTORIAL,
      ...TEST_TARGETS.map((t) => ({
        id: `field_${t.id}`,
        title: t.name,
        blurb: "Swipe or key your vote. Agreement % is not a discovery claim.",
      })),
    ],
    []
  );
  const [i, setI] = useState(0);
  const [votes, setVotes] = useState(loadVotes);
  const [score, setScore] = useState({ right: 0, total: 0 });

  const card = cards[i];

  const vote = async (v: Vote) => {
    const next = { ...votes, [card.id]: v };
    setVotes(next);
    saveVotes(next);
    if (card.truth) {
      setScore((s) => ({
        right: s.right + (v === card.truth ? 1 : 0),
        total: s.total + 1,
      }));
    }
    try {
      await api.postVote(card.id, v);
    } catch {
      /* local-only OK */
    }
    setI((x) => (x + 1) % cards.length);
  };

  const nLocal = Object.keys(votes).length;

  return (
    <section className="panel discovery" aria-label="Discovery mode">
      <h2>Discovery Mode</h2>
      <p className="hint">
        Mobile-friendly cards. Votes stored in localStorage; optional backend tally. Confidence = agreement
        among votes, never a claim of discovery.
      </p>
      <div
        className="card"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "1") void vote("moved");
          if (e.key === "2") void vote("didnt");
          if (e.key === "3") void vote("unsure");
        }}
      >
        <h3>{card.title}</h3>
        <p>{card.blurb}</p>
        <div className="row">
          <button type="button" onClick={() => void vote("moved")}>
            Moved (1)
          </button>
          <button type="button" onClick={() => void vote("didnt")}>
            Didn’t (2)
          </button>
          <button type="button" onClick={() => void vote("unsure")}>
            Not sure (3)
          </button>
        </div>
      </div>
      <p>
        Tutorial score: {score.right}/{score.total} · Local votes: {nLocal}
      </p>
    </section>
  );
}
