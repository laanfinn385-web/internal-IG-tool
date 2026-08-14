// Populated from the server (Settings page) so templates are editable
// without a code change. {naam}, {views}, {months} are placeholders.
let TEMPLATES = {};
// LinkedIn has exactly one template (no stats-based suggestion — see
// suggestTemplate below, which only makes sense for Instagram's
// posts/week+views data). Kept in a separate object rather than merged into
// TEMPLATES so Instagram's dropdown/suggestion code never sees it.
let TEMPLATES_LINKEDIN = {};

function renderTemplateString(str, placeholders) {
  return String(str || '')
    .replace(/\{naam\}/g, placeholders.naam ?? '')
    .replace(/\{views\}/g, placeholders.views ?? '')
    .replace(/\{months\}/g, placeholders.months ?? '');
}

const MESSAGE_SLOTS = ['opener', 'hook', 'value', 'cta'];

async function loadTemplatesFromServer(platform = 'instagram') {
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
    if (platform === 'linkedin') TEMPLATES_LINKEDIN = map;
    else TEMPLATES = map;
  } catch (e) {
    console.error(`Could not load ${platform} message templates`, e);
  }
}

// Rule-based suggestion. Stats-based cases (5, 4, 2) are fairly reliable;
// cases 1, 3, 6 depend on subjective content-quality judgment the tool can't
// see, so they're best-guess defaults — always double-check before sending.
function suggestTemplate({ lastPostWeeks, postsPerWeek, avgViews, viewsThreshold }) {
  const lw = Number(lastPostWeeks);
  const ppw = Number(postsPerWeek);
  const views = avgViews === '' || avgViews === null || avgViews === undefined ? null : Number(avgViews);

  if (!isNaN(lw) && lw >= 8) {
    const months = Math.max(1, Math.round(lw / 4.345));
    return { key: 'lang_geen_content', months, reason: `Last post was ${lw} weeks (~${months} mo) ago.` };
  }
  if (!isNaN(ppw) && ppw > 0 && ppw < 1) {
    return { key: 'inconsistent_posten', reason: `Posting frequency is low (${ppw}x per week) with probable gaps.` };
  }
  if (views !== null && viewsThreshold && views < viewsThreshold) {
    return { key: 'vastzit_onder_x', reason: `Average views (${views}) is below your threshold of ${viewsThreshold}.` };
  }
  if (!isNaN(ppw) && ppw >= 1 && ppw < 3) {
    return { key: 'inconsistent_waarde', reason: `Posting frequency (${ppw}x/week) is decent but not very consistent.` };
  }
  if (!isNaN(ppw) && ppw >= 3) {
    return { key: 'veel_tijd_content', reason: `Posts often (${ppw}x/week) — probably takes up a lot of time. Check yourself whether template 1 fits better.` };
  }
  return { key: 'geen_unieke_kennis', reason: 'No clear statistical signal — default suggestion, use your own judgment.' };
}
