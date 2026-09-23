// TEMPLATES_LINKEDIN: LinkedIn's own fixed template, populated from the
// server so it's editable without a code change. {naam}, {views}, {months}
// are placeholders. Instagram used to have an equivalent 6-category
// stats-suggested TEMPLATES object here (plus a suggestTemplate() rule
// engine) — replaced by the one-message-per-Messaging-sequence first-message
// block (see app.js updateMessage()), so only LinkedIn still goes through
// this category system.
let TEMPLATES_LINKEDIN = {};

function renderTemplateString(str, placeholders) {
  return String(str || '')
    .replace(/\{naam\}/g, placeholders.naam ?? '')
    .replace(/\{views\}/g, placeholders.views ?? '')
    .replace(/\{months\}/g, placeholders.months ?? '');
}

// Spintax: {option1|option2|option3} picks one option at random. Requires a
// '|' inside the braces so {naam}/{views}/{months} (no pipe) are never
// mistaken for a one-option spintax group — but an option is itself allowed
// to contain one of those placeholders (e.g. "{Hoi {naam}!|Hey {naam}!}"),
// since PLACEHOLDER matches that specific no-pipe shape without swallowing
// the outer group's own braces. Resolves innermost groups first (a group's
// own contents can't contain any OTHER brace, by construction of the
// regex), so repeating the replace naturally handles nesting like
// "{Hey|Hi} {naam}, {have you seen|did you catch} my video?" from the
// inside out. Capped at 100 passes so a malformed/pathological input (an
// unmatched brace, say) can never hang the render loop.
function resolveSpintax(str) {
  let result = String(str || '');
  const PLACEHOLDER = '\\{[a-zA-Z0-9_]+\\}';
  const OPTION = `(?:[^{}|]|${PLACEHOLDER})*`;
  const groupPattern = new RegExp(`\\{(${OPTION}\\|${OPTION}(?:\\|${OPTION})*)\\}`);
  let match;
  let guard = 0;
  while ((match = groupPattern.exec(result)) && guard < 100) {
    const options = match[1].split('|');
    const choice = options[Math.floor(Math.random() * options.length)];
    result = result.slice(0, match.index) + choice + result.slice(match.index + match[0].length);
    guard++;
  }
  return result;
}

const MESSAGE_SLOTS = ['opener', 'hook', 'value', 'cta'];

async function loadTemplatesFromServer(platform = 'linkedin') {
  try {
    // fetchJson (app.js) times out instead of hanging forever — this call
    // is awaited during app init, so an unprotected stalled request here
    // would leave the whole app stuck on a blank shell with no fallback.
    const data = await fetchJson(`/api/settings/templates?platform=${platform}`, undefined, 10000);
    const map = {};
    (data.templates || []).forEach(t => {
      // Each category is built from 4 sentence slots (opener/hook/value/cta),
      // each with several independently-worded versions specific to that
      // category. app.js's pickPart() draws one version per slot at random and
      // joins them, so recombination alone makes repeats far less likely than
      // picking among whole pre-written messages — see pickPart() in app.js.
      const parts = {};
      MESSAGE_SLOTS.forEach(slot => {
        parts[slot] = ((t.parts && t.parts[slot]) || []).map(p => ({
          id: p.id,
          render: (placeholders) => renderTemplateString(p.text, placeholders)
        }));
      });
      map[t.id] = { label: t.label, parts };
    });
    TEMPLATES_LINKEDIN = map;
  } catch (e) {
    console.error(`Could not load ${platform} message templates`, e);
  }
}
