/** Black single-colour brand mark; `.provider-monochrome-logo` flips it in dark mode. */
export function MonochromeLogo({ src, className = 'h-4 w-4' }: { src: string; className?: string }) {
  return <img src={src} alt="" className={`${className} flex-shrink-0 provider-monochrome-logo`} aria-hidden="true" />;
}
