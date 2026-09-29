// IME composition guard for Enter-to-send/confirm key handlers.
//
// While composing (e.g. Chinese pinyin), Enter confirms the pending text and
// must not trigger send/select. Chrome/Firefox deliver that keydown with
// isComposing=true (keyCode 229). Safari instead fires compositionend *before*
// the keydown, with isComposing already false — so an Enter arriving within a
// few ms of compositionend is treated as the composition-confirming key.
const SAFARI_COMPOSITION_END_WINDOW_MS = 50;

export interface ImeKeyEventLike {
  key: string;
  timeStamp: number;
  nativeEvent: { isComposing: boolean };
}

export function isImeKeyEvent(
  e: ImeKeyEventLike,
  composing: boolean,
  compositionEndTs: number,
): boolean {
  return (
    composing ||
    e.nativeEvent.isComposing ||
    (e.key === "Enter" && e.timeStamp - compositionEndTs < SAFARI_COMPOSITION_END_WINDOW_MS)
  );
}
