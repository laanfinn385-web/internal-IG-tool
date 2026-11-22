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

  'We couldn’t find that portal.': 'We konden dat portaal niet vinden.',
  'Double-check the link you were sent, or ask your A&P Media contact to resend it.': 'Controleer de link die je hebt gekregen, of vraag je contactpersoon bij A&P Media om hem opnieuw te sturen.',

  // ---- Scripting hub ----
  'Your scripts, lined up.': 'Je scripts, op een rij.',
  'We’ve picked the topics and hooks. Work through them one by one — every script you finish gets ticked off.': 'We hebben de onderwerpen en hooks al voor je gekozen. Werk ze één voor één af — elk script dat je afrondt wordt afgevinkt.',
  'To script': 'Te scripten',
  'Up next': 'Volgende', 'Select all': 'Alles selecteren', 'Clear selection': 'Selectie wissen',
  'About 10 minutes.': 'Ongeveer 10 minuten.',
  'Want to do several in one go? Tick them below.': 'Wil je er meteen meerdere doen? Vink ze hieronder aan.',
  'Done': 'Klaar', 'Ticked off': 'Afgevinkt',
  'See where every script stands — from first draft to posted.': 'Zie precies waar elk script staat — van eerste opzet tot gepost.',
  'Your content plan, topics and posts — all in one place.': 'Jouw contentplan, onderwerpen en posts — allemaal op één plek.',
  'Every script’s written. New topics show up here as soon as we add them.': 'Alles is gescript. Nieuwe onderwerpen verschijnen hier zodra we ze toevoegen.',

  // ---- Script session wizard ----
  'Quit session': 'Sessie afsluiten', 'Sound on': 'Geluid aan', 'Sound off': 'Geluid uit',
  'Brain dump': 'Brainstorm', 'Format': 'Format', 'Script': 'Script', 'Trim': 'Bijschaven', 'Read aloud': 'Hardop lezen',
  'Get it all out.': 'Gooi het er allemaal uit.',
  'Write everything that comes to mind when you read your topic. Don’t edit — just dump. You have three minutes.': 'Schrijf alles op wat in je opkomt bij dit onderwerp. Niet bewerken — gewoon eruit gooien. Je hebt drie minuten.',
  'Pick your format.': 'Kies je format.',
  'Choose how you’ll tell it. Start typing to find a format faster.': 'Kies hoe je het vertelt. Begin te typen om sneller een format te vinden.',
  'Shape it into a script.': 'Maak er een script van.',
  'We’ve picked the format for this one — its structure is filled in below. Rewrite it line by line, using your brain dump above.': 'We hebben het format al voor je gekozen — de structuur staat hieronder al ingevuld. Herschrijf het regel voor regel, met je brainstorm hierboven als basis.',
  'Trim it down.': 'Schaaf het bij.',
  'Anything you don’t mark stays. Mark words yellow if they could go, red if they add nothing. Click a line number to mark the whole line at once.': 'Alles wat je niet markeert blijft staan. Markeer woorden geel als ze kunnen weg, rood als ze niets toevoegen. Klik op een regelnummer om de hele regel in één keer te markeren.',
  'Read it aloud.': 'Lees het hardop.',
  'Read your script out loud, start to finish, and time yourself. If something sounds off, it is.': 'Lees je script helemaal hardop voor en neem de tijd op. Klinkt iets niet lekker? Dan klopt het ook niet.',
  'The timer starts when you begin typing.': 'De timer start zodra je begint te typen.',
  'Time’s up. Keep going if there’s more — or move on.': 'Tijd is om. Ga door als er meer is — of ga verder.',
  'Keep writing. Don’t stop to edit.': 'Blijf schrijven. Stop niet om te bewerken.',
  'Start timer': 'Timer starten', 'Reset timer': 'Timer resetten',
  'Search formats — e.g. “this vs that”': 'Zoek formats — bv. “dit vs dat”',
  'No format matches that.': 'Geen format gevonden.',
  'Your brain dump': 'Jouw brainstorm', 'Your script': 'Jouw script',
  'One beat per line. Replace the guide text with your own words.': 'Eén onderdeel per regel. Vervang de voorbeeldtekst door je eigen woorden.',
  'Marking with': 'Markeren met', 'Yellow': 'Geel', 'Red': 'Rood', 'Erase': 'Wissen',
  'Adds a touch. You could cut it without breaking the script.': 'Voegt net iets toe. Je zou het kunnen schrappen zonder het script te breken.',
  'Adds nothing. It gets deleted automatically when you move on.': 'Voegt niets toe. Wordt automatisch verwijderd zodra je verdergaat.',
  'Anything marked red is deleted automatically when you move on.': 'Alles dat rood is gemarkeerd wordt automatisch verwijderd zodra je verdergaat.',
  'Pause': 'Pauzeren', 'Resume': 'Doorgaan', 'Start reading': 'Beginnen met lezen', 'Reset': 'Resetten',
  'Copy script': 'Script kopiëren', 'Copied ✓': 'Gekopieerd ✓',
  'Google Doc': 'Google Doc',
  'Make your final changes there.': 'Maak daar je laatste aanpassingen.',
  'Paste it into the new Doc and tweak anything that sounded off when reading aloud and make the final finishing touches.': 'Plak het in het nieuwe Doc, pas aan wat niet lekker klonk tijdens het hardop lezen, en geef het de laatste finishing touch.',
  'Make the Google Doc ↗': 'Maak het Google Doc ↗',
  'Upload to Drive': 'Upload naar Drive',
  'Finish your edits in the Google Doc and give it your topic as its title.': 'Maak je bewerkingen af in het Google Doc en geef het je onderwerp als titel.',
  'In the Doc, click the folder icon next to the title.': 'Klik in het Doc op het mapicoon naast de titel.',
  'Choose “Shared with me” → “A&P — Scripts” and click Move. That’s it — we’ll see it straight away.': 'Kies “Met mij gedeeld” → “A&P — Scripts” en klik op Verplaatsen. Dat is alles — we zien het meteen.',
  'Open our Drive folder ↗': 'Open onze Drive-map ↗',
  'Finish': 'Afronden',
  'Well done.': 'Goed gedaan.',
  'Time to write': 'Tijd om te schrijven', 'Words in your script': 'Woorden in je script',
  'Read-aloud time': 'Hardop-leestijd', 'Words cut': 'Geschrapte woorden',
  'Move post on to next stage in Rella': 'Zet de post door naar de volgende fase in Rella',
  'Moved to the next stage in Rella ✓': 'Doorgezet naar de volgende fase in Rella ✓',
  'Move the post in Rella first.': 'Zet de post eerst door in Rella.',
  'Ticked off in your script list.': 'Afgevinkt in je scriptlijst.'
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
