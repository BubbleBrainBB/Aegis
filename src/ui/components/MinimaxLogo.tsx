import minimaxLogoUrl from '../assets/minimax-color.svg';

export function MinimaxLogo({ className = 'h-4 w-4' }: { className?: string }) {
  return <img src={minimaxLogoUrl} alt="" className={`${className} flex-shrink-0`} aria-hidden="true" />;
}
