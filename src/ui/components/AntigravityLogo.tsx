import antigravityLogoUrl from '../assets/antigravity-color.svg';

// Google's full-colour Antigravity icon, as published: shown as it is on
// light and dark surfaces alike, never tinted or flipped.
export function AntigravityLogo({ className = 'h-4 w-4' }: { className?: string }) {
  return <img src={antigravityLogoUrl} alt="" className={`${className} flex-shrink-0`} aria-hidden="true" />;
}
