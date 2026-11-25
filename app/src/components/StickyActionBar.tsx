import type { ReactNode } from "react";

type Props = {
  /** The screen's action buttons: one primary, at most. */
  children: ReactNode;
  /** One short line beside the buttons, such as what is still being prepared. */
  note?: ReactNode;
};

/**
 * The row that holds a form's main action. On a phone (640 px and below) it
 * stays stuck to the bottom of the screen while the form scrolls, so the
 * action is always one tap away; on a wider screen it is an ordinary row at
 * the end of the form.
 */
export function StickyActionBar({ children, note }: Props) {
  return (
    <div className="action-bar">
      {note && <div className="action-bar-note">{note}</div>}
      {children}
    </div>
  );
}
