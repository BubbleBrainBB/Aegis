import claudeLogo from '../assets/claude-color.svg';
import grokLogo from '../assets/grok.svg';
import moonshotLogo from '../assets/moonshot.svg';
import openaiLogo from '../assets/openai.svg';
import piLogo from '../assets/pi-logo-auto.svg';
import bubbleLogo from '../assets/bubble-logo-auto.svg';
import qoderLogo from '../assets/qoder.svg';
import devinLogo from '../assets/devin-color.svg';
import { OpenCodeLogo } from './OpenCodeLogo';
import { DeepseekLogo } from './DeepseekLogo';
import { MimoLogo } from './MimoLogo';
import type { AgentProvider } from '../types';

const PROVIDER_LOGO_SRC: Record<Exclude<AgentProvider, 'opencode' | 'deepseek' | 'mimo' | 'bubble'>, string> = {
  claude: claudeLogo,
  codex: openaiLogo,
  kimi: moonshotLogo,
  grok: grokLogo,
  pi: piLogo,
  qoder: qoderLogo,
  devin: devinLogo,
};

// Black single-colour marks; the host surface inverts `.provider-monochrome-logo` in dark mode.
const MONOCHROME_PROVIDERS = new Set<AgentProvider>(['claude', 'codex', 'grok', 'kimi']);

/** Bare agent mark (no avatar tile), sized by the caller. */
export function AgentProviderLogo({ provider, className }: { provider: AgentProvider; className: string }) {
  switch (provider) {
    case 'opencode':
      return <OpenCodeLogo className={className} />;
    case 'deepseek':
      return <DeepseekLogo className={className} />;
    case 'mimo':
      return <MimoLogo className={className} />;
    case 'bubble':
      // The SVG themes itself by the OS colour scheme, not the app theme, so
      // paint it as a mask in currentColor instead.
      return (
        <span
          className={`${className} inline-block flex-shrink-0 bg-current text-[var(--text-primary)]`}
          style={{ WebkitMaskImage: `url("${bubbleLogo}")`, maskImage: `url("${bubbleLogo}")`, WebkitMaskSize: 'contain', maskSize: 'contain', WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat' }}
          aria-hidden="true"
        />
      );
    default:
      return (
        <img
          src={PROVIDER_LOGO_SRC[provider]}
          alt=""
          className={`${className} ${MONOCHROME_PROVIDERS.has(provider) ? 'provider-monochrome-logo' : ''}`}
          aria-hidden="true"
        />
      );
  }
}
