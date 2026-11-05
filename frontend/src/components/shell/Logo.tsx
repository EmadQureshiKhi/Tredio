/** The Tredio wordmark and mark, drawn in the current text color so they follow the theme. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 31" className={className} role="img" aria-label="Tredio">
      <text x="1" y="30" fill="currentColor" className="font-strong" fontSize="40" textLength="118" lengthAdjust="spacing">
        Tredio
      </text>
    </svg>
  );
}

export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="Tredio">
      <text x="16" y="25" fill="currentColor" className="font-strong" fontSize="26" textAnchor="middle">
        T
      </text>
    </svg>
  );
}
