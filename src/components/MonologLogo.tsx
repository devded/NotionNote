export function MonologLogo({ className = "size-5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 512 512"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <pattern id="m-grid" width="32" height="32" patternUnits="userSpaceOnUse">
          <path d="M 32 0 L 0 0 0 32" fill="none" stroke="currentColor" strokeWidth="1" strokeOpacity="0.15" />
        </pattern>
      </defs>

      {/* Container */}
      <rect x="16" y="16" width="480" height="480" rx="104" ry="104" className="fill-card stroke-border" strokeWidth="12" />
      <rect x="20" y="20" width="472" height="472" rx="100" ry="100" fill="url(#m-grid)" />

      {/* Inner Paper Elevation */}
      <rect x="80" y="80" width="352" height="352" rx="40" ry="40" className="fill-background stroke-border/60" strokeWidth="6" />

      {/* Left Column */}
      <path d="M 148 152 L 196 152 L 196 360 L 148 360 Z" className="fill-foreground" />

      {/* Left Diagonal */}
      <path d="M 196 152 L 256 264 L 256 360 L 196 248 Z" className="fill-foreground opacity-90" />

      {/* Right Diagonal */}
      <path d="M 256 264 L 316 152 L 316 248 L 256 360 Z" className="fill-foreground" />

      {/* Right Column */}
      <path d="M 316 200 L 364 200 L 364 360 L 316 360 Z" className="fill-foreground" />

      {/* Folded Corner (Primary Accent) */}
      <path d="M 316 152 L 364 200 L 316 200 Z" className="fill-primary" />
      <path d="M 316 152 L 364 200" className="stroke-primary-foreground/40" strokeWidth="4" strokeLinecap="round" />

      {/* Dot Accent */}
      <circle cx="256" cy="180" r="11" className="fill-primary" />
    </svg>
  );
}
