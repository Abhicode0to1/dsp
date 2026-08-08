// Real brand assets (public/anutech-logo-*.png), replacing the earlier
// hand-drawn cloud SVG placeholder. Two variants:
//   <CloudOnly />  — just the arrow mark (favicon / collapsed sidebar)
//   <LogoFull />   — arrow mark + "ANUTECH DIGITAL PVT LTD" wordmark (sidebar
//                    expanded header, login, setup-password)
// Both images have transparent backgrounds. `className` controls sizing —
// pass a height utility (e.g. h-9) same as before; width is automatic.

export function CloudOnly({ className = '', ...rest }) {
  return <img src="/anutech-logo-mark.png" alt="Anutech" className={className} {...rest} />;
}

export function LogoFull({ className = '', ...rest }) {
  return <img src="/anutech-logo-full.png" alt="Anutech Digital" className={className} {...rest} />;
}
