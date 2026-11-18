export function EmptyPlan({ inCall }: { inCall: boolean }) {
  return (
    <div className="empty">
      <div className="empty-ghost" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <h1>{inCall ? "Tell it where you're going." : "Where are you going?"}</h1>
      <p>
        {inCall
          ? "Say how many days, and what kind of trip. The plan fills in here."
          : "Press Call and talk through your trip. Every change you ask for happens right here."}
      </p>
    </div>
  );
}
