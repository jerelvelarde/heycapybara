import { useRef, useState, type ReactNode } from "react";
import { Circle, MessageCircle, Square } from "lucide-react";
import { crossedDragThreshold, type Point } from "./buddy-drag";
export function Buddy({
  active,
  error,
  setError,
  children,
}: {
  active: boolean;
  error: string;
  setError: (error: string) => void;
  children: ReactNode;
}) {
  const gesture = useRef<{
    pointerId: number;
    start: Point;
    current: Point;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  function invoke(action: "begin" | "move" | "end", point: Point) {
    void window
      .kite!.buddyDrag(action, point)
      .catch((error: unknown) =>
        setError(
          error instanceof Error ? error.message : "Could not move companion",
        ),
      );
  }
  function endGesture() {
    if (!gesture.current) return;
    suppressClick.current = gesture.current.moved;
    invoke("end", gesture.current.current);
    gesture.current = null;
    setDragging(false);
  }
  function toggleChat() {
    void window
      .kite!.toggleCompanionChat()
      .catch((error: unknown) =>
        setError(
          error instanceof Error ? error.message : "Could not open chat",
        ),
      );
  }
  function openMode(mode: "chat" | "record") {
    void window
      .kite!.openCompanionTray(mode)
      .catch((error: unknown) =>
        setError(
          error instanceof Error ? error.message : "Could not open controls",
        ),
      );
  }
  return (
    <div className={"buddy" + (active ? " recording" : "")}>
      <button
        className={"buddy-sprite" + (dragging ? " dragging" : "")}
        title="Click to chat · drag to move"
        aria-label="Chat with OpenMuse or drag to move companion"
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          // Recover if macOS interrupted the previous gesture before release.
          endGesture();
          suppressClick.current = false;
          gesture.current = {
            pointerId: event.pointerId,
            start: { x: event.screenX, y: event.screenY },
            current: { x: event.screenX, y: event.screenY },
            moved: false,
          };
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch (error) {
            gesture.current = null;
            setError(
              error instanceof Error
                ? error.message
                : "Could not capture companion drag",
            );
            return;
          }
          invoke("begin", gesture.current.start);
        }}
        onPointerMove={(event) => {
          const current = gesture.current;
          if (!current || current.pointerId !== event.pointerId) return;
          current.current = { x: event.screenX, y: event.screenY };
          if (
            crossedDragThreshold(current.start, {
              x: event.screenX,
              y: event.screenY,
            })
          )
            current.moved = true;
          if (current.moved) {
            setDragging(true);
            invoke("move", current.current);
          }
        }}
        onPointerUp={(event) => {
          const current = gesture.current;
          if (!current || current.pointerId !== event.pointerId) return;
          current.current = { x: event.screenX, y: event.screenY };
          current.moved ||= crossedDragThreshold(
            current.start,
            current.current,
          );
          endGesture();
        }}
        onPointerCancel={endGesture}
        onLostPointerCapture={endGesture}
        onClick={(event) => {
          if (event.detail !== 0 && suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          toggleChat();
        }}
      >
        {children}
      </button>
      <div className="buddy-actions" aria-label="Companion actions">
        <button
          title="Chat with OpenMuse"
          aria-label="Chat with OpenMuse"
          onClick={() => openMode("chat")}
        >
          <MessageCircle size={18} />
        </button>
        <span className="buddy-actions-divider" />
        {active ? (
          <button
            title="Stop recording"
            aria-label="Stop recording"
            onClick={() =>
              void window
                .kite!.stop()
                .catch((error: Error) => setError(error.message))
            }
          >
            <Square size={16} />
          </button>
        ) : (
          <button
            title="Record a workflow"
            aria-label="Record a workflow"
            onClick={() => openMode("record")}
          >
            <Circle size={17} />
          </button>
        )}
      </div>
      {active && (
        <span
          className="buddy-recording-indicator"
          title="Recording in progress"
        />
      )}
      {error && <span className="buddy-error">{error}</span>}
    </div>
  );
}
