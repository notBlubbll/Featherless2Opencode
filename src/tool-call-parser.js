// Tool-call fallback parser — detects text-emitted tool calls and converts to OpenAI format
// Ported from @voidrot/openai-featherless-compatible (MIT)

const MISTRAL_MARKER = '[TOOL_CALLS]';
const MINIMAX_OPEN = '<minimax:tool_call>';
const MINIMAX_CLOSE = '</minimax:tool_call>';
const DSML_OPEN = '<dsml:tool_call>';
const DSML_CLOSE = '</dsml:tool_call>';
const DSML_ALT_OPEN = '<｜｜DSML｜｜tool_calls>';
const DSML_ALT_CLOSE = '