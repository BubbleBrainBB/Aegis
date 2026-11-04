import type { AgentProvider } from '../types';
import claudeLogo from '../assets/claude-color.svg';
import moonshotLogo from '../assets/moonshot.svg';
import grokLogo from '../assets/grok.svg';
import openaiLogo from '../assets/openai.svg';
import { MonochromeLogo } from './MonochromeLogo';
import { OpenCodeLogo } from './OpenCodeLogo';
import { PiLogo } from './PiLogo';
import { BubbleLogo } from './BubbleLogo';
import { QoderLogo } from './QoderLogo';
import { DeepseekLogo } from './DeepseekLogo';
import { DevinLogo } from './DevinLogo';
import { MimoLogo } from './MimoLogo';
import { MinimaxLogo } from './MinimaxLogo';

export function ProviderIcon({ provider }: { provider: AgentProvider }) {
  if (provider === 'claude') {
    return <MonochromeLogo src={claudeLogo} />;
  }

  if (provider === 'codex') {
    return <MonochromeLogo src={openaiLogo} />;
  }

  if (provider === 'opencode') {
    return <OpenCodeLogo />;
  }

  if (provider === 'kimi') {
    return <MonochromeLogo src={moonshotLogo} />;
  }
  if (provider === 'grok') {
    return <MonochromeLogo src={grokLogo} />;
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
  if (provider === 'minimax') {
    return <MinimaxLogo />;
  }

  return null;
}
