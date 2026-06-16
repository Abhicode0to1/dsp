// Inline SVG logo components so text color follows `currentColor` (Tailwind
// `text-white`, `text-gray-900`, etc). Three variants matching the brand pack:
//   <CloudOnly />  — just the blue cloud (favicon / collapsed sidebar)
//   <LogoMark />   — cloud + vertical separator bar (sidebar header at narrow widths)
//   <LogoFull />   — cloud + bar + "ANUTECH / DIGITAL" text (login, setup-password)
// The cloud is always brand blue (#0DA1FF); the bar + text use `currentColor`
// so a single component renders correctly on light and dark backgrounds.

export function CloudOnly({ className = '', ...rest }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 64" className={className} aria-hidden="true" {...rest}>
      <path fill="#0DA1FF" d="M76 60H22A18 18 0 0 1 22 24l1 0A20 20 0 0 1 62 22a14 14 0 0 1 14 14 13 13 0 0 1 0 24Z" />
    </svg>
  );
}

export function LogoMark({ className = '', ...rest }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 64" className={className} aria-label="Anutech Digital" {...rest}>
      <path fill="#0DA1FF" d="M76 60H22A18 18 0 0 1 22 24l1 0A20 20 0 0 1 62 22a14 14 0 0 1 14 14 13 13 0 0 1 0 24Z" />
      <rect x="100" y="10" width="5" height="44" rx="1" fill="currentColor" />
    </svg>
  );
}

export function LogoFull({ className = '', ...rest }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 110" className={className} aria-label="Anutech Digital" {...rest}>
      <path fill="#0DA1FF" d="M86 92H22A22 22 0 0 1 22 48l1 0A24 24 0 0 1 70 46a18 18 0 0 1 18 18 16 16 0 0 1-2 28Z" />
      <rect x="120" y="22" width="6" height="64" rx="1" fill="currentColor" />
      <text x="146" y="55" fontFamily="Arial Black, Arial, sans-serif" fontWeight="900" fontSize="32" letterSpacing="2" fill="currentColor">ANUTECH</text>
      <text x="146" y="92" fontFamily="Arial Black, Arial, sans-serif" fontWeight="900" fontSize="32" letterSpacing="6" fill="currentColor">DIGITAL</text>
    </svg>
  );
}
