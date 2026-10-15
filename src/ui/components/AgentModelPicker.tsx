import type { AgentProvider } from '../types';
import claudeLogo from '../assets/claude-color.svg';
import moonshotLogo from '../assets/moonshot.svg';
import grokLogo from '../assets/grok.svg';
import openaiLogo from '../assets/openai.svg';
import { OpenCodeLogo } from './OpenCodeLogo';
import { PiLogo } from './PiLogo';
import { BubbleLogo } from './BubbleLogo';
import { QoderLogo } from './QoderLogo';
import { DeepseekLogo } from './DeepseekLogo';
import { DevinLogo } from './DevinLogo';
import { MimoLogo } from './MimoLogo';

export function ProviderIcon({ provider }: { provider: AgentProvider }) {
  if (provider === 'claude') {
    return <img src={claudeLogo} alt="" className="h-4 w-4 flex-shrink-0" aria-hidden="true" />;
  }

  if (provider === 'codex') {
    return <img src={openaiLogo} alt="" className="h-4 w-4 flex-shrink-0" aria-hidden="true" />;
  }

  if (provider === 'opencode') {
    return <OpenCodeLogo />;
  }

  if (provider === 'kimi') {
    return <img src={moonshotLogo} alt="" className="h-4 w-4 flex-shrink-0" aria-hidden="true" />;
  }
  if (provider === 'grok') {
    return <img src={grokLogo} alt="" className="h-4 w-4 flex-shrink-0" aria-hidden="true" />;
  }
  if (provider === 'pi') {
    return <PiLogo />;
  }
  if (provider === 'bubble') {
    return <BubbleLogo />;
  }
  if (provider === 'qoder') {
    return <QoderLogo />;
  }
  if (provider === 'deepseek') {
    return <DeepseekLogo />;
  }
  if (provider === 'devin') {
    return <DevinLogo />;
  }
  if (provider === 'mimo') {
    return <MimoLogo />;
  }

  return null;
}
