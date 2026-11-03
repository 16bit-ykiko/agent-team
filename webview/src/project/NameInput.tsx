import { useRef } from "react";
import { isImeKeyEvent } from "../chat/ime";

// A name edited in place: Enter or leaving the field ends with the new name
// (null when it is blank or unchanged), Escape with null.
export function NameInput({
  name,
  label,
  className,
  onDone,
}: {
  name: string;
  label: string;
  className: string;
  onDone: (name: string | null) => void;
}) {
  const composing = useRef(false);
  const compositionEnd = useRef(0);
  // Ending unmounts the field, which can blur it once more.
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    const trimmed = value?.trim();
    onDone(trimmed && trimmed !== name ? trimmed : null);
  };
  return (
    <input
      className={className}
      aria-label={label}
      autoFocus
      defaultValue={name}
      onClick={(e) => e.stopPropagation()}
      onCompositionStart={() => (composing.current = true)}
      onCompositionEnd={(e) => {
        composing.current = false;
        compositionEnd.current = e.timeStamp;
      }}
      onKeyDown={(e) => {
        if (isImeKeyEvent(e, composing.current, compositionEnd.current)) return;
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") {
          e.stopPropagation();
          e.nativeEvent.preventDefault();
          finish(null);
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}
