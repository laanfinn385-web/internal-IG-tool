// The 6 outreach templates. {naam}, {views}, {months} are placeholders.
const TEMPLATES = {
  geen_unieke_kennis: {
    label: '1. Geen unieke kennis delen',
    text: ({ naam }) =>
      `Hey ${naam}, ik wil even zeggen dat ik denk dat je echt veel unieke kennis in huis hebt als fitness coach, alleen jammer genoeg zie ik dat nog niet echt terug op je feed. Jammer, want daar haal je juist de meeste klanten uit. Wil je even deze video van 14 seconden kijken?`
  },
  vastzit_onder_x: {
    label: '2. Vastzit onder X weergaven',
    text: ({ naam, views }) =>
      `Hey ${naam}, ben even door je profiel gelopen en zag dat je nog vastzit onder de ${views} weergaven. Wat jammer is want ik vind dat je wel een tof verhaal hebt. Zie het super vaak terugkomen - wil je even deze video kijken? Hij is maar 14 seconden lang.`
  },
  inconsistent_waarde: {
    label: '3. Inconsistent waarde content plaatst',
    text: ({ naam }) =>
      `Hey ${naam}, wilde even zeggen dat je echt een tof verhaal hebt. Wat me wel opviel is dat je veel unieke waarde in huis hebt, maar dat het nu nog niet helemaal van je pagina afspat (waarschijnlijk omdat het scripten en editen je nu simpelweg te veel tijd kost). Misschien kan ik je helpen, wil je even deze video kijken? Hij is maar 14 seconden lang.`
  },
  inconsistent_posten: {
    label: '4. Inconsistent content plaatst',
    text: ({ naam }) =>
      `Hey ${naam}, wilde even zeggen dat je echt toffe content plaatst en dat je echt unieke waarde deelt als fitness coach, alleen het valt me jammer genoeg op dat het posten nu nog een beetje inconsistent is. Super logisch ook, want elke week urenlang researchen en editen naast je lopende coaching is bijna niet te doen. Alleen zonde, want door die gaten in je planning mis je simpelweg een hoop klanten. Ik heb hier misschien een oplossing voor, wil je even deze video kijken van 14 seconden?`
  },
  lang_geen_content: {
    label: '5. Lang geen content geplaatst',
    text: ({ naam, months }) =>
      `Hey ${naam}, het valt me op dat je al een tijdje geen content hebt geplaatst, de laatste keer was zelfs ${months} maanden geleden. Waarschijnlijk kostte het content maken je veel tijd, of wist je niet wat te doen en vond je het moeilijk om op ideeën te komen. Wat jammer is want ik vind dat je wel een tof verhaal hebt. Als je ooit nog interesse hebt om het content plaatsen weer een beetje op te pakken wil je dan even deze video kijken? Hij is maar 14 seconden lang.`
  },
  veel_tijd_content: {
    label: '6. Veel tijd besteden aan content',
    text: ({ naam }) =>
      `Hey ${naam}, echt super toffe content die je post en ik vind dat je echt een tof verhaal hebt. Alleen zou het kunnen dat je nu nogal veel tijd besteed aan content plannen, researchen, scripten en editen. Als dat zo is, is mijn enige vraag dat je even deze video kijkt, hij is maar 14 seconden lang.`
  }
};

// Rule-based suggestion. Stats-based cases (5, 4, 2) are fairly reliable;
// cases 1, 3, 6 depend on subjective content-quality judgment the tool can't
// see, so they're best-guess defaults — always double-check before sending.
function suggestTemplate({ lastPostWeeks, postsPerWeek, avgViews, viewsThreshold }) {
  const lw = Number(lastPostWeeks);
  const ppw = Number(postsPerWeek);
  const views = avgViews === '' || avgViews === null || avgViews === undefined ? null : Number(avgViews);

  if (!isNaN(lw) && lw >= 8) {
    const months = Math.max(1, Math.round(lw / 4.345));
    return { key: 'lang_geen_content', months, reason: `Laatste post was ${lw} weken (~${months} mnd) geleden.` };
  }
  if (!isNaN(ppw) && ppw > 0 && ppw < 1) {
    return { key: 'inconsistent_posten', reason: `Postfrequentie is laag (${ppw}x per week) met waarschijnlijk gaten.` };
  }
  if (views !== null && viewsThreshold && views < viewsThreshold) {
    return { key: 'vastzit_onder_x', reason: `Gemiddelde weergaven (${views}) zit onder je drempel van ${viewsThreshold}.` };
  }
  if (!isNaN(ppw) && ppw >= 1 && ppw < 3) {
    return { key: 'inconsistent_waarde', reason: `Postfrequentie (${ppw}x/week) is redelijk maar niet super consistent.` };
  }
  if (!isNaN(ppw) && ppw >= 3) {
    return { key: 'veel_tijd_content', reason: `Post vaak (${ppw}x/week) — waarschijnlijk kost dit veel tijd. Check zelf of template 1 beter past.` };
  }
  return { key: 'geen_unieke_kennis', reason: 'Geen duidelijk statistisch signaal — standaard suggestie, gebruik je eigen inschatting.' };
}
