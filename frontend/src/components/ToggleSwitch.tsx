interface Props {
  checked: boolean;
  onChange: (v: boolean) => void;
  labelOn: string;
  labelOff: string;
  id?: string;
  disabled?: boolean;
}

/** Accessible iOS-style switch — not color-only; Space/Enter; role=switch. */
export function ToggleSwitch({
  checked,
  onChange,
  labelOn,
  labelOff,
  id,
  disabled,
}: Props) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={checked ? labelOn : labelOff}
      disabled={disabled}
      className={`toggle-switch ${checked ? "on" : "off"}`}
      onClick={() => onChange(!checked)}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onChange(!checked);
        }
      }}
    >
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-text">{checked ? "ON · default" : "OFF · custom"}</span>
    </button>
  );
}
