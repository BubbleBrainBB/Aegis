import type { CSSProperties } from 'react';
import antigravityLogoUrl from '../assets/antigravity.svg';

// A single-colour arch; masking it paints it in currentColor so it reads on
// light and dark surfaces alike.
const maskStyle: CSSProperties = {
  WebkitMaskImage: `url("${antigravityLogoUrl}")`,
  maskImage: `url("${antigravityLogoUrl}")`,
  WebkitMaskSize: 'contain',
  maskSize: 'contain',
  WebkitMaskRepeat: 'no-repeat',
  maskRepeat: 'no-repeat',
  WebkitMaskPosition: 'center',
  maskPosition: 'center',
};

export function AntigravityLogo({ className = 'h-4 w-4' }: { className?: string }) {
  return <span className={`${className} inline-block flex-shrink-0 bg-current`} style={maskStyle} aria-hidden="true" />;
}
