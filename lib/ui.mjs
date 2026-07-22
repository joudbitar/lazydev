// Terminal styling for the CLI banner — zero deps, and silent degradation.
//
// ANSI styles apply only when stdout is an interactive terminal, NO_COLOR is
// unset/empty (https://no-color.org: a non-empty value disables color), and
// TERM is not "dumb". Piped output gets the plain text, so `lazydev | pbcopy`
// never captures escape codes.
//
// One accent color (cyan) for the tool name, bold for the things worth
// copying (URLs), dim for everything explanatory. Red is reserved for errors.

export function makeStyler({ isTTY, env = {} } = {}) {
  const enabled =
    Boolean(isTTY) &&
    !(typeof env.NO_COLOR === 'string' && env.NO_COLOR !== '') &&
    env.TERM !== 'dumb';
  const wrap = (open, close) => (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
  return {
    enabled,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    cyan: wrap(36, 39),
    green: wrap(32, 39),
    red: wrap(31, 39),
  };
}
