export function Sprite({
  companion = "capybara",
  small = false,
}: {
  companion?: "capybara" | "kite";
  small?: boolean;
}) {
  return (
    <div
      className={`sprite sprite-${companion}${small ? " small" : ""}`}
      aria-hidden="true"
    >
      {companion === "capybara" ? (
        <img src="./capybara.png" alt="" draggable={false} />
      ) : (
        <>
          <div className="sprite-shape">
            <span className="eye left" />
            <span className="eye right" />
            <span className="mouth" />
          </div>
          <svg viewBox="0 0 80 80">
            <path d="M42 0C10 24 67 22 35 43S32 64 15 74" />
          </svg>
        </>
      )}
    </div>
  );
}
