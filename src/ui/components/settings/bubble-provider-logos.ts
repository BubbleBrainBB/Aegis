import claudeLogo from '../../assets/claude-color.svg';
import openaiLogo from '../../assets/openai.svg';
import moonshotLogo from '../../assets/moonshot.svg';
import grokLogo from '../../assets/grok.svg';
import deepseekLogo from '../../assets/deepseek-color.svg';
import minimaxLogo from '../../assets/minimax-color.svg';
import zhipuLogo from '../../assets/zhipu-color.svg';
import alibabaLogo from '../../assets/alibaba-color.svg';
import bailianLogo from '../../assets/bailian-color.svg';
import fireworksLogo from '../../assets/fireworks-color.svg';
import geminiLogo from '../../assets/gemini-color.svg';
import volcengineLogo from '../../assets/volcengine-color.svg';
import stepfunLogo from '../../assets/stepfun.svg';

// Brand artwork already bundled for other pickers, keyed by Bubble provider id.
// Providers without artwork fall back to a monogram tile in BubbleProviderLogo
// (Settings > Providers) and to the model's own mark or a dot in Settings > Usage.
export const BUBBLE_PROVIDER_LOGOS: Record<string, string> = {
  anthropic: claudeLogo,
  openai: openaiLogo,
  grok: grokLogo,
  deepseek: deepseekLogo,
  minimax: minimaxLogo,
  'minimax-anthropic': minimaxLogo,
  zhipuai: zhipuLogo,
  'zhipuai-coding-plan': zhipuLogo,
  zai: zhipuLogo,
  'zai-coding-plan': zhipuLogo,
  alibaba: alibabaLogo,
  'bailian-token-plan': bailianLogo,
  fireworks: fireworksLogo,
  google: geminiLogo,
  doubao: volcengineLogo,
  stepfun: stepfunLogo,
  'moonshot-cn': moonshotLogo,
  'moonshot-intl': moonshotLogo,
  'kimi-for-coding': moonshotLogo,
};

/** One-color marks: these follow the theme (`provider-monochrome-logo`). */
export const MONOCHROME_BUBBLE_PROVIDER_LOGOS: readonly string[] = [claudeLogo, openaiLogo, grokLogo, moonshotLogo, stepfunLogo];
