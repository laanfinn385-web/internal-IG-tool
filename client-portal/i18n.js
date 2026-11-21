// Real i18n for the client-facing portal — a plain t(key) lookup, not the
// prototype's own live-DOM-text-walking hack (portal-nl.js, in "Outreach
// Tool redesign prototype/"). Keys are the exact English string shown on
// screen (same convention as that file), so a key doubles as its own
// English fallback: t() just returns the key unchanged whenever the
// current language is English or a translation is missing. Dutch copy
// below is taken verbatim from portal-nl.js wherever this build's text
// matches it exactly; the handful of places this build's copy differs
// (a reworded line, or a label that file never covered) are translated
// directly here instead.
const I18N_NL = {
  'Good morning': 'Goedemorgen', 'Good afternoon': 'Goedemiddag', 'Good evening': 'Goedenavond',
  'Client since': 'Klant sinds',
  "Everything is on track. Here's what we've been working on.": 'Alles loopt volgens plan. Hier is waar we aan hebben gewerkt.',

  'Studio': 'Studio',
  'Home': 'Home', 'Scripting': 'Scripts', 'Outreach': 'Outreach',
  'Content in Rella': 'Content in Rella', 'Landing page': 'Landingspagina',
  'Questions?': 'Vragen?',
  'Message me directly, I usually reply within a working day.': 'Stuur me direct een bericht, ik reageer meestal binnen een werkdag.',
  'Send a message': 'Stuur een bericht',

  'Milestones': 'Mijlpalen',
  'How it’s going': 'Hoe het gaat',
  'Week': 'Week', 'Month': 'Maand', 'All time': 'Alles',
  'See full statistics →': 'Bekijk alle statistieken →',
  'Content': 'Content', 'Open Rella': 'Open Rella',
  'Every script, shoot and post — tracked in one place.': 'Elk script, elke shoot en elke post — op één plek bijgehouden.',
  'View your landing page': 'Bekijk je landingspagina',
  'Every intake from outreach lands here first.': 'Elke intake uit outreach komt hier als eerste binnen.',

  'All systems running': 'Alles draait',
  'Needs your input': 'Heeft jouw input nodig',
  'Paused': 'Gepauzeerd',

  'Reach-outs': 'Benaderd', 'People we messaged for you': 'Mensen die we voor je hebben benaderd',
  'Conversations': 'Gesprekken', 'People who replied and are talking': 'Mensen die reageerden en in gesprek zijn',
  'Intakes booked': 'Intakes geboekt', 'Calls on your calendar': 'Calls in je agenda',
  'vs last week': 't.o.v. vorige week', 'vs last month': 't.o.v. vorige maand', 'since the start': 'sinds de start',

  'How your outreach is going.': 'Hoe je outreach gaat.',
  'Every day we message people who match your ideal client. Here’s what came of it.': 'Elke dag sturen we berichten naar mensen die passen bij je ideale klant. Dit is wat het opleverde.',
  'How your outreach works': 'Hoe je outreach werkt',
  'Walkthrough video — coming soon': 'Uitlegvideo — binnenkort',
  'From message to call': 'Van bericht naar call',
  'We’ll see conversion rates once sends start.': 'Zodra we berichten versturen, zie je hier de conversie.',
  'Who we reached out to': 'Wie we hebben benaderd',
  'Search handles': 'Zoek accounts',
  'Everyone': 'Iedereen', 'Messaged': 'Benaderd', 'In conversation': 'In gesprek', 'Call booked': 'Call geboekt',
  'No handles match that.': 'Geen accounts gevonden.',
  'Show more': 'Meer tonen',
  'Total leads': 'Totaal leads', 'people on your list': 'mensen op je lijst',
  'Reached out': 'Benaderd', 'Still to come': 'Nog te gaan',
  'Not enough sends yet to estimate a pace.': 'Nog niet genoeg verstuurd om een tempo in te schatten.',
  'Based on your all-time conversion rates. The more we learn, the sharper this gets.': 'Gebaseerd op je conversie sinds de start. Hoe meer we leren, hoe scherper dit wordt.',
  'Calls booked': 'Calls geboekt', 'People reached out to': 'Mensen benaderd',
  'People we sent a first message to': 'Mensen die een eerste bericht kregen',
  'Started a conversation': 'Gesprek gestart',
  'Replied and are talking with us': 'Reageerden en zijn met ons in gesprek',
  'Booked a call': 'Call geboekt',
  'replied': 'reageerde', 'booked': 'geboekt',
  'Leads still to come': 'Leads nog te gaan',
  'Expected conversations': 'Verwachte gesprekken', 'Expected calls': 'Verwachte calls',
  'This week': 'Deze week', 'This month': 'Deze maand', 'Since the start': 'Sinds de start',
  'this week': 'deze week', 'this month': 'deze maand', 'since the start': 'sinds de start',

  'Designed next.': 'Volgt binnenkort.', '← Home': '← Home',

  'We couldn’t find that portal.': 'We konden dat portaal niet vinden.',
  'Double-check the link you were sent, or ask your A&P Media contact to resend it.': 'Controleer de link die je hebt gekregen, of vraag je contactpersoon bij A&P Media om hem opnieuw te sturen.'
};

function t(key) {
  if (state.lang !== 'nl') return key;
  return I18N_NL[key] !== undefined ? I18N_NL[key] : key;
}

// Every date throughout the app goes through this (not a hand-written
// day/month dictionary) — the browser's own Intl formatting already
// knows Dutch day/month names correctly for the 'nl-NL' locale.
function dateLocale() {
  return state.lang === 'nl' ? 'nl-NL' : 'en-GB';
}

// Sweeps every element carrying data-i18n (the page's static copy — nav
// labels, card headers, etc., none of which app.js's own render
// functions ever touch) and sets its text from the dictionary. Run once
// after state.lang is known, before the first render.
function applyStaticI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
}
