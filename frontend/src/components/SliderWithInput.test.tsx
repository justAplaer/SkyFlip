import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SliderWithInput, snapToRange } from "./SliderWithInput";
import type { SliderWithInputProps } from "./SliderWithInput";

afterEach(cleanup);

type HarnessProps = Partial<Omit<SliderWithInputProps, "value" | "onChange">> & {
  initial?: number;
  spy?: (v: number) => void;
};

function Harness({ initial = 1.5, spy, ...rest }: HarnessProps) {
  const [v, setV] = useState(initial);
  return (
    <SliderWithInput
      label="Blink speed"
      min={0.5}
      max={3}
      step={0.1}
      unit="Hz"
      {...rest}
      value={v}
      onChange={(n) => {
        spy?.(n);
        setV(n);
      }}
    />
  );
}

const numInput = () => screen.getByLabelText("Blink speed value") as HTMLInputElement;
const slider = () => screen.getByRole("slider") as HTMLInputElement;

function typeAndCommit(text: string, how: "enter" | "blur" = "enter") {
  const input = numInput();
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
  if (how === "enter") fireEvent.keyDown(input, { key: "Enter" });
  else fireEvent.blur(input);
}

describe("snapToRange", () => {
  it("clamps and snaps without float drift", () => {
    expect(snapToRange(0.1 + 0.2, 0, 3, 0.1, 1)).toBe(0.3);
    expect(snapToRange(99, 0.5, 3, 0.1, 1)).toBe(3);
    expect(snapToRange(-4, 0.5, 3, 0.1, 1)).toBe(0.5);
  });

  it("never exceeds upper when it is off the step grid", () => {
    expect(snapToRange(10, 0, 10, 3, 0)).toBe(9);
  });
});

describe("SliderWithInput", () => {
  it("wires label, range ARIA attributes, and unit", () => {
    render(<Harness id="hz" />);
    const s = screen.getByLabelText("Blink speed", { selector: "input[type=range]" });
    expect(s).toBe(slider());
    expect(s).toHaveAttribute("id", "hz");
    expect(s).toHaveAttribute("aria-valuemin", "0.5");
    expect(s).toHaveAttribute("aria-valuemax", "3");
    expect(s).toHaveAttribute("aria-valuenow", "1.5");
    expect(screen.getByText("Hz")).toBeInTheDocument();
  });

  it("syncs slider -> input", () => {
    render(<Harness />);
    fireEvent.change(slider(), { target: { value: "2.2" } });
    expect(numInput().value).toBe("2.2");
  });

  it("syncs input -> slider", () => {
    render(<Harness />);
    typeAndCommit("2.4");
    expect(slider().value).toBe("2.4");
    expect(slider()).toHaveAttribute("aria-valuenow", "2.4");
  });

  it("clamps above max on Enter and shows clampNote", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} clampNote="Capped at 3 Hz" />);
    expect(screen.queryByText("Capped at 3 Hz")).not.toBeInTheDocument();
    typeAndCommit("7");
    expect(spy).toHaveBeenLastCalledWith(3);
    expect(numInput().value).toBe("3.0");
    expect(screen.getByText("Capped at 3 Hz")).toBeInTheDocument();
    // note survives the follow-up blur, and clears on next slider change
    fireEvent.blur(numInput());
    expect(screen.getByText("Capped at 3 Hz")).toBeInTheDocument();
    fireEvent.change(slider(), { target: { value: "2" } });
    expect(screen.queryByText("Capped at 3 Hz")).not.toBeInTheDocument();
  });

  it("clamps below min on blur", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    typeAndCommit("-5", "blur");
    expect(spy).toHaveBeenLastCalledWith(0.5);
    expect(numInput().value).toBe("0.5");
  });

  it("does not show clampNote for in-range values", () => {
    render(<Harness clampNote="Capped" />);
    typeAndCommit("2");
    expect(screen.queryByText("Capped")).not.toBeInTheDocument();
  });

  it("rounds to step", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    typeAndCommit("1.74");
    expect(spy).toHaveBeenLastCalledWith(1.7);
    expect(numInput().value).toBe("1.7");
    typeAndCommit("2.26", "blur");
    expect(spy).toHaveBeenLastCalledWith(2.3);
  });

  it("restores last good value on NaN with brief invalid outline", () => {
    vi.useFakeTimers();
    try {
      const spy = vi.fn();
      render(<Harness spy={spy} initial={2} />);
      typeAndCommit("abc");
      expect(spy).not.toHaveBeenCalled();
      expect(numInput().value).toBe("2.0");
      expect(numInput()).toHaveClass("invalid");
      expect(numInput()).toHaveAttribute("aria-invalid", "true");
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(numInput()).not.toHaveClass("invalid");
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats empty input as invalid and restores", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={2} />);
    typeAndCommit("  ", "blur");
    expect(spy).not.toHaveBeenCalled();
    expect(numInput().value).toBe("2.0");
  });

  it("ArrowUp/Down step by ±step, Shift by ±10*step", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={1.5} />);
    fireEvent.keyDown(numInput(), { key: "ArrowUp" });
    expect(spy).toHaveBeenLastCalledWith(1.6);
    fireEvent.keyDown(numInput(), { key: "ArrowDown" });
    expect(spy).toHaveBeenLastCalledWith(1.5);
    fireEvent.keyDown(numInput(), { key: "ArrowUp", shiftKey: true });
    expect(spy).toHaveBeenLastCalledWith(2.5);
    fireEvent.keyDown(numInput(), { key: "ArrowDown", shiftKey: true });
    expect(spy).toHaveBeenLastCalledWith(1.5);
    fireEvent.keyDown(numInput(), { key: "ArrowUp", shiftKey: true });
    fireEvent.keyDown(numInput(), { key: "ArrowUp", shiftKey: true });
    expect(numInput().value).toBe("3.0"); // clamped at max
  });

  it("allowBeyondMax lets the input exceed max up to hardMax; slider pins at max", () => {
    const spy = vi.fn();
    render(
      <Harness
        spy={spy}
        label="Zoom"
        min={1}
        max={16}
        step={0.1}
        initial={2}
        allowBeyondMax
        hardMax={64}
      />,
    );
    const input = screen.getByLabelText("Zoom value") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "40" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(spy).toHaveBeenLastCalledWith(40);
    expect(screen.getByRole("slider")).toHaveValue("16");
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuemax", "16");
    fireEvent.change(input, { target: { value: "500" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(spy).toHaveBeenLastCalledWith(64);
  });
});
