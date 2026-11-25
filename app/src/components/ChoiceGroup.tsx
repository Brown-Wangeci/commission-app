"use client";

export type Choice = { value: string; label: string };
export type ChoiceLayout = "segmented" | "cards";

/** Longest label that still fits one segment of a 360 px phone. */
const SEGMENT_LABEL_MAX = 18;

/** Short choices sit side by side as segments; longer ones stack as full-width cards. */
export function choiceLayout(options: ReadonlyArray<Choice>): ChoiceLayout {
  return options.length <= 3 && options.every((option) => option.label.length <= SEGMENT_LABEL_MAX) ? "segmented" : "cards";
}

type Props = {
  name: string;
  options: ReadonlyArray<Choice>;
  /** The id of the element that names the group. */
  labelledBy: string;
  layout?: ChoiceLayout;
  /** Controlled: the chosen value and what to do on a change. */
  value?: string;
  onChange?: (value: string) => void;
  /** Uncontrolled: the value chosen at first. */
  defaultValue?: string;
};

/**
 * A choice among a few options, drawn as a segmented control or as option
 * cards. Underneath it is a group of native radio buttons with the same name
 * and values as before, so the form sends exactly what it sent, and the
 * keyboard, screen readers and form reset work as they do for any radio
 * group. Each whole segment or card is the target.
 */
export function ChoiceGroup({ name, options, labelledBy, layout, value, onChange, defaultValue }: Props) {
  const kind = layout ?? choiceLayout(options);
  const controlled = onChange !== undefined;
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className={`choice-group ${kind}`}>
      {options.map((option) => (
        <label key={option.value} className="choice">
          {controlled ? (
            <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
          ) : (
            <input type="radio" name={name} value={option.value} defaultChecked={defaultValue === option.value} />
          )}
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}
